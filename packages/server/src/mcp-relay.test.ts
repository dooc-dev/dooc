import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
    RELAY_OFFLINE_MS,
    type RelayCall,
    type RelayCredentials,
} from "../../workspace/src/mcp-relay.js";
import { createMcpRelay } from "./mcp-relay.js";

const clientOrigin = "https://web.example";
const options = {
    publicUrl: "https://relay.example",
    clientOrigin,
    secret: "test-only-persistent-secret-for-relay-fixtures",
};
let relay: ReturnType<typeof createMcpRelay>;
let server: Server;
let url: string;
const controllers: AbortController[] = [];
const browser = (path: string, body: unknown, token?: string, method = "POST") => {
    const controller = new AbortController();
    controllers.push(controller);
    return fetch(`${url}/relay/${path}`, {
        method,
        signal: controller.signal,
        headers: {
            Origin: clientOrigin,
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
    });
};
const pair = async (readOnly = false) =>
    (await (await browser("pair", { readOnly })).json()) as RelayCredentials;
const rpc = (token: string, method: string, params?: unknown) =>
    fetch(`${url}/mcp`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
const call = (token: string, name = "read_doc", args: unknown = { id: "guide" }) =>
    rpc(token, "tools/call", { name, arguments: args });
beforeEach(async () => {
    relay = createMcpRelay(options);
    server = createServer((req, res) => relay.handler(req, res));
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    url = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
    vi.restoreAllMocks();
    for (const controller of controllers.splice(0)) controller.abort();
    relay.close();
    await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
    });
});

it("discovers tools while offline and keeps viewer credentials read-only", async () => {
    const credentials = await pair(true);
    expect(
        await (await rpc(credentials.mcp, "initialize", { protocolVersion: "2025-11-25" })).json(),
    ).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
    const list = (await (await rpc(credentials.mcp, "tools/list")).json()) as {
        result: { tools: { name: string }[] };
    };
    expect(list.result.tools.map((tool) => tool.name)).toContain("read_doc");
    for (const name of ["write_doc", "build", "git", "history", "add_font"]) {
        expect(list.result.tools.map((tool) => tool.name)).not.toContain(name);
        expect(await (await call(credentials.mcp, name, {})).json()).toMatchObject({
            error: { code: -32602 },
        });
    }
    expect(await (await call(credentials.mcp)).json()).toMatchObject({
        result: { isError: true, content: [{ text: expect.stringContaining("offline") }] },
    });
    expect((await rpc(credentials.browser, "ping")).status).toBe(401);
    expect((await rpc(credentials.mcp.replace(".r.m.", ".w.m."), "ping")).status).toBe(401);
});

it("routes calls and results only to their paired workspace and executing tab", async () => {
    const first = await pair(),
        second = await pair();
    const instance = randomUUID();
    expect((await browser("poll", { instance }, first.browser)).status).toBe(204);
    expect((await browser("poll", { instance }, first.mcp)).status).toBe(401);
    expect((await browser("poll", { instance: randomUUID() }, first.browser)).status).toBe(409);
    expect(await (await call(second.mcp)).json()).toMatchObject({ result: { isError: true } });
    const poll = browser("poll", { instance }, first.browser);
    const response = call(first.mcp);
    const job = (await (await poll).json()) as RelayCall;
    expect(job).toMatchObject({ name: "read_doc", args: { id: "guide" } });
    expect(
        (
            await browser(
                "result",
                { instance, id: job.id, value: "wrong workspace" },
                second.browser,
            )
        ).status,
    ).toBe(410);
    expect(
        (
            await browser(
                "result",
                { instance: randomUUID(), id: job.id, value: "wrong tab" },
                first.browser,
            )
        ).status,
    ).toBe(409);
    expect(
        (
            await browser(
                "result",
                { instance, id: job.id, value: { raw: "Workspace one" } },
                first.browser,
            )
        ).status,
    ).toBe(204);
    expect(await (await response).json()).toMatchObject({
        result: { isError: false, content: [{ text: expect.stringContaining("Workspace one") }] },
    });
    expect(
        (await browser("result", { instance, id: job.id, value: "duplicate" }, first.browser))
            .status,
    ).toBe(410);
});

