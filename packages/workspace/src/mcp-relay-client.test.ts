import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMcpRelay } from "../../server/src/mcp-relay.js";
import { pairRelay, relayCommandText, startRelay } from "./mcp-relay-client.js";

const origin = "https://web.example";
const networkFetch = globalThis.fetch;
let server: Server;
let relay: ReturnType<typeof createMcpRelay>;
let url: string;
const connectors: ReturnType<typeof startRelay>[] = [];
beforeEach(async () => {
    relay = createMcpRelay({
        publicUrl: "https://relay.example",
        clientOrigin: origin,
        secret: "test-only-long-persistent-relay-secret",
    });
    server = createServer(relay.handler);
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    url = `http://127.0.0.1:${address.port}`;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
        networkFetch(input, {
            ...init,
            headers: { ...init?.headers, Origin: origin },
        }),
    );
});
afterEach(async () => {
    for (const connector of connectors.splice(0)) {
        await connector.stop();
        await connector.done;
    }
    relay.close();
    await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
    });
    vi.unstubAllGlobals();
});
const call = async (token: string, name: string, args: unknown) => {
    const response = await networkFetch(`${url}/mcp`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
        }),
    });
    return response.json();
};

it("executes browser workspace calls over HTTP, then reconnects with the same registration", async () => {
    const credentials = await pairRelay(url, false);
    let content = "Before";
    const execute = vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === "write_doc") content = String(args.content);
        return { raw: content };
    });
    const status = vi.fn();
    const connector = startRelay({ url, credentials, execute, status });
    connectors.push(connector);
    await vi.waitFor(() =>
        expect(status).toHaveBeenCalledWith(expect.stringContaining("Connected")),
    );
    expect(
        await call(credentials.mcp, "write_doc", { id: "guide", content: "After" }),
    ).toMatchObject({ result: { isError: false } });
    expect(await call(credentials.mcp, "read_doc", { id: "guide" })).toMatchObject({
        result: { content: [{ text: expect.stringContaining("After") }] },
    });
    await connector.stop();
    await connector.done;
    status.mockClear();
    connectors.push(startRelay({ url, credentials, execute, status }));
    await vi.waitFor(() =>
        expect(status).toHaveBeenCalledWith(expect.stringContaining("Connected")),
    );
    expect(await call(credentials.mcp, "read_doc", { id: "guide" })).toMatchObject({
        result: { isError: false },
    });
    expect(execute.mock.calls.filter(([name]) => name === "write_doc")).toHaveLength(1);
    expect(relayCommandText(url, credentials.mcp)).toContain(
        "claude mcp add --transport http dooc",
    );
    expect(relayCommandText(url, credentials.mcp)).toContain("--header 'Authorization: Bearer ");
});

it("never repeats a write after its result POST is lost", async () => {
    const credentials = await pairRelay(url, false);
    const fetchWithOrigin = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/relay/result"))
            return Promise.reject(new Error("Result connection lost"));
        return fetchWithOrigin(input, init);
    });
    const execute = vi.fn(async () => ({ ok: true }));
    const status = vi.fn();
    const connector = startRelay({ url, credentials, execute, status });
    connectors.push(connector);
    await vi.waitFor(() =>
        expect(status).toHaveBeenCalledWith(expect.stringContaining("Connected")),
    );
    const pending = call(credentials.mcp, "write_doc", { id: "guide", content: "Write once" });
    await vi.waitFor(() => expect(status).toHaveBeenCalledWith("Result connection lost"));
    await connector.stop();
    expect(await pending).toMatchObject({ result: { isError: true } });
    expect(execute).toHaveBeenCalledTimes(1);
});

it("rejects insecure remote origins before fetching or exposing credentials", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(pairRelay("http://relay.example", false)).rejects.toThrow("HTTPS");
    await expect(pairRelay("https://secret@relay.example", false)).rejects.toThrow("credentials");
    expect(fetch).not.toHaveBeenCalled();
});
