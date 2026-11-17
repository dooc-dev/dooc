import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createWorkspaceClient } from "../../workspace/src/client.js";
import { buildApplication, parseApplicationOptions, runApplication } from "./application.js";
import { packageVersion } from "./assets.js";
import { git } from "./git.js";
import { prepareGitWorkspace } from "./git-workspace.js";
import * as mcp from "./mcp.js";
import { clientAssets } from "./static-client.js";
import { terminal } from "./terminal.js";

vi.mock("./static-client.js", async (original) => ({
    ...(await original<typeof import("./static-client.js")>()),
    clientAssets: vi.fn(async () => new Map<string, Buffer>()),
}));
vi.mock("./git-workspace.js", () => ({ prepareGitWorkspace: vi.fn() }));
const roots: string[] = [];
afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-application-"));
    roots.push(root);
    writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
    return root;
};
const options = (...args: string[]) => {
    const result = parseApplicationOptions("editor", args);
    if (!result) throw new Error("Expected options");
    return result;
};

it("defaults reader publication to latest and validates run/build selectors", () => {
    expect(parseApplicationOptions("reader", ["run", "node", "--all"])?.versions).toBe("latest");
    for (const action of ["run", "build"])
        for (const selector of ["*.*.latest", "latest.*.*", ">=1.2.0 <2.0.0"])
            expect(
                parseApplicationOptions("reader", [action, "node", "--all", "--versions", selector])
                    ?.versions,
            ).toBe(selector);
    expect(() => parseApplicationOptions("reader", ["--versions", "latest*latest*latest"])).toThrow(
        "Invalid version",
    );
    expect(() => options("--versions", "latest")).toThrow("reader publication");
});

it.each([
    "editor",
    "reader",
] as const)("expands the %s shortcut and forwards option overrides to run node --all", (product) => {
    const shortcut = parseApplicationOptions(product, []);
    expect(shortcut).toEqual(parseApplicationOptions(product, ["run", "node", "--all"]));
    expect(shortcut).toMatchObject({
        product,
        action: "run",
        runtime: "node",
        project: "dooc.yaml",
        port: 3000,
        client: true,
        server: true,
        mcp: true,
    });
    const overrides = ["--port", "4100", "--project", "docs/team.dooc.yaml", "--no-mcp"];
    const configured = parseApplicationOptions(product, overrides);
    expect(configured).toEqual(
        parseApplicationOptions(product, ["run", "node", "--all", ...overrides]),
    );
    expect(configured).toMatchObject({
        project: "docs/team.dooc.yaml",
        port: 4100,
        origin: "http://localhost:4100",
        client: true,
        server: true,
        mcp: false,
    });
    expect(parseApplicationOptions(product, ["--help"])).toBeUndefined();
});

it("requires an explicit component and applies exclusions regardless of argument order", () => {
    expect(() => options("run", "node")).toThrow("Select");
    expect(() => options("run", "node", "--all", "--no-client", "--no-server", "--no-mcp")).toThrow(
        "Select",
    );
    expect(options("run", "node", "--server")).toMatchObject({
        client: false,
        server: true,
        mcp: false,
        port: 3000,
    });
    for (const flags of [
        ["--all", "--no-mcp"],
        ["--no-mcp", "--all", "--mcp"],
    ])
        expect(options("run", "web", ...flags)).toMatchObject({
            client: true,
            server: true,
            mcp: false,
        });
    expect(parseApplicationOptions("reader", ["--help"])).toBeUndefined();
});

it.each(["stdio", "http"])("selects %s for Node MCP run and build", (transport) => {
    for (const action of ["run", "build"])
        expect(options(action, "node", "--mcp", "--mcp-transport", transport)).toMatchObject({
            client: false,
            server: false,
            mcp: true,
            mcpTransport: transport,
        });
    expect(options("run", "node", "--all", "--mcp-transport", transport)).toMatchObject({
        client: true,
        server: true,
        mcpTransport: transport,
    });
});