it("drops pending writes on disconnect and does not deliver them again", async () => {
    const credentials = await pair(),
        instance = randomUUID();
    await browser("poll", { instance }, credentials.browser);
    const poll = browser("poll", { instance }, credentials.browser);
    const write = call(credentials.mcp, "write_doc", { id: "guide", content: "Changed" });
    const job = (await (await poll).json()) as RelayCall;
    expect(job.name).toBe("write_doc");
    await browser("connection", { instance }, credentials.browser, "DELETE");
    expect(await (await write).json()).toMatchObject({
        result: {
            isError: true,
            content: [{ text: expect.stringContaining("may have completed") }],
        },
    });
    const nextInstance = randomUUID();
    expect((await browser("poll", { instance: nextInstance }, credentials.browser)).status).toBe(
        204,
    );
    expect(
        (
            await browser(
                "result",
                { instance: nextInstance, id: job.id, value: "late" },
                credentials.browser,
            )
        ).status,
    ).toBe(410);
    const nextPoll = browser("poll", { instance: nextInstance }, credentials.browser);
    const read = call(credentials.mcp);
    const next = (await (await nextPoll).json()) as RelayCall;
    expect(next.name).toBe("read_doc");
    expect(next.id).not.toBe(job.id);
    await browser(
        "result",
        { instance: nextInstance, id: next.id, value: "Current document" },
        credentials.browser,
    );
    expect((await read).status).toBe(200);
});

it("expires idle ownership, preserves registration across restarts and rejects a rotated secret", async () => {
    const credentials = await pair(),
        instance = randomUUID();
    await browser("poll", { instance }, credentials.browser);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + RELAY_OFFLINE_MS + 1);
    expect(await (await call(credentials.mcp)).json()).toMatchObject({ result: { isError: true } });
    expect((await browser("poll", { instance: randomUUID() }, credentials.browser)).status).toBe(
        204,
    );
    relay.close();
    relay = createMcpRelay(options);
    expect((await rpc(credentials.mcp, "ping")).status).toBe(200);
    expect(await (await call(credentials.mcp)).json()).toMatchObject({ result: { isError: true } });
    relay.close();
    relay = createMcpRelay({ ...options, secret: `${options.secret}-rotated` });
    expect((await rpc(credentials.mcp, "ping")).status).toBe(401);
});

it("validates origin, content type, bearer role, paths and bounded browser input", async () => {
    const credentials = await pair();
    expect(
        (
            await fetch(`${url}/relay/pair`, {
                method: "POST",
                headers: { Origin: "https://other.example", "Content-Type": "application/json" },
                body: '{"readOnly":false}',
            })
        ).status,
    ).toBe(403);
    expect(
        (
            await fetch(`${url}/relay/pair`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: '{"readOnly":false}',
            })
        ).status,
    ).toBe(403);
    const preflight = await fetch(`${url}/relay/poll`, {
        method: "OPTIONS",
        headers: { Origin: clientOrigin },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(clientOrigin);
    expect((await browser("pair", { readOnly: "false" })).status).toBe(400);
    expect((await browser("pair", { readOnly: false, extra: "x".repeat(4096) })).status).toBe(413);
    expect((await fetch(`${url}/mcp?token=${credentials.mcp}`)).status).toBe(404);
    expect(
        (
            await fetch(`${url}/mcp`, {
                method: "POST",
                headers: { Authorization: `Bearer ${credentials.mcp}` },
                body: "{}",
            })
        ).status,
    ).toBe(415);
    expect((await rpc("invalid", "ping")).status).toBe(401);
});
