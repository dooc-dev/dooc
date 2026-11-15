import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Readable, Writable } from "node:stream";
import { handleRpc, type Tool } from "../../workspace/src/mcp.js";
import { RELAY_MESSAGE_BYTES, validateRelayUrl } from "../../workspace/src/mcp-relay.js";
import { createMcpTools } from "../../workspace/src/mcp-tools.js";
import { sendJson } from "./http-json.js";
import { createMcpRelay } from "./mcp-relay.js";

export const createDesktopRelay = () => {
    let active:
        | { relay: ReturnType<typeof createMcpRelay>; token: string; close(): void }
        | undefined;
    let closed = false;
    const disconnect = () => {
        active?.close();
        active = undefined;
    };
    const tools: Record<string, Tool> = {
        ...createMcpTools(
            (name, args) => {
                if (!active)
                    throw new Error(
                        "Use connect_browser and approve a workspace in the browser first",
                    );
                return active.relay.execute(active.token, name, args);
            },
            false,
            true,
        ),
        connect_browser: {
            description:
                "Create a private connection link for the user's dooc Web site. Return the link to the user, who must open it, select a workspace, and approve access. The page must support dooc Web MCP. Replaces the previous connection. Request read_only=false only when the user wants edits. Never open this link yourself or send it to another service.",
            props: { url: { type: "string" }, read_only: { type: "boolean" } },
            required: ["url"],
            async run(args) {
                if (closed) throw new Error("Desktop relay is closed");
                const page = new URL(String(args.url));
                const origin = validateRelayUrl(page.origin);
                if (page.username || page.password || page.hash)
                    throw new Error("Use the dooc page URL without credentials or a fragment");
                const readOnly = args.read_only !== false;
                let relay: ReturnType<typeof createMcpRelay> | undefined;
                const server = createServer((req, res) => {
                    if (relay) relay.handler(req, res);
                    else sendJson(res, 503);
                });
                server.requestTimeout = 30_000;
                server.on("upgrade", (_req, socket) => socket.destroy());
                try {
                    await new Promise<void>((resolve, reject) => {
                        server.once("error", reject);
                        server.listen(0, "127.0.0.1", resolve);
                    });
                    if (closed) throw new Error("Desktop relay is closed");
                    const address = server.address();
                    if (!address || typeof address === "string")
                        throw new Error("Missing relay address");
                    const url = `http://127.0.0.1:${address.port}`;
                    relay = createMcpRelay({
                        publicUrl: url,
                        clientOrigin: origin,
                        secret: randomBytes(32).toString("base64url"),
                        allowPairing: false,
                    });
                    const credentials = relay.createPairing(readOnly);
                    disconnect();
                    const current = relay;
                    active = {
                        relay,
                        token: credentials.mcp,
                        close() {
                            current.close();
                            server.close();
                            server.closeAllConnections();
                        },
                    };
                    page.hash = new URLSearchParams({
                        dooc_mcp: JSON.stringify({ url, browser: credentials.browser, readOnly }),
                    }).toString();
                    return {
                        url: page.href,
                        readOnly,
                        instructions:
                            "Open this private link on the same computer, allow local network access if prompted, choose a workspace, and click Connect Desktop in the MCP dialog. Keep the tab and Desktop session open. Reconnect after restarting Desktop.",
                    };
                } catch (error) {
                    relay?.close();
                    server.close();
                    throw error;
                }
            },
        },
    };
    return {
        tools,
        close() {
            closed = true;
            disconnect();
        },
    };
};

export const startDesktopRelay = async (
    input: Readable = process.stdin,
    output: Writable = process.stdout,
): Promise<void> => {
    const desktop = createDesktopRelay();
    let stopped = false;
    const stop = () => {
        stopped = true;
        desktop.close();
        input.destroy();
    };
    input.once("end", desktop.close);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    let buffer = Buffer.alloc(0);
    const reply = (value: object) => output.write(`${JSON.stringify(value)}\n`);
    try {
        for await (const chunk of input) {
            buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
            for (;;) {
                const newline = buffer.indexOf(10);
                if ((newline < 0 ? buffer.length : newline) > RELAY_MESSAGE_BYTES)
                    throw new Error("MCP request exceeds the 8 MiB message limit");
                if (newline < 0) break;
                const line = buffer.subarray(0, newline).toString("utf8");
                buffer = buffer.subarray(newline + 1);
                if (!line.trim()) continue;
                let message: unknown;
                try {
                    message = JSON.parse(line);
                } catch {
                    reply({
                        jsonrpc: "2.0",
                        id: null,
                        error: { code: -32700, message: "parse error" },
                    });
                    continue;
                }
                const result = await handleRpc(desktop.tools, message);
                if (result) reply(result);
            }
        }
    } catch (error) {
        if (!stopped) throw error;
    } finally {
        input.removeListener("end", desktop.close);
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        desktop.close();
    }
};
