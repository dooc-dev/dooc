import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { devNull, tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
    type DownloadProgress,
    setDownloadProgressListener,
} from "../../engine/src/compiler/download-progress.js";
import { prepareGitWorkspace } from "./git-workspace.js";

const roots: string[] = [];
const servers: Server[] = [];
const temporary = () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-git-workspace-test-"));
    roots.push(root);
    return root;
};
const command = (root: string, ...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" },
    });
const fixture = async (configure?: (source: string) => void) => {
    const root = temporary();
    const data = join(root, "data");
    mkdirSync(data);
    vi.stubEnv("XDG_DATA_HOME", data);
    const source = join(root, "source");
    mkdirSync(source);
    command(source, "init", "--initial-branch=trunk");
    command(source, "config", "user.name", "Test");
    command(source, "config", "user.email", "test@example.invalid");
    command(source, "config", "core.hooksPath", devNull);
    command(source, "config", "commit.gpgsign", "false");
    mkdirSync(join(source, "docs"));
    mkdirSync(join(source, ".dooc/plugins"), { recursive: true });
    writeFileSync(join(source, "dooc.yaml"), "docs: []\n");
    writeFileSync(join(source, "docs/dooc.yaml"), "docs: []\n");
    writeFileSync(join(source, "docs/team.dooc.yaml"), "docs: []\n");
    writeFileSync(join(source, "docs/notes.md"), "Original\n");
    writeFileSync(join(source, "docs.config.mjs"), "throw new Error('Do not execute');\n");
    writeFileSync(join(source, ".dooc/plugins/code.js"), "throw new Error('Do not execute');\n");
    configure?.(source);
    command(source, "add", ".");
    command(source, "commit", "-m", "Initial");
    writeFileSync(join(source, "history.txt"), "Second commit\n");
    command(source, "add", ".");
    command(source, "commit", "-m", "Second");
    command(source, "branch", "feature/docs");
    const bare = join(root, "repository.git");
    command(root, "clone", "--bare", "--no-hardlinks", source, bare);
    command(bare, "update-server-info");
    let requests = 0;
    let block = false;
    let release: (() => void) | undefined;
    const server = createServer((request, response) => {
        requests++;
        const send = () => {
            const path = resolve(
                root,
                `.${new URL(request.url ?? "/", "http://localhost").pathname}`,
            );
            if (
                !path.startsWith(`${bare}${sep}`) ||
                !statSync(path, { throwIfNoEntry: false })?.isFile()
            ) {
                response.writeHead(404).end("Not found");
                return;
            }
            response
                .writeHead(200, { "content-type": "application/octet-stream" })
                .end(readFileSync(path));
        };
        if (block) {
            block = false;
            release = send;
        } else send();
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    return {
        root,
        data,
        source,
        server,
        url: `http://127.0.0.1:${address.port}/repository.git`,
        requests: () => requests,
        block: () => {
            block = true;
        },
        blocked: () => Boolean(release),
        release: () => {
            release?.();
        },
        saved: () =>
            existsSync(join(data, "dooc/workspaces"))
                ? readdirSync(join(data, "dooc/workspaces"))
                : [],
    };
};

afterEach(async () => {
    setDownloadProgressListener();
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        if (server.listening) await new Promise<void>((done) => server.close(() => done()));
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("clones the default branch with full history and local tracking branches before exposing a view", async () => {
    const source = await fixture();
    const progress: DownloadProgress[] = [];
    setDownloadProgressListener((event) => progress.push(event));
    const workspace = await prepareGitWorkspace(source.url, "view", {
        path: "docs/team.dooc.yaml",
    });
    const repository = command(workspace.root, "rev-parse", "--show-toplevel").trim();
    roots.push(join(repository, ".."));
    expect(basename(repository)).toBe("repository");
    expect(workspace.manifest).toBe(join(repository, "docs/team.dooc.yaml"));
    expect(command(repository, "branch", "--show-current").trim()).toBe("trunk");
    expect(command(repository, "rev-list", "--count", "HEAD").trim()).toBe("2");
    expect(command(repository, "branch", "--format=%(refname:short)").trim().split("\n")).toEqual([
        "feature/docs",
        "trunk",
    ]);
    expect(command(repository, "config", "branch.feature/docs.merge").trim()).toBe(
        "refs/heads/feature/docs",
    );
    expect(command(repository, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(repository, "docs.config.mjs"), "utf8")).toContain("Do not execute");
    expect(existsSync(join(repository, ".dooc/plugins/code.js"))).toBe(true);
    expect(progress[0]).toMatchObject({ state: "start", detail: "Cloning repository" });
    expect(progress.at(-1)).toMatchObject({ state: "complete", detail: "Clone ready" });
    expect(progress.some((event) => event.state === "progress")).toBe(true);
    workspace.dispose();
    expect(existsSync(repository)).toBe(false);
});

it("reuses one persistent clone across selected paths and offline opens without changing drafts or branch", async () => {
    const source = await fixture();
    const first = await prepareGitWorkspace(source.url, "edit", { path: "docs" });
    const repository = command(first.root, "rev-parse", "--show-toplevel").trim();
    writeFileSync(join(first.root, "notes.md"), "Local draft\n");
    command(repository, "switch", "-c", "local-work");
    first.dispose();
    const requests = source.requests();
    source.server.closeAllConnections();
    await new Promise<void>((done) => source.server.close(() => done()));
    const root = await prepareGitWorkspace(`${source.url}/`, "edit");
    const named = await prepareGitWorkspace(source.url, "edit", { path: "docs/team.dooc.yaml" });
    expect(root.root).toBe(repository);
    expect(root.reused).toBe(true);
    expect(named.root).toBe(first.root);
    expect(readFileSync(join(named.root, "notes.md"), "utf8")).toBe("Local draft\n");
    expect(command(repository, "branch", "--show-current").trim()).toBe("local-work");
    expect(source.requests()).toBe(requests);
    expect(source.saved()).toHaveLength(1);
    const concurrent = await Promise.all(
        Array.from({ length: 4 }, () => prepareGitWorkspace(source.url, "edit", { path: "docs" })),
    );
    expect(concurrent.every((workspace) => workspace.root === first.root && workspace.reused)).toBe(
        true,
    );
    rmSync(named.manifest);
    await expect(
        prepareGitWorkspace(source.url, "edit", { path: "docs/team.dooc.yaml" }),
    ).rejects.toThrow("No dooc manifest");
    expect(readFileSync(join(named.root, "notes.md"), "utf8")).toBe("Local draft\n");
});

it("does not overwrite edits when another opener finishes the same clone first", async () => {
    const source = await fixture();
    source.block();
    const first = prepareGitWorkspace(source.url, "edit");
    await vi.waitFor(() => expect(source.blocked()).toBe(true));
    const second = await prepareGitWorkspace(source.url, "edit");
    writeFileSync(second.manifest, "docs: []\n# Local change\n");
    source.release();
    const reused = await first;
    expect(reused.root).toBe(second.root);
    expect(reused.reused).toBe(true);
    expect(readFileSync(reused.manifest, "utf8")).toContain("Local change");
    expect(source.saved()).toHaveLength(1);
});

it("retains tracked config but disables global hooks, checkout filters and later Git filters", async () => {
    const source = await fixture((root) => {
        writeFileSync(join(root, ".gitattributes"), "*.md filter=unsafe\n");
    });
    const marker = join(source.root, "executed");
    const script = join(source.root, "unsafe.sh");
    writeFileSync(script, `#!/bin/sh\nprintf unsafe > '${marker}'\ncat\n`);
    chmodSync(script, 0o755);
    const hooks = join(source.root, "hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\nprintf hook > '${marker}'\n`);
    chmodSync(join(hooks, "post-checkout"), 0o755);
    const config = join(source.root, "global.gitconfig");
    const filters = join(source.root, "filters.gitconfig");
    writeFileSync(
        filters,
        `[filter "unsafe"]\n clean = ${script}\n smudge = ${script}\n required = true\n`,
    );
    writeFileSync(
        config,
        `[includeIf "gitdir:${source.data}/dooc/workspaces/git-*/"]\n path = ${filters}\n[core]\n hooksPath = ${hooks}\n fsmonitor = ${script}\n[user]\n name = Native identity\n`,
    );
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    const workspace = await prepareGitWorkspace(source.url, "edit");
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(workspace.root, "docs/notes.md"), "utf8")).toBe("Original\n");
    const native = (...args: string[]) =>
        execFileSync("git", ["-C", workspace.root, ...args], {
            env: process.env,
            encoding: "utf8",
        });
    expect(native("config", "user.name").trim()).toBe("Native identity");
    native("status", "--porcelain");
    native("switch", "feature/docs");
    writeFileSync(join(workspace.root, "docs/notes.md"), "Local draft\n");
    native("add", "docs/notes.md");
    expect(existsSync(marker)).toBe(false);
    native("config", "--local", "--unset", "filter.unsafe.clean");
    await prepareGitWorkspace(source.url, "edit");
    expect(native("config", "--get", "filter.unsafe.clean")).toBe("\n");
    expect(readFileSync(join(workspace.root, "docs/notes.md"), "utf8")).toBe("Local draft\n");
});

it("rejects missing manifests and symlinks outside the clone without leaving partial workspaces", async () => {
    const outside = temporary();
    writeFileSync(join(outside, "external.dooc.yaml"), "docs: []\n");
    const source = await fixture((root) => {
        symlinkSync(join(outside, "external.dooc.yaml"), join(root, "escape.dooc.yaml"));
    });
    await expect(prepareGitWorkspace(source.url, "edit", { path: "missing" })).rejects.toThrow(
        "No dooc manifest",
    );
    expect(source.saved()).toEqual([]);
    await expect(
        prepareGitWorkspace(source.url, "edit", { path: "escape.dooc.yaml" }),
    ).rejects.toThrow("inside the Git repository");
    expect(source.saved()).toEqual([]);
    expect(readFileSync(join(outside, "external.dooc.yaml"), "utf8")).toBe("docs: []\n");
});

it.each([
    "owner/repository",
    "--upload-pack=command",
    "file:///tmp/repository",
    "ext::command",
    "git://example.test/repository.git",
    "https://user:secret@example.test/repository.git",
    "https://example.test/repository.git?token=secret",
    "https://example.test/repository.git#secret",
    "ssh://git:secret@example.test/repository.git",
    "ssh://-option@example.test/repository.git",
    "ssh://-option/repository.git",
    "git@example.test:-option",
])("rejects invalid remote sources without invoking Git: %s", async (url) => {
    const data = temporary();
    vi.stubEnv("XDG_DATA_HOME", data);
    const events: DownloadProgress[] = [];
    setDownloadProgressListener((event) => events.push(event));
    await expect(prepareGitWorkspace(url, "edit")).rejects.toThrow("Use an HTTPS, HTTP, or SSH");
    expect(events).toEqual([]);
    expect(readdirSync(data)).toEqual([]);
});

it.each([
    "../outside",
    "/tmp/outside",
    "docs/../../outside",
    ".git/config",
    "docs\\file",
])("rejects escaping selected paths before cloning: %s", async (path) => {
    const data = temporary();
    vi.stubEnv("XDG_DATA_HOME", data);
    await expect(
        prepareGitWorkspace("https://example.test/repository.git", "edit", { path }),
    ).rejects.toThrow("inside the Git repository");
    expect(readdirSync(data)).toEqual([]);
});

it("reports failed clone progress and removes staging directories", async () => {
    const source = await fixture();
    const progress: DownloadProgress[] = [];
    setDownloadProgressListener((event) => progress.push(event));
    await expect(
        prepareGitWorkspace(source.url.replace("repository.git", "missing.git"), "edit"),
    ).rejects.toThrow("Failed to open Git workspace");
    expect(progress[0]?.state).toBe("start");
    expect(progress.at(-1)).toMatchObject({ state: "error", detail: "Clone failed" });
    expect(source.saved()).toEqual([]);
});

it.each([
    "SIGINT",
    "SIGTERM",
] as const)("cleans interrupted clones and terminates Git on %s without terminal UI", async (signal) => {
    const source = await fixture();
    source.block();
    const child = spawn(
        process.execPath,
        [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            `import { prepareGitWorkspace } from ${JSON.stringify(new URL("./git-workspace.ts", import.meta.url).href)}; await prepareGitWorkspace(${JSON.stringify(source.url)}, 'edit');`,
        ],
        { env: { ...process.env, XDG_DATA_HOME: source.data }, stdio: "pipe" },
    );
    const ended = once(child, "close");
    try {
        await vi.waitFor(() => expect(source.blocked()).toBe(true), { timeout: 5000 });
        child.kill(signal);
        expect((await ended)[0]).toBe(signal === "SIGINT" ? 130 : 143);
        expect(source.saved()).toEqual([]);
        await vi.waitFor(async () => {
            const count = await new Promise<number>((done, reject) =>
                source.server.getConnections((error, count) =>
                    error ? reject(error) : done(count),
                ),
            );
            expect(count).toBe(0);
        });
    } finally {
        child.kill("SIGKILL");
    }
}, 10_000);
