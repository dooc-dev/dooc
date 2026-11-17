import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type RequestListener, type Server, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { parseArgs } from "node:util";
import { callMcpTool, handleRpc, MCP_HTTP_VERSIONS } from "../../workspace/src/mcp.js";
import {
    RELAY_CALL_MS,
    RELAY_MESSAGE_BYTES,
    RELAY_OFFLINE_MS,
    RELAY_POLL_MS,
    type RelayCall,
    validateRelayUrl,
} from "../../workspace/src/mcp-relay.js";
import { createMcpTools } from "../../workspace/src/mcp-tools.js";
import { HttpError, readJson, sendJson } from "./http-json.js";
import { serveMcpHttp } from "./mcp-http-transport.js";
import { startDesktopRelay } from "./mcp-relay-stdio.js";

interface PendingCall {
    call: RelayCall;
    delivered: boolean;
    finish(value: unknown): void;
}
interface Connection {
    instance: string;
    until: number;
    poll?: ServerResponse;
    calls: Map<string, PendingCall>;
}
export interface RelayOptions {
    publicUrl: string;
    clientOrigin: string;
    secret: string;
    allowPairing?: boolean;
}

export const createMcpRelay = (options: RelayOptions) => {
    const publicUrl = validateRelayUrl(options.publicUrl);
    const clientOrigin = validateRelayUrl(options.clientOrigin);
    if (options.secret.length < 32)
        throw new Error("DOOC_MCP_RELAY_SECRET needs at least 32 random characters");
    const connections = new Map<string, Connection>();
    let closed = false;
    let pending = 0;
    const sign = (value: string) =>
        createHmac("sha256", options.secret)
            .update(`${publicUrl}\n${clientOrigin}\n${value}`)
            .digest("base64url");
    const credential = (id: string, mode: string, role: string) => {
        const value = `${id}.${mode}.${role}`;
        return `${value}.${sign(value)}`;
    };
    const authenticate = (authorization: string | undefined, role: "browser" | "mcp") => {
        const match = /^Bearer ([a-f0-9-]{36})\.([rw])\.([bm])\.([A-Za-z0-9_-]{43})$/.exec(
            authorization ?? "",
        );
        if (!match) throw new HttpError(401, "A workspace credential is required");
        const [, id, mode, kind, signature] = match;
        const expected = sign(`${id}.${mode}.${kind}`);
        if (
            kind !== role[0] ||
            !timingSafeEqual(Buffer.from(signature ?? ""), Buffer.from(expected))
        )
            throw new HttpError(401, "Invalid workspace credential");
        return { id: id as string, readOnly: mode === "r" };
    };
    const drop = (id: string, reason: string) => {
        const connection = connections.get(id);
        if (!connection) return;
        connections.delete(id);
        if (connection.poll) sendJson(connection.poll, 409, { error: reason });
        for (const call of [...connection.calls.values()]) call.finish({ error: reason });
    };
    const flush = (connection: Connection) => {
        const poll = connection.poll;
        if (!poll || [...connection.calls.values()].some((call) => call.delivered)) return;
        const next = connection.calls.values().next().value as PendingCall | undefined;
        if (!next) return;
        connection.poll = undefined;
        next.delivered = true;
        connection.until = next.call.deadline + RELAY_OFFLINE_MS;
        sendJson(poll, 200, next.call);
    };
    const invoke = (id: string, name: string, args: Record<string, unknown>) => {
        const connection = connections.get(id);
        if (!connection || connection.until <= Date.now())
            throw new Error("Workspace is offline. Open its dooc browser tab and enable MCP.");
        if (pending >= 32 || connection.calls.size >= 8)
            throw new Error("Workspace is busy; retry after the current requests finish");
        return new Promise<unknown>((resolve) => {
            const call: RelayCall = {
                id: randomUUID(),
                deadline: Date.now() + RELAY_CALL_MS,
                name,
                args,
            };
            const timer = setTimeout(() => {
                entry.finish({
                    error: "Workspace request timed out. A write may have completed; read before retrying.",
                });
            }, RELAY_CALL_MS);
            timer.unref();
            const entry: PendingCall = {
                call,
                delivered: false,
                finish(value) {
                    if (!connection.calls.delete(call.id)) return;
                    pending--;
                    clearTimeout(timer);
                    resolve(value);
                },
            };
            pending++;
            connection.calls.set(call.id, entry);
            flush(connection);
        });
    };
    const sweep = setInterval(() => {
        for (const [id, connection] of connections)
            if (connection.until <= Date.now()) drop(id, "Workspace connection expired");
    }, 5_000);
    sweep.unref();

    const createPairing = (readOnly: boolean) => {
        if (closed) throw new Error("Relay is closed");
        const id = randomUUID(),
            mode = readOnly ? "r" : "w";
        return { browser: credential(id, mode, "b"), mcp: credential(id, mode, "m") };
    };
    const toolsFor = (token: string) => {
        if (closed) throw new Error("Relay is closed");
        const auth = authenticate(`Bearer ${token}`, "mcp");
        return createMcpTools((name, args) => invoke(auth.id, name, args), auth.readOnly, true);
    };
    const handler: RequestListener = (req, res) => {
        void (async () => {
            const host = req.headers.host ?? "";
            if (
                host !== new URL(publicUrl).host &&
                !["localhost", "127.0.0.1", "[::1]"].includes(host.replace(/:\d+$/, ""))
            )
                throw new HttpError(403, "Invalid relay host");
            const origin = req.headers.origin;
            if (origin !== undefined && origin !== clientOrigin && origin !== publicUrl)
                throw new HttpError(403, "Origin is not allowed");
            const path = req.url ?? "/";
            if (
                ![
                    "/mcp",
                    "/relay/pair",
                    "/relay/poll",
                    "/relay/result",
                    "/relay/connection",
                ].includes(path)
            )
                throw new HttpError(404, "Not found");
            if (origin) {
                res.setHeader("Access-Control-Allow-Origin", origin);
                res.setHeader("Vary", "Origin");
            }
            if (req.method === "OPTIONS") {
                res.setHeader("Access-Control-Allow-Methods", "POST, DELETE");
                res.setHeader(
                    "Access-Control-Allow-Headers",
                    "Authorization, Content-Type, Accept, MCP-Protocol-Version",
                );
                sendJson(res, 204);
                return;
            }
            if (path === "/mcp") {
                const tools = toolsFor((req.headers.authorization ?? "").replace(/^Bearer /, ""));
                await serveMcpHttp(
                    req,
                    res,
                    (message) => handleRpc(tools, message, MCP_HTTP_VERSIONS),
                    RELAY_MESSAGE_BYTES,
                );
                return;
            }
            if (origin !== clientOrigin)
                throw new HttpError(403, "Browser requests require the configured client origin");
            const method = path === "/relay/connection" ? "DELETE" : "POST";
            if (req.method !== method) {
                res.setHeader("Allow", method);
                throw new HttpError(405, "Method not allowed");
            }
            if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json")
                throw new HttpError(415, "Expected application/json");
            const auth =
                path === "/relay/pair"
                    ? undefined
                    : authenticate(req.headers.authorization, "browser");
            const body = await readJson(req, path === "/relay/result" ? RELAY_MESSAGE_BYTES : 4096);
            if (!body || typeof body !== "object" || Array.isArray(body))
                throw new HttpError(400, "Expected an object");
            if (res.destroyed) return;
            if (path === "/relay/pair") {
                if (!("readOnly" in body) || typeof body.readOnly !== "boolean")
                    throw new HttpError(400, "Choose the workspace access mode");
                if (options.allowPairing === false)
                    throw new HttpError(403, "Use the Desktop connection link");
                sendJson(res, 201, createPairing(body.readOnly));
                return;
            }
            if (!auth) throw new HttpError(401, "Missing credential");
            if (
                !("instance" in body) ||
                typeof body.instance !== "string" ||
                !/^[a-f0-9-]{36}$/.test(body.instance)
            )
                throw new HttpError(400, "Invalid browser instance");
            let connection = connections.get(auth.id);
            if (connection && connection.until <= Date.now()) {
                drop(auth.id, "Workspace connection expired");
                connection = undefined;
            }
            if (connection && connection.instance !== body.instance)
                throw new HttpError(409, "This workspace is connected in another tab");
            if (path === "/relay/poll") {
                const created = !connection;
                if (!connection) {
                    if (connections.size >= 256)
                        throw new HttpError(503, "Relay connection limit reached");
                    connection = { instance: body.instance, until: 0, calls: new Map() };
                    connections.set(auth.id, connection);
                }
                if (connection.poll) throw new HttpError(409, "A browser poll is already waiting");
                connection.until = Date.now() + RELAY_OFFLINE_MS;
                if (created) {
                    sendJson(res, 204);
                    return;
                }
                connection.poll = res;
                const current = connection;
                const timer = setTimeout(() => sendJson(res, 204), RELAY_POLL_MS);
                timer.unref();
                res.once("close", () => {
                    clearTimeout(timer);
                    if (current.poll === res) current.poll = undefined;
                });
                flush(current);
            } else if (path === "/relay/result") {
                const call =
                    "id" in body && typeof body.id === "string"
                        ? connection?.calls.get(body.id)
                        : undefined;
                if (!call?.delivered || !("value" in body))
                    throw new HttpError(
                        410,
                        "Request expired or was not delivered to this browser",
                    );
                call.finish(body.value);
                if (connection) connection.until = Date.now() + RELAY_OFFLINE_MS;
                sendJson(res, 204);
            } else {
                drop(
                    auth.id,
                    "Workspace disconnected. A write may have completed; read before retrying.",
                );
                sendJson(res, 204);
            }
        })().catch((error: unknown) => {
            const status = error instanceof HttpError ? error.status : 500;
            if (status === 401) res.setHeader("WWW-Authenticate", 'Bearer realm="dooc workspace"');
            sendJson(res, status, {
                error: error instanceof HttpError ? error.message : "Relay request failed",
            });
        });
    };
    return {
        handler,
        createPairing,
        execute(token: string, name: string, args: Record<string, unknown>) {
            return callMcpTool(toolsFor(token), name, args);
        },
        close() {
            closed = true;
            clearInterval(sweep);
            for (const id of connections.keys())
                drop(id, "Relay stopped. A write may have completed; read before retrying.");
        },
    };
};

