import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { escapeHtml } from "../core/html.js";
import type { PluginCredentialStore } from "../plugins/local-storage.js";
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
            if (size > 65_536) {
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
    credentials?: PluginCredentialStore,
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
    const runtime = createPluginRuntime(config.plugins, transport, credentials);
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
    const tickets = new Map<string, { plugin: string; origin: string; expires: number }>();
    const loginLink = (plugin: string, origin: string): string => {
        if (!config.plugins.some((item) => item.id === plugin))
            throw new Error("Plugin is not configured");
        for (const [key, value] of tickets) if (value.expires <= Date.now()) tickets.delete(key);
        const ticket = randomBytes(32).toString("hex");
        tickets.set(ticket, { plugin, origin, expires: Date.now() + 10 * 60 * 1000 });
        return `${origin}/api/plugins/login/${plugin}?ticket=${ticket}`;
    };
    const authorizationUrl = async (
        session: string,
        plugin: string,
        host: string,
    ): Promise<string> => {
        if (config.plugins.find((item) => item.id === plugin)?.oauth.deviceAuthorizationUrl) {
            const state = await runtime.connectDevice(session, plugin);
            return `http://${host}/api/plugins/device/${plugin}?state=${state}`;
        }
        const authorization = new URL(
            runtime.connect(session, plugin, `http://${host}/api/plugins/callback/${plugin}`),
        );
        const mock = origins.get(authorization.origin);
        return mock
            ? `http://${host}/api/plugins/mock/${mock.id}${authorization.pathname}${authorization.search}`
            : authorization.href;
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
            const createSession = () => {
                session = runtime.createSession();
                res.setHeader(
                    "set-cookie",
                    `${cookie}=${session}; HttpOnly; SameSite=Lax; Path=/api/plugins; Max-Age=28800`,
                );
            };
            const login = /^\/api\/plugins\/login\/([a-z][a-z0-9-]{0,63})$/.exec(url.pathname);
            if (req.method === "GET" && login?.[1]) {
                const key = url.searchParams.get("ticket") ?? "";
                const ticket = tickets.get(key);
                if (
                    !ticket ||
                    ticket.expires <= Date.now() ||
                    ticket.plugin !== login[1] ||
                    ticket.origin !== `http://${host}`
                )
                    throw new PluginError(400, "Invalid or expired login link");
                tickets.delete(key);
                if (!runtime.hasSession(session)) createSession();
                res.writeHead(303, {
                    location: await authorizationUrl(session, ticket.plugin, host),
                });
                res.end();
                return true;
            }
            const device = /^\/api\/plugins\/device\/([a-z][a-z0-9-]{0,63})$/.exec(url.pathname);
            if (req.method === "GET" && device?.[1]) {
                if (url.searchParams.getAll("state").length !== 1)
                    throw new PluginError(400, "Invalid device authorization");
                const pending = await runtime.pollDevice(
                    session,
                    device[1],
                    url.searchParams.get("state") ?? "",
                );
                if (req.headers.accept === "application/json") {
                    send(200, pending ?? { connected: true });
                    return true;
                }
                const nonce = randomBytes(16).toString("hex");
                res.setHeader(
                    "content-security-policy",
                    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
                );
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                const name = escapeHtml(
                    config.plugins.find((item) => item.id === device[1])?.name ?? device[1],
                );
                res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect ${name}</title>
<style>html{color-scheme:light dark}body{max-width:32rem;margin:4rem auto;padding:0 1.5rem;font:16px/1.6 system-ui}input{font:1.5rem monospace;max-width:100%;box-sizing:border-box;padding:.5rem}a{color:LinkText}:focus-visible{outline:2px solid LinkText;outline-offset:3px}</style>
<main><h1>Connect ${name}</h1>${pending ? `<section id="instructions"><p>Enter this code on ${name} to authorize dooc.</p><p><label>Verification code<br><input readonly value="${escapeHtml(pending.userCode)}"></label></p><p><a href="${escapeHtml(pending.verificationUri)}" target="_blank" rel="noopener noreferrer">Continue to ${name}</a></p><noscript><p>After approving, <a href="">check the connection</a>.</p></noscript></section>` : ""}
<p id="status" role="status">${pending ? "Waiting for authorization…" : "Connected. You can close this tab and return to dooc."}</p></main>
${
    pending
        ? `<script nonce="${nonce}">
const status = document.getElementById("status");
async function poll() {
  try {
    const response = await fetch(location.href, {headers:{accept:"application/json"}});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Sign-in failed. Return to dooc and try again.");
    if (data.connected) {
      document.getElementById("instructions").hidden = true;
      status.textContent = "Connected. You can close this tab and return to dooc.";
    } else setTimeout(poll, data.retryAfter * 1000);
  } catch (error) { status.textContent = error.message; }
}
setTimeout(poll, ${pending.retryAfter * 1000});
</script>`
        : ""
}</html>`);
                return true;
            }
            const callback = /^\/api\/plugins\/callback\/([a-z][a-z0-9-]{0,63})$/.exec(
                url.pathname,
            );
            if (req.method === "GET" && callback?.[1]) {
                let cancelled = false;
                try {
                    await runtime.callback(
                        session,
                        callback[1],
                        `http://${host}${url.pathname}`,
                        url.searchParams,
                    );
                } catch (error) {
                    if (
                        !isPluginError(error) ||
                        error.message !== "OAuth authorization was not completed"
                    )
                        throw error;
                    cancelled = true;
                }
                res.writeHead(cancelled ? 400 : 200, {
                    "content-type": "text/html; charset=utf-8",
                });
                res.end(
                    `<!doctype html><html lang="en"><meta charset="utf-8"><title>${cancelled ? "Sign-in not completed" : "Plugin connected"}</title><p>${cancelled ? "Sign-in was not completed. No account was connected." : "Connected."} You can close this tab and return to dooc.</p></html>`,
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
                if (plugin && credentials && !runtime.hasSession(session)) createSession();
                send(200, {
                    plugin,
                    ...(plugin && runtime.hasSession(session) && runtime.status(session, plugin)
                        ? { connected: true }
                        : {}),
                    ...(plugin && mocks.get(plugin)?.autoConnect ? { autoConnect: true } : {}),
                });
                return true;
            }
            if (typeof input.plugin !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(input.plugin))
                throw new PluginError(400, "Invalid plugin ID");
            if (
                !runtime.hasSession(session) &&
                (credentials || input.action === "connect" || input.action === "status")
            )
                createSession();
            if (input.action === "connect") {
                send(200, { url: await authorizationUrl(session, input.plugin, host) });
            } else if (input.action === "status") {
                send(200, { user: runtime.status(session, input.plugin) ?? null });
            } else if (input.action === "disconnect") {
                if (runtime.hasSession(session)) runtime.disconnect(session, input.plugin);
                send(200, { disconnected: true });
            } else if (input.action === "read") {
                send(200, await runtime.read(session, input.plugin, input.url));
            } else if (input.action === "actions") {
                send(200, await runtime.actions(session, input.plugin, input.url));
            } else if (input.action === "act") {
                send(
                    200,
                    await runtime.act(
                        session,
                        input.plugin,
                        input.url,
                        input.operation,
                        input.requestId,
                    ),
                );
            } else throw new PluginError(400, "Invalid plugin action");
        } catch (error) {
            send(isPluginError(error) ? error.status : 502, {
                error: isPluginError(error) ? error.message : "Plugin request failed",
            });
        }
        return true;
    };
    return Object.assign(handle, registry, {
        loginLink,
        configuration: () => config,
    });
};
