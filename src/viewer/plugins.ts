import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isPluginError, PluginError } from "../plugins/oauth.js";
import { createPluginRuntime } from "../plugins/runtime.js";
import type { DataPlugin } from "../plugins/types.js";
import { isLocalToolRequest } from "./editor-tools.js";

export type { GitWorkspace, StorageWorkspace, WorkspaceSource } from "../core/workspace.js";

import {
    type ViewerPluginRegistry,
    type ViewerPlugins,
    validateViewerPlugins,
} from "./plugin-config.js";

export type {
    GitContext,
    GitOrigin,
    GitOriginAction,
    GitOriginState,
    GitPullRequest,
} from "./git-types.js";
export type {
    PluginMock,
    ViewerPluginRegistry,
    ViewerPlugins,
    ViewerRuntime,
} from "./plugin-config.js";

const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
        let body = "";
        let size = 0;
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
            size += Buffer.byteLength(chunk);
            if (size > 16_384) {
                body = "";
                reject(new PluginError(413, "Plugin request is too large"));
            } else body += chunk;
        });
        req.on("error", reject);
        req.on("end", () => resolve(body));
    });

const readInput = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const body = await readBody(req);
    try {
        const input: unknown = JSON.parse(body);
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
        return input as Record<string, unknown>;
    } catch {
        throw new PluginError(400, "Invalid plugin request");
    }
};

