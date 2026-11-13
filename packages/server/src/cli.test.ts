import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminal } from "./terminal.js";

vi.mock("./terminal.js", () => ({
    terminal: { info: vi.fn(), download: vi.fn(), close: vi.fn() },
}));

const originalArgv = process.argv;
const roots: string[] = [];
afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.doUnmock("./serve.js");
    vi.doUnmock("./assets.js");
    vi.doUnmock("./build.js");
    vi.doUnmock("./mcp.js");
    vi.doUnmock("./self.js");
    vi.doUnmock("./git-workspace.js");
    vi.doUnmock("./static-client.js");
    vi.doUnmock("./workspace-server.js");
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const cli = (...args: string[]) => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DOOC_REMOTE_WORKSPACE", "");
    process.argv = [process.execPath, "cli.js", ...args];
    vi.spyOn(process, "cwd").mockReturnValue(roots.at(-1) ?? tmpdir());
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("CLI exit");
    });
    return { stdout, stderr, exit, run: () => import("./cli.js") };
};

describe("source-based CLI", () => {
    it("dispatches self update", async () => {
        const selfUpdate = vi.fn();
        vi.doMock("./self.js", () => ({ selfUpdate, prepareSelfDocs: vi.fn() }));
        await cli("self", "update").run();
        expect(selfUpdate).toHaveBeenCalledOnce();
    });

    it("waits for downloaded docs before opening an isolated read-only viewer", async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-self-"));
        roots.push(root);
        const dispose = vi.fn();
        let complete!: (docs: { root: string; dispose: () => void }) => void;
        const download = new Promise<{ root: string; dispose: () => void }>((resolve) => {
            complete = resolve;
        });
        const prepareSelfDocs = vi.fn(() => download);
        const startServer = vi.fn();
        vi.doMock("./self.js", () => ({ prepareSelfDocs, selfUpdate: vi.fn() }));
        vi.doMock("./serve.js", () => ({ startServer }));
        vi.stubEnv("DOCS_ROOT", "/other/project");
        vi.stubEnv("DOCS_HMR", "1");
        const once = vi.spyOn(process, "once").mockReturnValue(process);
        const result = cli("self", "docs");
        const pending = result.run();
        await vi.waitFor(() => expect(prepareSelfDocs).toHaveBeenCalledOnce());
        expect(terminal.info).toHaveBeenCalledWith("Downloading documentation from GitHub...");
        expect(startServer).not.toHaveBeenCalled();
        expect(process.env.DOCS_ROOT).toBe("/other/project");
        expect(process.env.DOCS_HMR).toBe("1");
        complete({ root, dispose });
        await pending;
        expect(process.env.DOCS_ROOT).toBe(root);
        expect(process.env.DOCS_HMR).toBe("0");
        expect(startServer).toHaveBeenCalledWith("preview", 5179, undefined, { open: true });
        expect(once).toHaveBeenCalledWith("exit", dispose);
        const cleanup = once.mock.calls.find(([event]) => event === "exit")?.[1];
        cleanup?.();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it("reports documentation download failures without starting a viewer", async () => {
        const message = "Failed to download documentation from GitHub: network unavailable";
        vi.doMock("./self.js", () => ({
            prepareSelfDocs: vi.fn().mockRejectedValue(new Error(message)),
            selfUpdate: vi.fn(),
        }));
        const startServer = vi.fn();
        vi.doMock("./serve.js", () => ({ startServer }));
        vi.stubEnv("DOCS_ROOT", "/other/project");
        vi.stubEnv("DOCS_HMR", "1");
        const result = cli("self", "docs");
        await expect(result.run()).rejects.toThrow("CLI exit");
        expect(result.stderr).toHaveBeenCalledWith(message);
        expect(result.exit).toHaveBeenCalledWith(1);
        expect(startServer).not.toHaveBeenCalled();
        expect(process.env.DOCS_ROOT).toBe("/other/project");
        expect(process.env.DOCS_HMR).toBe("1");
    });

    it.each([
        [],
        ["unknown"],
        ["update", "extra"],
        ["docs", "other/dooc.yaml"],
        ["docs", "--unknown"],
    ])("rejects invalid self arguments %j without side effects", async (...args) => {
        const selfUpdate = vi.fn();
        const prepareSelfDocs = vi.fn();
        vi.doMock("./self.js", () => ({ selfUpdate, prepareSelfDocs }));
        const result = cli("self", ...args);
        await expect(result.run()).rejects.toThrow("CLI exit");
        expect(selfUpdate).not.toHaveBeenCalled();
        expect(prepareSelfDocs).not.toHaveBeenCalled();
    });

    it.each([[], ["update"], ["docs"]])("shows self help for %j", async (...args) => {
        const result = cli("self", ...args, "--help");
        await result.run();
        expect(result.stdout).toHaveBeenCalledWith(expect.stringContaining("usage: dooc self"));
        const help = result.stdout.mock.calls[0]?.[0] as string;
        expect(help).toContain("download documentation from GitHub");
        expect(help).toContain("local read-only viewer");
        expect(help).toContain("requires a network connection");
        expect(help).not.toMatch(/bundled|offline/);
        expect(result.exit).not.toHaveBeenCalled();
    });

    it("reports failed updates as CLI errors", async () => {
        vi.doMock("./self.js", () => ({
            prepareSelfDocs: vi.fn(),
            selfUpdate: () => {
                throw new Error("Update failed");
            },
        }));
        const result = cli("self", "update");
        await expect(result.run()).rejects.toThrow("CLI exit");
        expect(result.stderr).toHaveBeenCalledWith("Update failed");
    });

    it("initializes a manifest that supports adding the first document", async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-init-"));
        roots.push(root);
        const result = cli("init");
        await result.run();
        expect(readdirSync(root)).toEqual(["dooc.yaml"]);
        const { readManifest } = await import("../../engine/src/compiler/manifest.js");
        expect(readManifest(root)).toMatchObject({ format: "nested", tree: [], errors: [] });
        expect(result.stdout).toHaveBeenCalledWith(expect.stringContaining("dooc edit"));
        const { createDocOps } = await import("../../engine/src/compiler/ops.js");
        expect(createDocOps(root).addFile("guide.md", "Guide")).not.toHaveProperty("error");
        const { compileSite } = await import("../../engine/src/compiler/compile.js");
        expect(compileSite(root).errors).toEqual([]);
    });

    it.each([
        ["docs/nested", "docs/nested/dooc.yaml"],
        ["docs/dooc.yaml", "docs/dooc.yaml"],
        ["docs/team.dooc.yaml", "docs/team.dooc.yaml"],
        ["team.dooc.yaml", "team.dooc.yaml"],
    ])("initializes the selected path %s", async (input, output) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-init-path-"));
        roots.push(root);
        for (const target of [input, join(root, "absolute", input)]) {
            const result = cli("init", target);
            await result.run();
            const file = target === input ? join(root, output) : join(root, "absolute", output);
            expect(existsSync(file)).toBe(true);
            const { readManifest, projectRoot } = await import(
                "../../engine/src/compiler/manifest.js"
            );
            expect(readManifest(projectRoot(file))).toMatchObject({
                format: "nested",
                tree: [],
                errors: [],
            });
            expect(result.stdout).toHaveBeenCalledWith(expect.stringContaining(file));
        }
        expect(existsSync(join(root, "dooc.yaml"))).toBe(false);
    });

    it.each([
        ["dooc.yaml", false],
        ["dooc.yaml", true],
        ["team.dooc.yaml", false],
        ["team.dooc.yaml", true],
    ])("preserves an existing %s (symlink=%s)", async (name, symlink) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-init-existing-"));
        roots.push(root);
        const manifest = join(root, name);
        const target = symlink ? join(root, "existing.yaml") : manifest;
        const raw = "# Keep this configuration\ncenter_contents: []\n";
        writeFileSync(target, raw);
        if (symlink) symlinkSync(target, manifest);
        const result = cli("init", name);
        await expect(result.run()).rejects.toThrow("CLI exit");
        expect(result.exit).toHaveBeenCalledWith(1);
        expect(result.stderr).toHaveBeenCalledWith(expect.stringContaining("already exists"));
        expect(readFileSync(manifest, "utf8")).toBe(raw);
        expect(readFileSync(target, "utf8")).toBe(raw);
    });

    it.each([
        ["--help"],
        ["-h"],
        ["--unknown"],
        ["--force"],
        ["one", "two"],
    ])("does not create a manifest for init %s", async (...args) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-init-args-"));
        roots.push(root);
        const result = cli("init", ...args);
        if (args[0] === "--help" || args[0] === "-h") {
            await result.run();
            expect(result.stdout).toHaveBeenCalledWith(expect.stringContaining("dooc init"));
            expect(result.exit).not.toHaveBeenCalled();
        } else {
            await expect(result.run()).rejects.toThrow("CLI exit");
            expect(result.exit).toHaveBeenCalledWith(1);
        }
        expect(readdirSync(root)).toEqual([]);
    });

    it("injects an external Git origin into MCP without starting viewer plugins", async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-mcp-"));
        roots.push(root);
        writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
        const module = join(root, "origin.mjs");
        writeFileSync(
            module,
            `export default {
            plugins: [],
            setup() { throw new Error("Viewer setup must not run"); },
            gitOrigin: { name: "External", capabilities: [], async read() {}, async execute() {} },
        };`,
        );
        const startMcp = vi.fn().mockResolvedValue(undefined);
        vi.doMock("./mcp.js", () => ({ startMcp }));
        await cli("mcp", join(root, "dooc.yaml"), "--git-origin", module).run();
        expect(startMcp).toHaveBeenCalledWith(root, {
            gitOrigin: expect.objectContaining({
                name: "External",
                read: expect.any(Function),
                execute: expect.any(Function),
            }),
        });
        const invalid = cli("mcp", join(root, "dooc.yaml"), "--unknown");
        await expect(invalid.run()).rejects.toThrow("CLI exit");
        expect(startMcp).toHaveBeenCalledTimes(1);
    });

    it("registers, lists and removes project fonts through the CLI", async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-font-"));
        roots.push(root);
        writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
        const file = new URL("./fonts/udev-gothic-regular.woff2", import.meta.url).pathname;
        await cli("font", "add", file, join(root, "dooc.yaml")).run();
        expect(existsSync(join(root, ".dooc/fonts/udev-gothic-regular.woff2"))).toBe(true);
        const listed = cli("font", "list", join(root, "dooc.yaml"));
        await listed.run();
        expect(JSON.parse(listed.stdout.mock.calls[0]?.[0] as string)).toEqual([
            "udev-gothic-regular.woff2",
        ]);
        await cli("font", "remove", "udev-gothic-regular.woff2", join(root, "dooc.yaml")).run();
        const empty = cli("font", "list", join(root, "dooc.yaml"));
        await empty.run();
        expect(JSON.parse(empty.stdout.mock.calls[0]?.[0] as string)).toEqual([]);
    });

    it.each([[], ["help"], ["--help"], ["-h"]])("shows help for %j", async (...args) => {
        const result = cli(...args);
        await result.run();
        const help = result.stdout.mock.calls[0]?.[0];
        expect(help).toContain("init");
        expect(help).toContain("edit [path] [port]");
        expect(help).toContain("view [path] [port]");
        expect(help).toContain("mcp [dooc.yaml]");
        expect(help).not.toMatch(/(?:^|\n)\s+(?:preview|code-language|doc ls|figure ls)\b/);
        expect(help).not.toMatch(/[│├└─]/);
        expect(help).toMatch(/\n {2}build[^\n]*\n {5}html \[dooc.yaml\] \[out-dir\]/);
        expect(help).toContain("\n     zip [dooc.yaml] [out-dir]");
        expect(help).toMatch(/\n {2}plugin[^\n]*\n {5}pack <built-dir> \[zip\]/);
        expect(help).toMatch(/\n {2}font[^\n]*\n {5}add <file> \[dooc.yaml\]/);
        expect(help).toContain("\n     --viewer-plugins <module>");
        expect(help).toContain("\n        --source-url <url>");
        expect(help).toContain("\n     --git-origin <module>");
        expect(help).toContain("--url_preview embed|network");
        expect(help).toContain("--mode static|live");
        expect(help).toContain("export [dooc.yaml] [out-dir]");
        expect(help).not.toMatch(/export json|json-schema/);
        expect(result.stderr).not.toHaveBeenCalled();
        expect(result.exit).not.toHaveBeenCalled();
    });

    it.each([true, false])("sets the runtime environment for prebuilt=%s", async (prebuilt) => {
        vi.doMock("./assets.js", () => ({ prebuilt }));
        await cli("help").run();
        expect(process.env.NODE_ENV).toBe(prebuilt ? "production" : "development");
    });

    it.each([
        ["edit", "edit"],
        ["view", "preview"],
    ])("starts %s with the expected server mode and arguments", async (command, mode) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-project-"));
        roots.push(root);
        writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
        const startServer = vi.fn();
        vi.doMock("./serve.js", () => ({ startServer }));
        vi.stubEnv("DOCS_ROOT", "");
        vi.stubEnv("DOCS_HMR", "");
        await cli(command, join(root, "dooc.yaml"), "4321").run();
        expect(startServer).toHaveBeenLastCalledWith(mode, 4321, undefined);
        expect(process.env.DOCS_ROOT).toBe(root);
        expect(process.env.DOCS_HMR).toBe("1");
        await cli(command).run();
        expect(startServer).toHaveBeenLastCalledWith(mode, 5179, undefined);
        expect(process.env.DOCS_ROOT).toBe(root);
    });

    it("rejects folders, missing manifests and other files before starting a viewer", async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-invalid-"));
        roots.push(root);
        const other = join(root, "other.yaml");
        writeFileSync(other, "docs: []\n");
        const startServer = vi.fn();
        vi.doMock("./serve.js", () => ({ startServer }));
        for (const path of [root, other, join(root, "dooc.yaml")]) {
            const result = cli("edit", path);
            await expect(result.run()).rejects.toThrow("CLI exit");
            expect(result.stderr).toHaveBeenCalledWith(
                expect.stringContaining("Specify an existing dooc.yaml or <name>.dooc.yaml file"),
            );
        }
        expect(startServer).not.toHaveBeenCalled();
    });

    it.each(["edit", "view"])("clones a Git workspace before starting %s", async (command) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-github-"));
        roots.push(root);
        mkdirSync(join(root, "dooc-docs"));
        writeFileSync(join(root, "dooc-docs/dooc.yaml"), "docs: []\n");
        const manifest = join(root, "team.dooc.yaml");
        writeFileSync(manifest, "docs: []\n");
        let complete!: (value: {
            root: string;
            manifest: string;
            dispose: () => void;
            reused: boolean;
        }) => void;
        const download = new Promise<{
            root: string;
            manifest: string;
            dispose: () => void;
            reused: boolean;
        }>((resolve) => {
            complete = resolve;
        });
        const prepareGitWorkspace = vi.fn(() => download);
        vi.doMock("./git-workspace.js", () => ({
            prepareGitWorkspace,
        }));
        const startServer = vi.fn();
        vi.doMock("./serve.js", () => ({ startServer }));
        const once = vi.spyOn(process, "once").mockReturnValue(process);
        vi.stubEnv("DOCS_ROOT", "/existing");
        vi.stubEnv("DOCS_HMR", "1");
        const source = "https://github.com/dooc-dev/dooc.git";
        vi.stubEnv("GIT_DIR", "/caller/.git");
        vi.stubEnv("GIT_CONFIG_COUNT", "1");
        vi.stubEnv("GIT_CONFIG_KEY_0", "core.worktree");
        vi.stubEnv("GIT_CONFIG_VALUE_0", "/caller");
        vi.stubEnv("GIT_CONFIG_GLOBAL", "/caller/gitconfig");
        const pending = cli(command, "dooc-docs", "4321", "--repo", source).run();
        await vi.waitFor(() =>
            expect(prepareGitWorkspace).toHaveBeenCalledWith(source, command, {
                path: "dooc-docs",
            }),
        );
        expect(startServer).not.toHaveBeenCalled();
        expect(process.env.DOCS_ROOT).toBe("/existing");
        expect(process.env.GIT_DIR).toBeUndefined();
        expect(process.env.GIT_CONFIG_COUNT).toBeUndefined();
        expect(process.env.GIT_CONFIG_KEY_0).toBeUndefined();
        expect(process.env.GIT_CONFIG_VALUE_0).toBeUndefined();
        expect(process.env.GIT_CONFIG_GLOBAL).toBe("/caller/gitconfig");
        const dispose = vi.fn();
        complete({ root, manifest, dispose, reused: false });
        await pending;
        expect(startServer).toHaveBeenCalledWith(
            command === "edit" ? "edit" : "preview",
            4321,
            undefined,
            { open: true },
        );
        expect(process.env.DOCS_ROOT).toBe(root);
        expect(process.env.DOCS_HMR).toBe(command === "edit" ? "1" : "0");
        expect(process.env.DOOC_REMOTE_WORKSPACE).toBe("1");
        expect(once).toHaveBeenCalledWith("exit", dispose);
        const { manifestFile } = await import("../../engine/src/compiler/manifest.js");
        expect(manifestFile(root)).toBe("team.dooc.yaml");
    });

    it.each([
        "owner/repo/docs",
        "notes:2026",
    ])("opens local folder %s without cloning", async (name) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-local-source-"));
        roots.push(root);
        const local = join(root, name);
        mkdirSync(local, { recursive: true });
        writeFileSync(join(local, "dooc.yaml"), "docs: []\n");
        const prepareGitWorkspace = vi.fn();
        vi.doMock("./git-workspace.js", () => ({
            prepareGitWorkspace,
        }));
        const startServer = vi.fn();
        vi.doMock("./serve.js", () => ({ startServer }));
        vi.stubEnv("DOCS_ROOT", "");
        vi.stubEnv("DOCS_HMR", "");
        await cli("edit", name).run();
        expect(prepareGitWorkspace).not.toHaveBeenCalled();
        expect(process.env.DOCS_ROOT).toBe(local);
        expect(startServer).toHaveBeenCalledWith("edit", 5179, undefined);
    });

    it.each(["path", "file URL"])("selects a nested local workspace from a %s", async (kind) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-local-url-"));
        roots.push(root);
        const docs = join(root, "my docs");
        mkdirSync(docs);
        writeFileSync(join(docs, "team.dooc.yaml"), "docs: []\n");
        const prepareGitWorkspace = vi.fn();
        vi.doMock("./git-workspace.js", () => ({
            prepareGitWorkspace,
        }));
        const startServer = vi.fn();
        vi.doMock("./serve.js", () => ({ startServer }));
        vi.stubEnv("DOCS_ROOT", "");
        vi.stubEnv("DOCS_HMR", "");
        const manifest = join(docs, "team.dooc.yaml");
        const source = kind === "path" ? manifest : pathToFileURL(manifest).href;
        await cli("edit", source).run();
        expect(prepareGitWorkspace).not.toHaveBeenCalled();
        expect(startServer).toHaveBeenCalledWith("edit", 5179, undefined);
        expect(process.env.DOCS_ROOT).toBe(docs);
        expect(process.env.DOOC_REMOTE_WORKSPACE).toBe("0");
        const { manifestFile } = await import("../../engine/src/compiler/manifest.js");
        expect(manifestFile(docs)).toBe("team.dooc.yaml");
    });

    it("does not interpret missing relative paths as GitHub shorthand", async () => {
        const prepareGitWorkspace = vi.fn();
        vi.doMock("./git-workspace.js", () => ({
            prepareGitWorkspace,
        }));
        const startServer = vi.fn();
        vi.doMock("./serve.js", () => ({ startServer }));
        const result = cli("view", "owner/repository/docs");
        await expect(result.run()).rejects.toThrow("CLI exit");
        expect(prepareGitWorkspace).not.toHaveBeenCalled();
        expect(startServer).not.toHaveBeenCalled();
    });

    it("requires an explicit repository option for remote URLs", async () => {
        const startServer = vi.fn();
        vi.doMock("./serve.js", () => ({ startServer }));
        const result = cli("edit", "https://host.example/team/docs.git");
        await expect(result.run()).rejects.toThrow("CLI exit");
        expect(result.stderr).toHaveBeenCalledWith(
            "Pass Git repository URLs with --repo <git-url>",
        );
        expect(startServer).not.toHaveBeenCalled();
    });

    it("does not start a server after a failed Git clone", async () => {
        vi.doMock("./git-workspace.js", () => ({
            prepareGitWorkspace: vi.fn().mockRejectedValue(new Error("Git unavailable")),
        }));
        const startServer = vi.fn();
        vi.doMock("./serve.js", () => ({ startServer }));
        const result = cli("view", "--repo", "https://github.com/dooc-dev/dooc.git");
        await expect(result.run()).rejects.toThrow("CLI exit");
        expect(startServer).not.toHaveBeenCalled();
        expect(result.stderr).toHaveBeenCalledWith("Git unavailable");
    });

    it.each(["edit", "view"])("shows Git URL usage for %s without downloading", async (command) => {
        const prepareGitWorkspace = vi.fn();
        vi.doMock("./git-workspace.js", () => ({
            prepareGitWorkspace,
        }));
        const result = cli(command, "--help");
        await result.run();
        expect(result.stdout).toHaveBeenCalledWith(expect.stringContaining("--repo <git-url>"));
        expect(prepareGitWorkspace).not.toHaveBeenCalled();
    });

    it.each(["edit", "view", "mcp"])("selects a named manifest for %s", async (command) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-named-"));
        roots.push(root);
        writeFileSync(join(root, "dooc.yaml"), "title: Other\ndocs: []\n");
        writeFileSync(join(root, "team.dooc.yaml"), "title: Team\ndocs: []\n");
        vi.doMock("./serve.js", () => ({ startServer: vi.fn() }));
        vi.doMock("./mcp.js", () => ({ startMcp: vi.fn() }));
        vi.stubEnv("DOCS_ROOT", "");
        vi.stubEnv("DOCS_HMR", "");
        await cli(command, join(root, "team.dooc.yaml")).run();
        const { readManifest } = await import("../../engine/src/compiler/manifest.js");
        expect(readManifest(root).title).toBe("Team");
    });

    it("injects viewer modules independently of the document root", async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-project-"));
        roots.push(root);
        writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
        const startServer = vi.fn();
        vi.doMock("./serve.js", () => ({ startServer }));
        vi.stubEnv("DOOC_VIEWER_PLUGINS", "./external-viewer.mjs");
        await cli("edit", join(root, "dooc.yaml")).run();
        expect(startServer).toHaveBeenLastCalledWith("edit", 5179, "./external-viewer.mjs");
        await cli(
            "view",
            join(root, "dooc.yaml"),
            "4321",
            "--viewer-plugins",
            "./override.mjs",
        ).run();
        expect(startServer).toHaveBeenLastCalledWith("preview", 4321, "./override.mjs");
    });

    it.each([
        ["json-schema", "latest"],
        ["preview"],
        ["dev"],
        ["code-language", "add", "python"],
        ["doc", "ls"],
        ["figure", "ls"],
    ])("rejects removed commands: %j", async (...args) => {
        const result = cli(...args);
        await expect(result.run()).rejects.toThrow("CLI exit");
        expect(result.exit).toHaveBeenCalledWith(1);
        expect(result.stdout).not.toHaveBeenCalled();
        expect(result.stderr).toHaveBeenCalledWith(expect.stringContaining("unknown command"));
    });

    it("exports sources without executing configuration or plugins", async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-export-"));
        roots.push(root);
        mkdirSync(join(root, "docs"));
        writeFileSync(join(root, "dooc.yaml"), "center_contents:\n  - file: docs/guide.md\n");
        writeFileSync(join(root, "docs/guide.md"), "![](https://private.example/item)\n");
        writeFileSync(join(root, "docs.config.mjs"), 'throw new Error("Do not execute");');
        const result = cli("export", join(root, "dooc.yaml"));
        await result.run();
        expect(result.exit).not.toHaveBeenCalled();
        expect(readFileSync(join(root, "dist/bundle.zip")).subarray(0, 2).toString()).toBe("PK");
    });

    it("rejects unsupported URL preview options without writing output", async () => {
        for (const args of [
            [],
            ["pdf"],
            ["html", "--lang", "eng"],
            ["html", "--html", "static"],
            ["zip", "--zip", "embed"],
            ["html", "--mode", "embed"],
            ["zip", "--mode", "static"],
            ["zip", "--easy-download"],
            ["html", "--url_preview", "static"],
            ["html", "--url_preview", "invalid"],
            ["zip", "--url_preview", "reference"],
            ["zip", "--url_preview", "invalid"],
        ]) {
            const result = cli("build", ...args);
            await expect(result.run()).rejects.toThrow("CLI exit");
            expect(result.exit).toHaveBeenCalledWith(1);
        }
    });

    it.each([
        ["html", undefined, "embed"],
        ["html", "network", "network"],
        ["zip", undefined, "embed"],
        ["zip", "network", "network"],
    ] as const)("writes only the selected artifact for build %s --url_preview %s", async (format, preview, expectedPreview) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-build-"));
        roots.push(root);
        writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
        const out = join(root, preview ? "custom" : "dist");
        mkdirSync(out);
        const other = join(out, format === "html" ? "bundle.zip" : "bundle.html");
        writeFileSync(other, "Keep existing artifact");
        const buildBundle = vi.fn().mockResolvedValue({ data: "Built artifact", docs: 1 });
        vi.doMock("./build.js", () => ({ buildBundle }));
        const result = cli(
            "build",
            format,
            join(root, "dooc.yaml"),
            ...(preview
                ? [
                      out,
                      ...(format === "html"
                          ? ["--url_preview", preview]
                          : [`--url_preview=${preview}`]),
                  ]
                : []),
        );
        await result.run();
        expect(buildBundle).toHaveBeenCalledWith(root, { format, urlPreview: expectedPreview });
        expect(readFileSync(join(out, `bundle.${format}`), "utf8")).toBe("Built artifact");
        expect(readFileSync(other, "utf8")).toBe("Keep existing artifact");
        expect(result.stdout).toHaveBeenCalledTimes(1);
    });

    it("passes an injected source URL to the HTML build", async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-source-"));
        roots.push(root);
        writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
        const buildBundle = vi.fn().mockResolvedValue({ data: "Built artifact", docs: 0 });
        vi.doMock("./build.js", () => ({ buildBundle }));
        await cli(
            "build",
            "html",
            join(root, "dooc.yaml"),
            "--source-url",
            "https://example.com/source/",
        ).run();
        expect(buildBundle).toHaveBeenCalledWith(
            root,
            expect.objectContaining({ sourceUrl: "https://example.com/source/" }),
        );
    });

    it("enables easy download for an HTML build", async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-download-"));
        roots.push(root);
        writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
        const buildBundle = vi.fn().mockResolvedValue({ data: "Built artifact", docs: 0 });
        vi.doMock("./build.js", () => ({ buildBundle }));
        await cli("build", "html", join(root, "dooc.yaml"), "--easy-download").run();
        expect(buildBundle).toHaveBeenCalledWith(
            root,
            expect.objectContaining({ easyDownload: true }),
        );
    });

    it.each([
        "html",
        "zip",
    ])("preserves existing artifacts when build %s validation fails", async (format) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-"));
        roots.push(root);
        writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
        mkdirSync(join(root, "content"));
        mkdirSync(join(root, "dist"));
        writeFileSync(join(root, "dooc.yaml"), "docs: [guide]\n");
        writeFileSync(join(root, "content/guide.md"), "---\ntitle: Guide\n---\n");
        for (const file of ["bundle.html", "bundle.zip"])
            writeFileSync(join(root, "dist", file), "Previous bundle");
        const result = cli("build", format, join(root, "dooc.yaml"));
        await expect(result.run()).rejects.toThrow("CLI exit");
        expect(result.stderr).toHaveBeenCalledWith(expect.stringContaining("validation failed"));
        for (const file of ["bundle.html", "bundle.zip"])
            expect(readFileSync(join(root, "dist", file), "utf8")).toBe("Previous bundle");
    });
});

it("starts server and static client independently and builds the client without a manifest", async () => {
    const startWorkspaceServer = vi.fn(),
        startStaticClient = vi.fn(),
        buildStaticClient = vi.fn();
    vi.doMock("./workspace-server.js", () => ({ startWorkspaceServer }));
    vi.doMock("./static-client.js", () => ({ startStaticClient, buildStaticClient }));
    await cli(
        "server",
        "project/dooc.yaml",
        "6200",
        "--client-origin",
        "https://editor.example",
    ).run();
    expect(startWorkspaceServer).toHaveBeenCalledWith(
        "project/dooc.yaml",
        6200,
        "https://editor.example",
        undefined,
    );
    await cli("client", "6201", "--server", "ws://localhost:6200/api/workspace").run();
    expect(startStaticClient).toHaveBeenCalledWith(6201, "ws://localhost:6200/api/workspace");
    await cli("build", "client", "/tmp/dooc-client-output").run();
    expect(buildStaticClient).toHaveBeenCalledWith("/tmp/dooc-client-output", undefined);
});