export const relayCommand = async (args: string[]) => {
    const { positionals, values } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            stdio: { type: "boolean" },
            "public-url": { type: "string" },
            "client-origin": { type: "string" },
            port: { type: "string" },
            host: { type: "string" },
            "tls-cert": { type: "string" },
            "tls-key": { type: "string" },
            help: { type: "boolean", short: "h" },
        },
    });
    if (values.help) {
        console.log(`usage: dooc relay --stdio
       dooc relay --public-url <https-origin> --client-origin <https-origin> [options]

--stdio lets a Desktop MCP host start a loopback relay on demand through connect_browser.
It cannot be combined with HTTP hosting options.

HTTP hosting options:
  --public-url <https-origin>   public relay origin (required)
  --client-origin <https-origin>  permitted browser origin (required)
  --port <port>                 listen port (default: 3000)
  --host <address>              listen address (default: 127.0.0.1)
  --tls-cert <pem> --tls-key <pem>  terminate HTTPS directly; otherwise use an HTTPS proxy
  --help, -h                    show this help

HTTP hosting requires DOOC_MCP_RELAY_SECRET: a persistent random secret of at least 32 characters.
Routes: /mcp for MCP clients, /relay/* for the configured browser origin.
Loopback HTTP origins are supported for development. This service does not read workspace files.`);
        return;
    }
    if (values.stdio) {
        if (positionals.length || Object.keys(values).some((key) => key !== "stdio"))
            throw new Error("--stdio cannot be combined with HTTP hosting options");
        await startDesktopRelay();
        return;
    }
    if (positionals.length || !values["public-url"] || !values["client-origin"])
        throw new Error("Relay requires --public-url and --client-origin; see dooc relay --help");
    const port = Number(values.port ?? 3000);
    if (!/^\d+$/.test(values.port ?? "3000") || port < 1 || port > 65535)
        throw new Error("Choose a port between 1 and 65535");
    if (!values["tls-cert"] !== !values["tls-key"])
        throw new Error("--tls-cert and --tls-key must be given together");
    const relay = createMcpRelay({
        publicUrl: values["public-url"],
        clientOrigin: values["client-origin"],
        secret: process.env.DOOC_MCP_RELAY_SECRET ?? "",
    });
    let server: Server | undefined;
    try {
        server =
            values["tls-cert"] && values["tls-key"]
                ? createSecureServer(
                      {
                          cert: readFileSync(values["tls-cert"]),
                          key: readFileSync(values["tls-key"]),
                      },
                      relay.handler,
                  )
                : createServer(relay.handler);
        server.on("upgrade", (_req, socket) => socket.destroy());
        server.once("close", () => relay.close());
        server.requestTimeout = 30_000;
        const listener = server;
        await new Promise<void>((resolve, reject) => {
            listener.once("error", reject);
            listener.listen(port, values.host ?? "127.0.0.1", resolve);
        });
        console.error(`MCP relay: ${validateRelayUrl(values["public-url"])}/mcp`);
        return server;
    } catch (error) {
        relay.close();
        server?.close();
        throw error;
    }
};
