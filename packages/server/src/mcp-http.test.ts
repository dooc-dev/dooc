import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMcpHandler } from "./mcp-http.js";

vi.mock("./terminal.js", () => ({ terminal: { ready: vi.fn() } }));
let root: string;
let server: Server;
const listen = async (readOnly = false) => {
    const service = createServer(createMcpHandler(root, { readOnly }));
    await new Promise<void>((resolve, reject) => {
        service.once("error", reject);
        service.listen(0, "127.0.0.1", resolve);
    });
    return service;
};
let url: string;
const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
};
const post = (message: unknown, extra: Record<string, string> = {}) =>
    fetch(url, {
        method: "POST",
        headers: { ...headers, ...extra },
        body: JSON.stringify(message),
    });
const rpc = (method: string, params?: unknown) => post({ jsonrpc: "2.0", id: 1, method, params });
beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "dooc-http-mcp-"));
    mkdirSync(join(root, "content"));
    writeFileSync(join(root, "dooc.yaml"), "docs: [guide]\n");
    writeFileSync(join(root, "content/guide.md"), "Hello\n");
    server = await listen(true);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    url = `http://127.0.0.1:${address.port}/mcp`;
});
afterEach(async () => {
    if (server)
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
        });
    rmSync(root, { recursive: true, force: true });
});

it("uses /mcp POST, negotiates HTTP versions, and accepts notifications without a session", async () => {
    const initialized = await rpc("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
    });
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get("mcp-session-id")).toBeNull();
    expect(await initialized.json()).toMatchObject({
        result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } },
    });
    expect(await (await rpc("initialize", { protocolVersion: "2024-11-05" })).json()).toMatchObject(
        { result: { protocolVersion: "2025-11-25" } },
    );
    for (const message of [
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 1, result: {} },
    ]) {
        const response = await post(message);
        expect(response.status).toBe(202);
        expect(await response.text()).toBe("");
    }
    expect((await fetch(url)).status).toBe(405);
    expect((await fetch(`${url}/other`, { method: "POST", headers, body: "{}" })).status).toBe(404);
});

it("exposes project skills over reader HTTP and refreshes the configured list", async () => {
    mkdirSync(join(root, ".agents/skills/review-docs"), { recursive: true });
    writeFileSync(
        join(root, "dooc.yaml"),
        "system:\n  skills: [.agents/skills/review-docs/SKILL.md]\ndocument: {}\n",
    );
    const source =
        "---\nname: review-docs\ndescription: Apply the project checklist.\n---\nUse read_file to read the project checklist.\n";
    writeFileSync(join(root, ".agents/skills/review-docs/SKILL.md"), source);
    expect(await (await rpc("skills/list")).json()).toMatchObject({
        result: { skills: [{ uri: "skill://review-docs/SKILL.md" }] },
    });
    expect(
        await (await rpc("resources/read", { uri: "skill://review-docs/SKILL.md" })).json(),
    ).toMatchObject({ result: { contents: [{ text: source }] } });
    writeFileSync(join(root, "dooc.yaml"), "document: {}\n");
    expect(await (await rpc("skills/list")).json()).toMatchObject({ result: { skills: [] } });
});

it("lists only read tools and rejects guessed mutation names without changing documents", async () => {
    const listed = (await (await rpc("tools/list")).json()) as {
        result: { tools: { name: string }[] };
    };
    const names = listed.result.tools.map((tool) => tool.name);
    expect(names).toContain("read_doc");
    for (const name of [
        "write_doc",
        "write_file",
        "add_doc",
        "delete_doc",
        "git",
        "build",
        "update_files",
    ]) {
        expect(names).not.toContain(name);
        expect(
            await (
                await rpc("tools/call", { name, arguments: { id: "guide", content: "Changed" } })
            ).json(),
        ).toMatchObject({ error: { code: -32602 } });
    }
    const read = (await (
        await rpc("tools/call", { name: "read_doc", arguments: { id: "guide" } })
    ).json()) as { result: { content: { text: string }[] } };
    expect(JSON.parse(read.result.content[0]?.text ?? "{}")).toMatchObject({ raw: "Hello\n" });
    expect(readFileSync(join(root, "content/guide.md"), "utf8")).toBe("Hello\n");
});

it("rejects foreign origins and hosts, unsupported versions and malformed HTTP input", async () => {
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await post(ping, { Origin: "https://other.example" })).status).toBe(403);
    const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(
            url,
            { method: "POST", headers: { ...headers, Host: "other.example" } },
            (res) => {
                res.resume();
                res.on("end", () => resolve(res.statusCode));
            },
        );
        req.on("error", reject);
        req.end(JSON.stringify(ping));
    });
    expect(foreignHost).toBe(403);
    expect((await post(ping, { Origin: new URL(url).origin })).status).toBe(200);
    expect((await post(ping, { "MCP-Protocol-Version": "unknown" })).status).toBe(400);
    expect((await post(ping, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await post(ping, { Accept: "application/json" })).status).toBe(406);
    const invalid = await fetch(url, { method: "POST", headers, body: "{" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: -32700 } });
    expect(await (await post([])).json()).toMatchObject({ error: { code: -32600 } });
});

it("keeps editing tools available for an editor MCP service", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = await listen();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    url = `http://127.0.0.1:${address.port}/mcp`;
    const response = await (
        await rpc("tools/call", {
            name: "write_doc",
            arguments: { id: "guide", content: "Changed\n" },
        })
    ).json();
    expect(response).toMatchObject({ result: { isError: false } });
    expect(readFileSync(join(root, "content/guide.md"), "utf8")).toBe("Changed\n");
});
