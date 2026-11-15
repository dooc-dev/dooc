import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { callMcpTool } from "../../workspace/src/mcp.js";
import { desktopConnection, type RelayCall } from "../../workspace/src/mcp-relay.js";
import { createDesktopRelay, startDesktopRelay } from "./mcp-relay-stdio.js";

const relays: ReturnType<typeof createDesktopRelay>[] = [];
afterEach(() => {
    for (const relay of relays.splice(0)) relay.close();
});
const setup = async (readOnly = true) => {
    const desktop = createDesktopRelay();
    relays.push(desktop);
    const result = (await callMcpTool(desktop.tools, "connect_browser", {
        url: "https://web.example/editor/?theme=dark",
        read_only: readOnly,
    })) as { url: string };
    const page = new URL(result.url);
    const link = desktopConnection(page.hash);
    if (!link) throw new Error("Missing Desktop link");
    const instance = randomUUID();
    const request = (path: string, body: unknown, origin = page.origin, token = link.browser) =>
        fetch(`${link.url}/relay/${path}`, {
            method: "POST",
            headers: {
                Origin: origin,
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5000),
        });
    return { desktop, page, link, instance, request };
};

it("uses a loopback browser grant, exact origin and read-only enforcement", async () => {
    const { desktop, page, link, instance, request } = await setup();
    expect(page.pathname).toBe("/editor/");
    expect(page.search).toBe("?theme=dark");
    expect(link.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(page.hash).not.toContain(".m.");
    expect((await request("pair", { readOnly: false })).status).toBe(403);
    expect((await request("poll", { instance }, "https://evil.example")).status).toBe(403);
    expect(
        (await request("poll", { instance }, page.origin, link.browser.replace(".r.b.", ".w.b.")))
            .status,
    ).toBe(401);
    expect(() => callMcpTool(desktop.tools, "read_doc", { id: "guide" })).toThrow("offline");
    expect((await request("poll", { instance })).status).toBe(204);
    expect(() => callMcpTool(desktop.tools, "write_doc", { id: "guide", content: "bad" })).toThrow(
        "Unknown tool",
    );
    const poll = request("poll", { instance });
    const result = callMcpTool(desktop.tools, "read_doc", { id: "guide" });
    const job = (await (await poll).json()) as RelayCall;
    expect(job.name).toBe("read_doc");
    expect(
        (await request("result", { instance, id: job.id, value: { raw: "From browser" } })).status,
    ).toBe(204);
    expect(await result).toEqual({ raw: "From browser" });
    desktop.close();
    await expect(fetch(`${link.url}/mcp`)).rejects.toThrow();
});

it("allows explicitly approved edits and revokes an old connection when reconnecting", async () => {
    const { desktop, link, instance, request } = await setup(false);
    await request("poll", { instance });
    const poll = request("poll", { instance });
    const result = callMcpTool(desktop.tools, "write_file", {
        file: "guide.md",
        content: "After",
        base: "Before",
    });
    const job = (await (await poll).json()) as RelayCall;
    expect(job.args.base).toBe("Before");
    await request("result", { instance, id: job.id, value: { saved: true } });
    expect(await result).toEqual({ saved: true });
    await callMcpTool(desktop.tools, "connect_browser", { url: "https://other.example" });
    await expect(fetch(`${link.url}/mcp`)).rejects.toThrow();
});

it("speaks line-delimited stdio without logging to stdout and closes on EOF", async () => {
    const input = new PassThrough(),
        output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => {
        text += chunk.toString();
    });
    const running = startDesktopRelay(input, output);
    input.end(
        'invalid\n{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n',
    );
    await running;
    const replies = text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    expect(replies).toHaveLength(3);
    expect(replies[0].error.code).toBe(-32700);
    expect(replies[1].result.protocolVersion).toBe("2025-11-25");
    expect(replies[2].result.tools.map((tool: { name: string }) => tool.name)).toContain(
        "connect_browser",
    );
});

it("rejects unsafe link targets and oversized stdio frames", async () => {
    const desktop = createDesktopRelay();
    relays.push(desktop);
    for (const url of [
        "http://remote.example",
        "file:///tmp/doc",
        "https://user:password@web.example",
        "https://web.example/#fragment",
    ])
        await expect(callMcpTool(desktop.tools, "connect_browser", { url })).rejects.toThrow();
    const input = new PassThrough(),
        output = new PassThrough();
    const running = startDesktopRelay(input, output);
    input.end("x".repeat(8 * 1024 * 1024 + 1));
    await expect(running).rejects.toThrow("message limit");
});