it("ignores HTTP TLS defaults for stdio-only runs", () => {
    vi.stubEnv("DOOC_TLS_CERT", "/missing/cert.pem");
    vi.stubEnv("DOOC_TLS_KEY", "/missing/key.pem");
    expect(options("run", "node", "--mcp", "--mcp-transport", "stdio")).not.toHaveProperty("tls");
});

it.each([
    ["--port", "0"],
    ["--no-client", "--no-server", "--no-mcp"],
    ["--out", "output"],
    ["run", "local", "--all"],
    ["run", "node", "--all", "extra"],
    ["build", "web", "--mcp"],
    ["run", "web", "--mcp", "--relay-url", "https://relay.example"],
    ["run", "node", "--all", "--relay-url", "https://relay.example"],
    ["build", "web", "--all", "--relay-url", "http://relay.example"],
    ["build", "web", "--all", "--relay-url", "https://relay.example/mcp"],
    ["build", "web", "--all", "--relay-url", "https://secret@relay.example"],
    ["run", "web", "--server"],
    ["run", "web", "--client", "--server-url", "ws://localhost:3001"],
    ["run", "node", "--mcp", "--server-url", "ws://localhost:3001"],
    ["run", "node", "--all", "--viewer-plugins", "./plugins.mjs"],
    ["run", "node", "--mcp", "--mcp-transport", "invalid"],
    ["run", "node", "--server", "--mcp-transport", "stdio"],
    ["run", "node", "--all", "--no-mcp", "--mcp-transport", "http"],
    ["build", "web", "--all", "--mcp-transport", "http"],
    ["run", "web", "--all", "--mcp-transport", "stdio"],
    ["run", "node", "--mcp", "--mcp-transport", "stdio", "--port", "4000"],
    [
        "run",
        "node",
        "--mcp",
        "--mcp-transport",
        "stdio",
        "--client-origin",
        "http://localhost:3000",
    ],
    [
        "run",
        "node",
        "--mcp",
        "--mcp-transport",
        "stdio",
        "--tls-cert",
        "cert.pem",
        "--tls-key",
        "key.pem",
    ],
    ["build", "node", "--server", "--port", "4000"],
    ["run", "node", "--client", "--out", "output"],
    ["build", "node", "--server", "--repo", "https://example.com/docs.git"],
    ["run", "web", "--all", "--tls-cert", "cert.pem", "--tls-key", "key.pem"],
    ["run", "node", "--client", "--repo", "https://example.com/docs.git"],
    ["run", "node", "--server", "--tls-cert", "cert.pem"],
    ["run", "node", "--server", "--tls-key", "key.pem"],
    ["run", "node", "--client", "--shared", "main"],
    ["run", "node", "--server", "--shared", ""],
    ["run", "node", "--all", "--shared", "main"],
    ...["0", "65536", "1.5", "abc", "-1"].map((port) => ["run", "node", "--mcp", "--port", port]),
])("rejects an invalid command before starting work: %j", (...args) => {
    expect(() => options(...args)).toThrow();
    expect(clientAssets).not.toHaveBeenCalled();
});

