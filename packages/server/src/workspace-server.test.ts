import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createWorkspaceClient } from "../../workspace/src/client.js";
import { git } from "./git.js";
import {
    attachWorkspaceServer,
    clientOrigin,
    nodeWorkspaceOperations,
} from "./workspace-server.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("requires an exact client origin", () => {
    expect(clientOrigin("https://editor.example/")).toBe("https://editor.example");
    for (const url of [
        "https://editor.example/path",
        "https://user:pass@editor.example",
        "https://editor.example?query",
        "ws://editor.example",
    ])
        expect(() => clientOrigin(url)).toThrow();
});

it("keeps shared editors on one branch and credits their snapshots", async () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-shared-application-"));
    roots.push(root);
    writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Workspace"]);
    await git(root, ["config", "user.email", "workspace@example.com"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Initial"]);
    const manager = await nodeWorkspaceOperations(
        join(root, "dooc.yaml"),
        undefined,
        undefined,
        false,
        "main",
    );
    const session = { local: true };
    try {
        expect(manager.ops.git).toBeUndefined();
        await expect(
            manager.ops.workspaces?.({ action: "branch", branch: "other", create: true }, session),
        ).rejects.toThrow("snapshot branch");
        await manager.ops.identify?.({ name: "Alice", email: "alice@example.com" }, session);
        await manager.ops.history?.({ action: "contribute" }, session);
        writeFileSync(join(root, "notes.txt"), "Shared edit\n");
        await manager.ops.history?.({ action: "snapshot", message: "Shared change" }, session);
        expect((await git(root, ["log", "-1", "--format=%an"])).trim()).toBe("Alice");
        expect((await git(root, ["branch", "--show-current"])).trim()).toBe("main");
    } finally {
        manager.close();
    }
});

it("exposes a read-only reader over the socket and closes active connections on shutdown", async () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-reader-socket-"));
    roots.push(root);
    mkdirSync(join(root, "content"));
    writeFileSync(join(root, "dooc.yaml"), "docs: [guide]\n");
    writeFileSync(join(root, "content/guide.md"), "Reader content.\n");
    const server = createServer();
    await attachWorkspaceServer(
        server,
        join(root, "dooc.yaml"),
        "http://localhost:3000",
        undefined,
        true,
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/server`, {
        origin: "http://localhost:3000",
    });
    try {
        await new Promise<void>((resolve, reject) => {
            socket.on("open", resolve);
            socket.on("error", reject);
        });
        const client = createWorkspaceClient({
            send: (message) => socket.send(JSON.stringify(message)),
            receive: (handler) =>
                socket.on("message", (data) => handler(JSON.parse(data.toString()))),
            closed: (handler) => socket.on("close", handler),
        });
        expect(await client.request("hello")).toMatchObject({ readOnly: true });
        expect(await client.request("workspaces", { action: "list" })).toHaveLength(1);
        const response = await client.request<{ status: number; body: string }>("http", {
            method: "GET",
            url: "/guide",
            headers: {},
            body: "",
        });
        expect(response.status).toBe(200);
        expect(response.body).toContain("Reader content.");
        expect(response.body).not.toContain('src="/assets/edit.js"');
        for (const [op, args] of [
            ["http", { method: "POST", url: "/api/save", body: "{}", headers: {} }],
            ["files", { action: "upload", name: "test.txt", data: "eA==" }],
            ["files", { action: "delete", paths: ["content/guide.md"] }],
            ["git", { action: "commit", message: "Change" }],
            ["history", { action: "restore" }],
            ["workspaces", { action: "branch", branch: "new", create: true }],
            ["extensions", { action: "install", file: "plugin.zip", data: "", base: null }],
            ["plugins", { action: "act", plugin: "sample" }],
        ] as const)
            await expect(client.request(op, args)).rejects.toThrow("read-only");
        expect(readFileSync(join(root, "content/guide.md"), "utf8")).toBe("Reader content.\n");
        expect(existsSync(join(root, "test.txt"))).toBe(false);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await new Promise<void>((resolve) => {
            if (socket.readyState === WebSocket.CLOSED) resolve();
            else socket.once("close", () => resolve());
        });
    }
});

it("keeps injected plugin setup, network policy and package management available", async () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-workspace-plugins-"));
    roots.push(root);
    mkdirSync(join(root, "content"));
    writeFileSync(join(root, "dooc.yaml"), "docs: [guide]\n");
    writeFileSync(join(root, "content/guide.md"), "Plugin setup\n");
    const module = join(root, "reader.mjs");
    writeFileSync(
        module,
        `export default {
        plugins: [],
        setup(reader) { reader.setAllowedDomains(["example.com"]); }
    };\n`,
    );
    const manager = await nodeWorkspaceOperations(join(root, "dooc.yaml"), module);
    const session = { local: true, origin: "http://localhost:3000" };
    try {
        expect(await manager.ops.extensions?.({ action: "list" }, session)).toMatchObject({
            items: [],
        });
        expect(
            await manager.ops.plugins?.(
                { action: "resolve", url: "https://example.com/item" },
                session,
            ),
        ).toMatchObject({ plugin: undefined });
        const page = (await manager.ops.http?.(
            { url: "/api/page?route=/guide", method: "GET", body: "", headers: {} },
            session,
        )) as { body: string };
        expect(JSON.parse(page.body).boot.previews.domains).toEqual(["example.com"]);
        await expect(
            manager.ops.extensions?.({ action: "list" }, { local: false }),
        ).rejects.toThrow("same-origin local editor");
    } finally {
        manager.close();
    }
});

it("checks the manifest before creating worktrees and leaves uncommitted progress on its original branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-branch-manifest-"));
    roots.push(root);
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Test"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    writeFileSync(join(root, "base.txt"), "Initial\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Initial"]);
    await git(root, ["branch", "missing"]);
    mkdirSync(join(root, "docs/content"), { recursive: true });
    const manifest = join(root, "docs/team.dooc.yaml");
    const file = join(root, "docs/content/guide.md");
    writeFileSync(manifest, "docs: [guide]\n");
    writeFileSync(file, "Committed guide.\n");
    const manager = await nodeWorkspaceOperations(manifest);
    const session = { local: true };
    try {
        const worktrees = await git(root, ["worktree", "list", "--porcelain", "-z"]);
        await expect(
            manager.ops.workspaces?.({ action: "branch", branch: "missing" }, session),
        ).rejects.toThrow('Branch "missing" does not contain "docs/team.dooc.yaml"');
        await expect(
            manager.ops.workspaces?.(
                { action: "branch", branch: "new-docs", create: true },
                session,
            ),
        ).rejects.toThrow('"docs/team.dooc.yaml" is not committed in HEAD');
        expect(await git(root, ["worktree", "list", "--porcelain", "-z"])).toBe(worktrees);
        expect(await git(root, ["branch", "--list", "new-docs"])).toBe("");
        expect(existsSync(join(root, ".git/dooc-worktrees"))).toBe(false);
        expect(readFileSync(manifest, "utf8")).toBe("docs: [guide]\n");
        expect(await manager.ops.workspaces?.({ action: "list" }, session)).toHaveLength(1);

        await git(root, ["add", "docs"]);
        await git(root, ["commit", "-m", "Add documentation"]);
        writeFileSync(file, "Origin-only draft.\n");
        const next = (await manager.ops.workspaces?.(
            { action: "branch", branch: "new-docs", create: true },
            session,
        )) as { id: string };
        expect(
            readFileSync(
                join(root, ".git/dooc-worktrees", next.id, "docs/content/guide.md"),
                "utf8",
            ),
        ).toBe("Committed guide.\n");
        expect(readFileSync(file, "utf8")).toBe("Origin-only draft.\n");
        expect((await git(root, ["branch", "--show-current"])).trim()).toBe("main");
    } finally {
        manager.close();
    }
}, 30_000);

it("reuses an existing dirty user worktree without changing the original branch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dooc-existing-worktree-"));
    roots.push(directory);
    const root = join(directory, "repository");
    const outside = join(directory, "existing worktree\nwith newline");
    mkdirSync(join(root, "docs/content"), { recursive: true });
    writeFileSync(join(root, "docs/team.dooc.yaml"), "docs: [guide]\n");
    writeFileSync(join(root, "docs/content/guide.md"), "Main content.\n");
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Test"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Initial"]);
    await git(root, ["worktree", "add", "-b", "feature/nested", outside]);
    const file = join(outside, "docs/content/guide.md");
    writeFileSync(file, "User work in progress.\n");
    const manager = await nodeWorkspaceOperations(join(root, "docs/team.dooc.yaml"));
    const session = { local: true };
    try {
        const next = (await manager.ops.workspaces?.(
            { action: "branch", branch: "feature/nested" },
            session,
        )) as { id: string };
        expect(next.id).not.toBe("main");
        expect(readFileSync(file, "utf8")).toBe("User work in progress.\n");
        const response = (await manager.ops.http?.(
            {
                workspace: next.id,
                url: "/api/save",
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    file: "guide.md",
                    body: "Continued user work.\n",
                    baseRaw: "User work in progress.\n",
                    frontmatter: {},
                }),
            },
            session,
        )) as { status: number; body: string };
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body).saved).toBe(true);
        expect(readFileSync(file, "utf8")).toBe("Continued user work.\n");
        expect(
            await manager.ops.workspaces?.({ action: "branch", branch: "feature/nested" }, session),
        ).toEqual(next);
        await expect(
            manager.ops.workspaces?.(
                { action: "branch", branch: "feature/nested", create: true },
                session,
            ),
        ).rejects.toThrow("already exists");
        expect(readFileSync(file, "utf8")).toBe("Continued user work.\n");
        expect(readFileSync(join(root, "docs/content/guide.md"), "utf8")).toBe("Main content.\n");
        expect((await git(root, ["branch", "--show-current"])).trim()).toBe("main");
        expect(await manager.ops.workspaces?.({ action: "list" }, session)).toHaveLength(2);
    } finally {
        manager.close();
    }
}, 30_000);

it("serves only the socket, rejects foreign origins, isolates branches, and accepts large uploads", async () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-socket-"));
    roots.push(root);
    mkdirSync(join(root, "content"));
    writeFileSync(join(root, "dooc.yaml"), "docs: [guide]\n");
    writeFileSync(join(root, "content/guide.md"), "Main content.\n");
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Test"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Initial"]);
    await git(root, ["branch", "feature"]);
    const server = createServer((_req, res) => {
        res.writeHead(404);
        res.end();
    });
    await attachWorkspaceServer(server, join(root, "dooc.yaml"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    const url = `http://127.0.0.1:${address.port}`;
    const socket = new WebSocket(`${url.replace("http:", "ws:")}/server`, {
        origin: "http://localhost:3000",
    });
    try {
        expect((await fetch(`${url}/`)).status).toBe(404);
        const rejected = new WebSocket(`${url.replace("http:", "ws:")}/server`, {
            origin: "https://other.example",
        });
        await new Promise<void>((resolve, reject) => {
            rejected.on("open", () => reject(new Error("Foreign origin accepted")));
            rejected.on("error", () => resolve());
        });
        await new Promise<void>((resolve, reject) => {
            if (socket.readyState === WebSocket.OPEN) resolve();
            else socket.on("open", resolve);
            socket.on("error", reject);
        });
        const client = createWorkspaceClient({
            send: (message) => socket.send(JSON.stringify(message)),
            receive: (handler) =>
                socket.on("message", (data) => handler(JSON.parse(data.toString()))),
            closed: (handler) => socket.on("close", handler),
        });
        expect(await client.request("workspaces", { action: "list" })).toEqual([
            { id: "main", label: `main/${basename(root)}`, branch: "main" },
        ]);
        const next = await client.request<{ id: string; label: string }>("workspaces", {
            action: "branch",
            branch: "feature",
        });
        expect(next.id).not.toBe("main");
        expect(next.label).toBe(`feature/${basename(root)}`);
        const response = await client.request<{ status: number; body: string }>("http", {
            workspace: next.id,
            url: "/api/save",
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                file: "guide.md",
                body: "Feature edited.\n",
                baseRaw: "Main content.\n",
                frontmatter: {},
            }),
        });
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body).saved).toBe(true);
        expect(readFileSync(join(root, "content/guide.md"), "utf8")).toBe("Main content.\n");
        const branchRoot = join(root, ".git/dooc-worktrees", next.id);
        expect(readFileSync(join(branchRoot, "content/guide.md"), "utf8")).toBe(
            "Feature edited.\n",
        );
        expect(await client.request("workspaces", { action: "branch", branch: "feature" })).toEqual(
            next,
        );
        expect(
            await client.request("workspaces", {
                workspace: next.id,
                action: "branch",
                branch: "main",
            }),
        ).toMatchObject({ id: "main", branch: "main" });
        await expect(
            client.request("workspaces", {
                action: "branch",
                branch: "feature",
                create: true,
            }),
        ).rejects.toThrow("Branch already has a workspace");
        expect(readFileSync(join(branchRoot, "content/guide.md"), "utf8")).toBe(
            "Feature edited.\n",
        );
        expect(await client.request("workspaces", { action: "list" })).toHaveLength(2);
        expect((await git(root, ["branch", "--show-current"])).trim()).toBe("main");
        await expect(
            client.request("http", {
                url: "https://example.com/",
                method: "GET",
                headers: {},
                body: "",
            }),
        ).rejects.toThrow("Invalid document request");
        const data = Buffer.alloc(19 * 1024 * 1024, 42);
        const uploaded = await client.request<{ file: string }>("files", {
            action: "upload",
            name: "large.bin",
            data: data.toString("base64"),
        });
        expect(readFileSync(join(root, uploaded.file)).equals(data)).toBe(true);
    } finally {
        socket.terminate();
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
    }
}, 30_000);

import { createServer } from "node:http";
