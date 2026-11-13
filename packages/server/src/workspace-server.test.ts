import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createWorkspaceClient } from "../../workspace/src/client.js";
import { git } from "./git.js";
import { clientOrigin, nodeWorkspaceOperations, startWorkspaceServer } from "./workspace-server.js";

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
    const server = await startWorkspaceServer(join(root, "dooc.yaml"), 0, "http://localhost:5180");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    const url = `http://127.0.0.1:${address.port}`;
    const socket = new WebSocket(url.replace("http:", "ws:") + "/api/workspace", {
        origin: "http://localhost:5180",
    });
    try {
        expect((await fetch(url + "/")).status).toBe(404);
        const rejected = new WebSocket(url.replace("http:", "ws:") + "/api/workspace", {
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