it("serves client, read-only workspace and MCP on one port with separate paths", async () => {
    const project = fixture();
    vi.mocked(clientAssets).mockResolvedValueOnce(
        new Map([["index.html", Buffer.from("Static client")]]),
    );
    const parsed = options("run", "node", "--all", "--project", project);
    parsed.product = "reader";
    parsed.port = 0;
    const running = await runApplication(parsed);
    const address = running.server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    const origin = `http://127.0.0.1:${address.port}`;
    const socket = new WebSocket(`${origin.replace("http:", "ws:")}/server`, {
        origin: parsed.origin,
    });
    try {
        await new Promise<void>((resolve, reject) => {
            socket.once("open", resolve);
            socket.once("error", reject);
        });
        const workspace = createWorkspaceClient({
            send: (message) => socket.send(JSON.stringify(message)),
            receive: (handler) =>
                socket.on("message", (data) => handler(JSON.parse(data.toString()))),
            closed: (handler) => socket.on("close", handler),
        });
        expect(await workspace.request("hello")).toMatchObject({ readOnly: true });
        await expect(workspace.request("files", { action: "upload" })).rejects.toThrow("read-only");
        expect(await (await fetch(`${origin}/client/guide`)).text()).toBe("Static client");
        const root = await fetch(origin, { redirect: "manual" });
        expect(root.headers.get("location")).toBe("/client/");
        for (const path of [
            "/server",
            "/api/workspace",
            "/api/plugins",
            "/guide",
            "/client/api/save",
        ])
            expect((await fetch(`${origin}${path}`)).status).toBe(404);
        expect(
            (await fetch(`${origin}/api/plugins`, { method: "POST", body: '{"action":"act"}' }))
                .status,
        ).toBe(405);
        const ping = await fetch(`${origin}/mcp`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        });
        expect(await ping.json()).toMatchObject({ result: {} });
        expect(clientAssets).toHaveBeenCalledWith("ws://localhost:0/server", {
            runtime: "node",
            readOnly: true,
            client: true,
            worker: false,
            basePath: "/client",
        });
    } finally {
        await running.close();
        socket.terminate();
    }
    expect(running.server.listening).toBe(false);
});