/** Local viewer only: the cookie identifies a browser session, never a document-supplied user. */
export const createPluginHandler = (
    plugins: readonly DataPlugin[],
    presentation: Pick<ViewerPlugins, "mocks"> = { mocks: {} },
) => {
    let config = validateViewerPlugins({ plugins, ...presentation });
    let mocks = new Map(Object.entries(config.mocks));
    let origins = new Map([...mocks].map(([id, mock]) => [mock.origin, { id, ...mock }]));
    const transport: typeof fetch = async (input, init) => {
        if (!origins.size) return fetch(input, init);
        const request = new Request(input, init);
        const mock = origins.get(new URL(request.url).origin);
        return mock ? mock.handle(request) : fetch(input, init);
    };
    const runtime = createPluginRuntime(config.plugins, transport);
    const cookie = `dooc-plugins-${randomBytes(8).toString("hex")}`;
    let revision = 0;
    const streams = new Set<ServerResponse>();
    const notify = (res: ServerResponse): void => {
        res.write(`data: ${cookie}:${revision}\n\n`);
    };
    const update = (next: ViewerPlugins): void => {
        config = next;
        mocks = new Map(Object.entries(config.mocks));
        origins = new Map([...mocks].map(([id, mock]) => [mock.origin, { id, ...mock }]));
        revision++;
        for (const stream of streams) notify(stream);
    };
    const registry: ViewerPluginRegistry = {
        register(plugin, options = {}) {
            const addition = validateViewerPlugins({
                plugins: [plugin],
                mocks: options.mock ? { [plugin.id]: options.mock } : {},
            });
            const next = validateViewerPlugins({
                plugins: [...config.plugins.filter((item) => item.id !== plugin.id), plugin],
                mocks: {
                    ...Object.fromEntries(
                        Object.entries(config.mocks).filter(([id]) => id !== plugin.id),
                    ),
                    ...addition.mocks,
                },
            });
            runtime.register(plugin);
            update(next);
        },
        unregister(id) {
            if (!config.plugins.some((plugin) => plugin.id === id)) return;
            runtime.unregister(id);
            update({
                plugins: config.plugins.filter((plugin) => plugin.id !== id),
                mocks: Object.fromEntries(
                    Object.entries(config.mocks).filter(([key]) => key !== id),
                ),
            });
        },
    };
    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== "/api/plugins" && !url.pathname.startsWith("/api/plugins/"))
            return false;
        res.setHeader("cache-control", "no-store");
        res.setHeader("referrer-policy", "no-referrer");
        res.setHeader("x-content-type-options", "nosniff");
        res.setHeader(
            "content-security-policy",
            "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        );
        const send = (status: number, body: unknown): void => {
            res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(body));
        };
        try {
            const host = req.headers.host ?? "";
            if (
                !["localhost", "127.0.0.1", "[::1]"].some(
                    (name) => host === `${name}:${req.socket.localPort}`,
                )
            )
                throw new PluginError(403, "Plugins require the local viewer");
            if (req.method === "GET" && url.pathname === "/api/plugins/events") {
                res.writeHead(200, {
                    "content-type": "text/event-stream",
                    connection: "keep-alive",
                });
                streams.add(res);
                res.on("close", () => streams.delete(res));
                notify(res);
                return true;
            }
            const mockRoute = /^\/api\/plugins\/mock\/([a-z][a-z0-9-]{0,63})(\/.*)$/.exec(
                url.pathname,
            );
            if (mockRoute) {
                const mock = mocks.get(mockRoute[1] ?? "");
                const target = mock && `${mock.origin}${mockRoute[2]}`;
                if (
                    !mock ||
                    !config.plugins.some((plugin) => plugin.oauth.authorizationUrl === target)
                )
                    throw new PluginError(404, "Mock authorization is not configured");
                if (
                    req.method !== "GET" &&
                    (req.method !== "POST" ||
                        req.headers.origin !== `http://${host}` ||
                        req.headers["content-type"]?.split(";")[0] !==
                            "application/x-www-form-urlencoded")
                )
                    throw new PluginError(403, "Mock consent requires a same-origin request");
                const response = await mock.handle(
                    new Request(`${target}${url.search}`, {
                        method: req.method,
                        ...(req.method === "POST"
                            ? {
                                  body: await readBody(req),
                                  headers: { "content-type": "application/x-www-form-urlencoded" },
                              }
                            : {}),
                    }),
                );
                const location = response.headers.get("location");
                if (location && !location.startsWith(`http://${host}/api/plugins/callback/`))
                    throw new PluginError(400, "Invalid mock callback");
                // Preserve the Origin header on local consent form submissions.
                res.setHeader("referrer-policy", "same-origin");
                res.setHeader(
                    "content-security-policy",
                    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
                );
                res.writeHead(response.status, {
                    "content-type":
                        response.headers.get("content-type") ?? "text/plain; charset=utf-8",
                    ...(location ? { location } : {}),
                });
                res.end(await response.text());
                return true;
            }
            let session =
                req.headers.cookie
                    ?.split(";")
                    .map((part) => part.trim())
                    .find((part) => part.startsWith(`${cookie}=`))
                    ?.slice(cookie.length + 1) ?? "";
            const callback = /^\/api\/plugins\/callback\/([a-z][a-z0-9-]{0,63})$/.exec(
                url.pathname,
            );
            if (req.method === "GET" && callback?.[1]) {
                await runtime.callback(
                    session,
                    callback[1],
                    `http://${host}${url.pathname}`,
                    url.searchParams,
                );
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                res.end(
                    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Plugin connected</title><p>Connected. Close this tab and choose Load data in dooc.</p></html>',
                );
                return true;
            }
            if (url.pathname !== "/api/plugins")
                throw new PluginError(404, "Plugin route not found");
            if (
                req.method !== "POST" ||
                !isLocalToolRequest(host, req.headers.origin, req.headers["content-type"])
            )
                throw new PluginError(403, "Plugins require a same-origin local request");
            const input = await readInput(req);
            if (input.action === "resolve") {
                const plugin = runtime.resolve(input.url);
                send(200, {
                    plugin,
                    ...(plugin && mocks.get(plugin)?.autoConnect ? { autoConnect: true } : {}),
                });
                return true;
            }
            if (typeof input.plugin !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(input.plugin))
                throw new PluginError(400, "Invalid plugin ID");
            if (input.action === "connect") {
                if (!runtime.hasSession(session)) {
                    session = runtime.createSession();
                    res.setHeader(
                        "set-cookie",
                        `${cookie}=${session}; HttpOnly; SameSite=Lax; Path=/api/plugins; Max-Age=28800`,
                    );
                }
                const authorization = new URL(
                    runtime.connect(
                        session,
                        input.plugin,
                        `http://${host}/api/plugins/callback/${input.plugin}`,
                    ),
                );
                const mock = origins.get(authorization.origin);
                send(200, {
                    url: mock
                        ? `http://${host}/api/plugins/mock/${mock.id}${authorization.pathname}${authorization.search}`
                        : authorization.href,
                });
            } else if (input.action === "disconnect") {
                if (runtime.hasSession(session)) runtime.disconnect(session, input.plugin);
                send(200, { disconnected: true });
            } else if (input.action === "read") {
                send(200, await runtime.read(session, input.plugin, input.url));
            } else throw new PluginError(400, "Invalid plugin action");
        } catch (error) {
            send(isPluginError(error) ? error.status : 502, {
                error: isPluginError(error) ? error.message : "Plugin request failed",
            });
        }
        return true;
    };
    return Object.assign(handle, registry);
};