it.each([
    "editor",
    "reader",
] as const)("runs development %s with matching client and MCP permissions", async (product) => {
    const project = fixture();
    writeFileSync(join(project, "dooc.yaml"), "document:\n  title: Guide\n  url: guide.md\n");
    writeFileSync(join(project, "guide.md"), "Committed document.\n");
    await git(project, ["init", "-b", "main"]);
    await git(project, ["add", "."]);
    await git(project, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "Initial document",
    ]);
    writeFileSync(join(project, "guide.md"), "Uncommitted development content.\n");
    vi.mocked(clientAssets).mockResolvedValueOnce(
        new Map([["index.html", Buffer.from("Development client")]]),
    );
    const ready = vi.spyOn(terminal, "ready");
    const parsed = parseApplicationOptions(product, ["--project", project]);
    if (!parsed) throw new Error("Missing options");
    parsed.port = 0;
    const running = await runApplication(parsed, true);
    const readOnly = product === "reader";
    let socket: WebSocket | undefined;
    try {
        const address = running.server.address();
        if (!address || typeof address === "string") throw new Error("Missing address");
        const origin = `http://127.0.0.1:${address.port}`;
        for (const path of ["/client", "/client/guide.pdf"])
            expect(
                await (
                    await fetch(`${origin}${path}`, { headers: { Accept: "text/html" } })
                ).text(),
            ).toBe("Development client");
        expect((await fetch(origin, { redirect: "manual" })).headers.get("location")).toBe(
            "/client/",
        );
        for (const path of [
            "/client/assets/missing.js",
            "/editor/",
            "/reader/",
            "/guide",
            "/server",
        ])
            expect((await fetch(`${origin}${path}`)).status).toBe(404);
        const socketPath = readOnly ? "/client" : "/server";
        const connection = new WebSocket(`${origin.replace("http:", "ws:")}${socketPath}`, {
            origin: parsed.origin,
        });
        socket = connection;
        await new Promise<void>((resolve, reject) => {
            connection.once("open", resolve);
            connection.once("error", reject);
        });
        const client = createWorkspaceClient({
            send: (message) => connection.send(JSON.stringify(message)),
            receive: (handler) =>
                connection.on("message", (data) => handler(JSON.parse(data.toString()))),
            closed: (handler) => connection.on("close", handler),
        });
        expect(await client.request("hello")).toMatchObject({ readOnly });
        const request = { method: "GET", url: "/", headers: {}, body: "" };
        const response = await client.request<{ body: string }>("http", request);
        expect(response.body.includes('src="/assets/edit.js"')).toBe(!readOnly);
        expect(response.body).toContain("Uncommitted development content.");
        if (readOnly) {
            for (const [op, args] of [
                ["http", { method: "POST", url: "/api/save", body: "{}", headers: {} }],
                ["files", { action: "upload", name: "test.txt", data: "eA==" }],
                ["git", { action: "commit", message: "Change" }],
                ["history", { action: "restore" }],
                ["workspaces", { action: "branch", branch: "new", create: true }],
                ["extensions", { action: "install", file: "plugin.zip", data: "", base: null }],
                ["plugins", { action: "act", plugin: "sample" }],
            ] as const)
                await expect(client.request(op, { ...args, readOnly: false })).rejects.toThrow(
                    "read-only",
                );
        } else {
            const uploaded = await client.request<{ file: string }>("files", {
                action: "upload",
                name: "test.txt",
                data: "eA==",
            });
            expect(readFileSync(join(project, uploaded.file), "utf8")).toBe("x");
        }
        const changed = new Promise<void>((resolve) => {
            const stop = client.on("change", () => {
                stop();
                resolve();
            });
        });
        writeFileSync(join(project, "guide.md"), "Updated development content.\n");
        await changed;
        expect((await client.request<{ body: string }>("http", request)).body).toContain(
            "Updated development content.",
        );
        const rpc = async (method: string, params: Record<string, unknown> = {}) => {
            const response = await fetch(`${origin}/mcp`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json, text/event-stream",
                },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            });
            expect(response.status).toBe(200);
            return response.json();
        };
        const names = (await rpc("tools/list")).result.tools.map(
            (tool: { name: string }) => tool.name,
        );
        expect(names).toContain("read_file");
        const read = await rpc("tools/call", {
            name: "read_file",
            arguments: { file: "guide.md" },
        });
        expect(JSON.parse(read.result.content[0].text)).toMatchObject({
            content: "Updated development content.\n",
        });
        const write = {
            name: "write_file",
            arguments: { file: "mcp-note.txt", content: "Written through editor MCP", base: null },
        };
        if (readOnly) {
            for (const name of [
                "write_file",
                "write_doc",
                "add_doc",
                "delete_doc",
                "git",
                "build",
                "history",
            ]) {
                expect(names).not.toContain(name);
                expect(await rpc("tools/call", { ...write, name })).toMatchObject({
                    error: { code: -32602 },
                });
            }
            expect(existsSync(join(project, "mcp-note.txt"))).toBe(false);
        } else {
            expect(names).toContain("write_file");
            expect((await rpc("tools/call", write)).result.isError).toBe(false);
            expect(readFileSync(join(project, "mcp-note.txt"), "utf8")).toBe(
                "Written through editor MCP",
            );
        }
        expect(clientAssets).toHaveBeenCalledWith(
            `ws://localhost:0${socketPath}`,
            expect.objectContaining({ readOnly, basePath: "/client", worker: false }),
        );
        expect(ready).toHaveBeenCalledWith(product, {
            Client: `http://localhost:${address.port}/client/`,
            MCP: `http://localhost:${address.port}/mcp`,
            ...(readOnly ? {} : { Server: `ws://localhost:${address.port}/server` }),
        });
    } finally {
        await running.close();
        socket?.terminate();
        ready.mockRestore();
    }
    expect(running.server.listening).toBe(false);
}, 20_000);

it("releases its workspace service when the shared port is occupied", async () => {
    const project = fixture();
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
        occupied.once("error", reject);
        occupied.listen(0, "127.0.0.1", resolve);
    });
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    try {
        await expect(
            runApplication(
                options(
                    "run",
                    "node",
                    "--server",
                    "--mcp",
                    "--port",
                    String(address.port),
                    "--project",
                    project,
                ),
            ),
        ).rejects.toThrow("EADDRINUSE");
        expect(occupied.listening).toBe(true);
    } finally {
        await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
});

it("runs a web Worker through static assets without reading a Node project", async () => {
    const parsed = options("run", "web", "--all", "--no-mcp", "--project", "/missing/project");
    parsed.port = 0;
    const running = await runApplication(parsed);
    try {
        expect(clientAssets).toHaveBeenCalledWith(undefined, {
            runtime: "web",
            readOnly: false,
            client: true,
            worker: true,
            basePath: "",
        });
    } finally {
        await running.close();
    }
});

it.each([false, true])("closes stdio and selected HTTP components (server=%s)", async (server) => {
    const project = fixture();
    const stopped = vi.fn();
    const start = vi.spyOn(mcp, "startMcp").mockImplementation(
        (_root, _options, signal) =>
            new Promise<void>((resolve) => {
                signal?.addEventListener(
                    "abort",
                    () => {
                        stopped();
                        resolve();
                    },
                    { once: true },
                );
            }),
    );
    const parsed = options(
        "run",
        "node",
        "--mcp",
        "--mcp-transport",
        "stdio",
        "--project",
        project,
    );
    parsed.server = server;
    parsed.port = 0;
    const running = await runApplication(parsed);
    try {
        expect(start).toHaveBeenCalledWith(
            project,
            expect.objectContaining({ readOnly: false }),
            expect.any(AbortSignal),
        );
        expect(running.done).toBeInstanceOf(Promise);
        expect(running.server.listening).toBe(server);
        const address = running.server.address();
        if (server && address && typeof address === "object")
            expect((await fetch(`http://127.0.0.1:${address.port}/mcp`)).status).toBe(404);
        else expect(address).toBeNull();
    } finally {
        await Promise.all([running.close(), running.close()]);
        start.mockRestore();
    }
    await running.done;
    expect(stopped).toHaveBeenCalledOnce();
    expect(running.server.listening).toBe(false);
});

it("builds a Node launcher with pinned dependencies and preserves existing output", async () => {
    const root = fixture();
    const out = join(root, "output");
    mkdirSync(out);
    const parsed = options("build", "node", "--server", "--mcp", "--out", out);
    await buildApplication(parsed);
    expect(readdirSync(out).sort()).toEqual(["package.json", "start.mjs"]);
    expect(JSON.parse(readFileSync(join(out, "package.json"), "utf8"))).toMatchObject({
        type: "module",
        dependencies: { "@dooc-dev/dooc": packageVersion },
        scripts: { start: "node start.mjs" },
    });
    expect(readFileSync(join(out, "start.mjs"), "utf8")).toContain(
        '["run","node","--server","--mcp"]',
    );
    writeFileSync(join(out, "user.txt"), "Keep this");
    await expect(buildApplication(parsed)).rejects.toThrow("existing files were kept");
    expect(readFileSync(join(out, "user.txt"), "utf8")).toBe("Keep this");
});

it("builds selected web assets without a Node launcher or project directory", async () => {
    const out = join(fixture(), "web");
    vi.mocked(clientAssets).mockResolvedValueOnce(
        new Map([["assets/workspace-worker.js", Buffer.from("worker")]]),
    );
    await buildApplication(options("build", "web", "--server", "--out", out));
    expect(clientAssets).toHaveBeenCalledWith(undefined, {
        runtime: "web",
        readOnly: false,
        client: false,
        worker: true,
        basePath: "",
    });
    expect(readFileSync(join(out, "assets/workspace-worker.js"), "utf8")).toBe("worker");
    expect(existsSync(join(out, "package.json"))).toBe(false);
});

it("preserves MCP transport in a standalone Node launcher", async () => {
    const out = join(fixture(), "stdio");
    await buildApplication(
        options("build", "node", "--mcp", "--mcp-transport", "stdio", "--out", out),
    );
    expect(readFileSync(join(out, "start.mjs"), "utf8")).toContain(
        '["run","node","--mcp","--mcp-transport","stdio"]',
    );
});

it("builds browser MCP with a Worker, client and optional public relay configuration", async () => {
    const out = join(fixture(), "web-mcp");
    const parsed = options(
        "build",
        "web",
        "--all",
        "--relay-url",
        "https://relay.example/",
        "--out",
        out,
    );
    expect(parsed.relayUrl).toBe("https://relay.example");
    await buildApplication(parsed);
    expect(clientAssets).toHaveBeenCalledWith(undefined, {
        runtime: "web",
        readOnly: false,
        client: true,
        worker: true,
        basePath: "",
        relayUrl: "https://relay.example",
        mcp: true,
    });
    expect(existsSync(join(out, "package.json"))).toBe(false);
});

it("supports Desktop connections without a hosted relay", () => {
    expect(options("build", "web", "--all")).toMatchObject({ mcp: true, relayUrl: undefined });
});

it("preserves explicit TLS and plugin settings over their environment defaults", () => {
    vi.stubEnv("DOOC_TLS_CERT", "/default/cert.pem");
    vi.stubEnv("DOOC_TLS_KEY", "/default/key.pem");
    vi.stubEnv("DOOC_READER_PLUGINS", "./default.mjs");
    expect(options("run", "node", "--all")).toMatchObject({
        tls: { cert: "/default/cert.pem", key: "/default/key.pem" },
        origin: "https://localhost:3000",
        pluginModule: "./default.mjs",
    });
    expect(
        options(
            "run",
            "node",
            "--server",
            "--tls-cert",
            "/chosen/cert.pem",
            "--tls-key",
            "/chosen/key.pem",
            "--reader-plugins",
            "./chosen.mjs",
            "--shared",
            "main",
        ),
    ).toMatchObject({
        tls: { cert: "/chosen/cert.pem", key: "/chosen/key.pem" },
        pluginModule: "./chosen.mjs",
        shared: "main",
    });
    expect(options("build", "web", "--all")).not.toHaveProperty("tls");
    expect(() =>
        parseApplicationOptions("reader", ["run", "node", "--all", "--shared", "main"]),
    ).toThrow("editor server");
});

it.each(["folder", "manifest", "file URL"])("opens a local %s without cloning", async (kind) => {
    const root = fixture();
    const manifest = join(root, "team.dooc.yaml");
    writeFileSync(manifest, "docs: []\n");
    const source =
        kind === "folder" ? root : kind === "manifest" ? manifest : pathToFileURL(manifest).href;
    const parsed = options("run", "node", "--server", "--project", source);
    parsed.port = 0;
    const running = await runApplication(parsed);
    try {
        expect(prepareGitWorkspace).not.toHaveBeenCalled();
        expect(running.server.listening).toBe(true);
    } finally {
        await running.close();
    }
});

it.each([
    "editor",
    "reader",
] as const)("opens a protected Git workspace for %s and disposes it on shutdown", async (product) => {
    const root = fixture();
    const dispose = vi.fn();
    vi.mocked(prepareGitWorkspace).mockResolvedValueOnce({
        root,
        manifest: join(root, "dooc.yaml"),
        dispose,
        reused: false,
    });
    vi.stubEnv("GIT_DIR", "/caller/.git");
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.worktree");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "/caller");
    vi.stubEnv("DOOC_REMOTE_WORKSPACE", "0");
    const parsed = options(
        "run",
        "node",
        "--server",
        "--project",
        "docs",
        "--repo",
        "https://example.com/repository.git",
    );
    parsed.product = product;
    parsed.port = 0;
    const running = await runApplication(parsed);
    try {
        expect(prepareGitWorkspace).toHaveBeenCalledWith(
            "https://example.com/repository.git",
            product === "editor" ? "edit" : "view",
            { path: "docs" },
        );
        for (const key of ["GIT_DIR", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"])
            expect(process.env[key]).toBeUndefined();
        expect(process.env.DOOC_REMOTE_WORKSPACE).toBe("1");
        expect(dispose).not.toHaveBeenCalled();
    } finally {
        await running.close();
    }
    expect(dispose).toHaveBeenCalledOnce();
});

it("rejects invalid local projects and failed clones before listening", async () => {
    for (const project of [
        "/missing/dooc.yaml",
        "https://example.com/repo.git",
        "file:///tmp/docs?query=1",
    ]) {
        const parsed = options("run", "node", "--server", "--project", project);
        parsed.port = 0;
        await expect(runApplication(parsed)).rejects.toThrow();
    }
    vi.mocked(prepareGitWorkspace).mockRejectedValueOnce(new Error("Git unavailable"));
    const parsed = options("run", "node", "--server", "--repo", "https://example.com/repo.git");
    parsed.port = 0;
    await expect(runApplication(parsed)).rejects.toThrow("Git unavailable");
});
