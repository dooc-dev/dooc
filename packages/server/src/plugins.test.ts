import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataPlugin } from "../../../plugins/src/types.js";
import { loadViewerPlugins } from "./plugin-config.js";
import { createPluginHandler } from "./plugins.js";

const definition: DataPlugin = {
    id: "sample",
    matches: (url) => url.origin === "https://service.example",
    oauth: {
        authorizationUrl: "https://oauth.example/authorize",
        tokenUrl: "https://oauth.example/token",
        clientId: "client",
        scopes: ["read"],
    },
    apiOrigins: ["https://api.example"],
    identifyUser: async () => ({ id: "alice", name: "Alice" }),
    read: async (resource) => ({
        header: { title: decodeURIComponent(resource.pathname.slice(1)) },
        blocks: [{ type: "text", text: "Private card" }],
    }),
};

const call = async (
    handler: ReturnType<typeof createPluginHandler>,
    input?: unknown,
    options: {
        cookie?: string;
        origin?: string;
        host?: string;
        method?: string;
        path?: string;
        contentType?: string;
        accept?: string;
    } = {},
) => {
    const headers: Record<string, string> = {};
    let status = 0;
    let body = "";
    const request = Object.assign(new PassThrough(), {
        method: options.method ?? "POST",
        url: options.path ?? "/api/plugins",
        headers: {
            host: options.host ?? "localhost:5179",
            origin: options.origin ?? "http://localhost:5179",
            "content-type": options.contentType ?? "application/json",
            cookie: options.cookie,
            accept: options.accept,
        },
        socket: { localPort: 5179 },
    });
    const response = Object.assign(new PassThrough(), {
        setHeader: (key: string, value: string) => {
            headers[key] = value;
        },
        writeHead: (code: number, next: Record<string, string>) => {
            status = code;
            Object.assign(headers, next);
        },
        end: (value: string) => {
            body = value;
        },
        write: (value: string) => {
            body += value;
            return true;
        },
    });
    const task = handler(
        request as unknown as IncomingMessage,
        response as unknown as ServerResponse,
    );
    const bytes = Buffer.from(typeof input === "string" ? input : JSON.stringify(input ?? {}));
    for (const byte of bytes) request.write(Buffer.from([byte]));
    request.end();
    const handled = await task;
    return {
        status,
        get body() {
            return body;
        },
        headers,
        handled,
        close: () => response.emit("close"),
    };
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

it("serves an escaped, session-bound device sign-in page without exposing device codes or tokens", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
            Response.json({
                device_code: "private-device",
                user_code: 'CODE<>&"',
                verification_uri: "https://oauth.example/device",
                expires_in: 900,
                interval: 5,
            }),
        )
        .mockResolvedValueOnce(Response.json({ access_token: "private-token" }));
    vi.stubGlobal("fetch", transport);
    const handler = createPluginHandler([
        {
            ...definition,
            oauth: {
                ...definition.oauth,
                deviceAuthorizationUrl: "https://oauth.example/device/code",
            },
        },
    ]);
    const begin = await call(handler, { action: "connect", plugin: "sample" });
    const url = new URL(JSON.parse(begin.body).url);
    expect(url.origin).toBe("http://localhost:5179");
    const options = {
        method: "GET",
        path: url.pathname + url.search,
        cookie: begin.headers["set-cookie"]?.split(";")[0],
    };
    const page = await call(handler, undefined, options);
    expect(page.status).toBe(200);
    expect(page.body).toContain("CODE&lt;&gt;&amp;&quot;");
    expect(page.body).toContain('rel="noopener noreferrer"');
    expect(page.body).not.toContain("private-device");
    expect(page.headers["content-security-policy"]).toContain("script-src 'nonce-");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect((await call(handler, undefined, { ...options, cookie: undefined })).status).toBe(401);
    expect(
        (await call(handler, undefined, { ...options, path: `${options.path}&state=other` }))
            .status,
    ).toBe(400);
    vi.setSystemTime(5000);
    const done = await call(handler, undefined, { ...options, accept: "application/json" });
    expect(done.body).toBe('{"connected":true}');
    const status = await call(
        handler,
        { action: "status", plugin: "sample" },
        { cookie: options.cookie },
    );
    expect(JSON.parse(status.body).user).toEqual({ id: "alice", name: "Alice" });
    expect(status.body).not.toContain("private-token");
});

describe("local plugin HTTP boundary", () => {
    it("publishes runtime registrations to open viewers and rejects browser registration requests", async () => {
        const handler = createPluginHandler([]);
        const stream = await call(handler, undefined, {
            method: "GET",
            path: "/api/plugins/events",
        });
        expect(stream.status).toBe(200);
        expect(stream.headers["content-type"]).toBe("text/event-stream");
        const initial = stream.body;
        const input = { action: "resolve", url: "https://service.example/card" };
        expect(JSON.parse((await call(handler, input)).body)).toEqual({});
        handler.register(definition);
        expect(stream.body).not.toBe(initial);
        expect(JSON.parse((await call(handler, input)).body)).toEqual({ plugin: "sample" });
        const registered = stream.body;
        expect(() =>
            handler.register({ ...definition, apiOrigins: ["http://unsafe.example"] }),
        ).toThrow();
        expect(stream.body).toBe(registered);
        expect((await call(handler, { action: "register", plugin: "sample" })).status).toBe(400);
        handler.unregister("sample");
        expect(JSON.parse((await call(handler, input)).body)).toEqual({});
        expect(stream.body.split("data:")).toHaveLength(4);
        stream.close();
        const closed = stream.body;
        handler.register(definition);
        expect(stream.body).toBe(closed);
    });

    it("runs the external sample's consent, PKCE exchange, refresh, and views without network mocks", async () => {
        const network = vi.fn(() => {
            throw new Error("The sample must not use the network");
        });
        vi.stubGlobal("fetch", network);
        const config = await loadViewerPlugins(
            fileURLToPath(new URL("../../../examples/viewer-plugins/index.mjs", import.meta.url)),
        );
        const module = await import(
            new URL("../../../examples/viewer-plugins/mock.mjs", import.meta.url).href
        );
        const handler = createPluginHandler(config.plugins, {
            mocks: { sample: module.createSampleMock() },
        });
        const resolved = await call(handler, {
            action: "resolve",
            url: "https://sample.dooc.invalid/tickets/DOC-42",
        });
        expect(JSON.parse(resolved.body)).toEqual({ plugin: "sample" });
        expect(resolved.body).not.toContain("clientId");
        const authorize = async (user: string) => {
            const begin = await call(handler, { action: "connect", plugin: "sample" });
            expect(begin.status).toBe(200);
            const cookie = begin.headers["set-cookie"]?.split(";")[0];
            const url = new URL(JSON.parse(begin.body).url);
            expect(url.origin).toBe("http://localhost:5179");
            const path = url.pathname + url.search;
            const consent = await call(handler, undefined, { method: "GET", path, cookie });
            expect(consent.body).toContain("Mock OAuth authorization");
            expect(consent.headers["referrer-policy"]).toBe("same-origin");
            const transaction = /name="transaction" value="([^"]+)"/.exec(consent.body)?.[1] ?? "";
            const form = new URLSearchParams({ transaction, user }).toString();
            const options = { path, cookie, contentType: "application/x-www-form-urlencoded" };
            expect(
                (await call(handler, form, { ...options, origin: "https://attacker.example" }))
                    .status,
            ).toBe(403);
            const approved = await call(handler, form, options);
            expect(approved.status).toBe(303);
            const redirect = new URL(approved.headers.location ?? "");
            const returned = await call(handler, undefined, {
                method: "GET",
                path: redirect.pathname + redirect.search,
                cookie,
            });
            expect(returned.status).toBe(user === "deny" ? 400 : 200);
            return cookie;
        };
        const alice = await authorize("alice");
        const bob = await authorize("bob");
        for (const path of ["tickets/DOC-42", "pulls/17", "messages/release-notes"]) {
            const response = await call(
                handler,
                { action: "read", plugin: "sample", url: `https://sample.dooc.invalid/${path}` },
                { cookie: alice },
            );
            expect(response.status).toBe(200);
            expect(JSON.parse(response.body).user.name).toBe("Alice (mock)");
            expect(response.body).not.toContain("mock-access-");
        }
        expect(
            (
                await call(
                    handler,
                    {
                        action: "read",
                        plugin: "sample",
                        url: "https://sample.dooc.invalid/tickets/DOC-42",
                    },
                    { cookie: bob },
                )
            ).body,
        ).toContain("Bob (mock)");
        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + 65_000);
        expect(
            (
                await call(
                    handler,
                    {
                        action: "read",
                        plugin: "sample",
                        url: "https://sample.dooc.invalid/tickets/DOC-42",
                    },
                    { cookie: alice },
                )
            ).status,
        ).toBe(200);
        await call(handler, { action: "disconnect", plugin: "sample" }, { cookie: alice });
        expect(
            (
                await call(
                    handler,
                    {
                        action: "read",
                        plugin: "sample",
                        url: "https://sample.dooc.invalid/tickets/DOC-42",
                    },
                    { cookie: alice },
                )
            ).status,
        ).toBe(401);
        const denied = await authorize("deny");
        expect(
            (
                await call(
                    handler,
                    {
                        action: "read",
                        plugin: "sample",
                        url: "https://sample.dooc.invalid/tickets/DOC-42",
                    },
                    { cookie: denied },
                )
            ).status,
        ).toBe(401);
        expect(network).not.toHaveBeenCalled();
    });

    it("authorizes the connected mock demo without a consent screen and keeps real services manual", async () => {
        const network = vi.fn(() => {
            throw new Error("The demo must not use the network");
        });
        vi.stubGlobal("fetch", network);
        const config = await loadViewerPlugins(
            fileURLToPath(new URL("../../../examples/viewer-plugins/index.mjs", import.meta.url)),
        );
        const handler = createPluginHandler(config.plugins, config);
        const url = "https://sample.dooc.invalid/tickets/DOC-42";
        expect(JSON.parse((await call(handler, { action: "resolve", url })).body)).toEqual({
            plugin: "sample",
            autoConnect: true,
        });
        expect((await call(handler, { action: "read", plugin: "sample", url })).status).toBe(401);
        const begin = await call(handler, { action: "connect", plugin: "sample" });
        const cookie = begin.headers["set-cookie"]?.split(";")[0];
        const authorization = new URL(JSON.parse(begin.body).url);
        const approved = await call(handler, undefined, {
            method: "GET",
            path: authorization.pathname + authorization.search,
            cookie,
        });
        expect(approved.status).toBe(303);
        const redirect = new URL(approved.headers.location ?? "");
        expect(
            (
                await call(handler, undefined, {
                    method: "GET",
                    path: redirect.pathname + redirect.search,
                    cookie,
                })
            ).status,
        ).toBe(200);
        const response = await call(handler, { action: "read", plugin: "sample", url }, { cookie });
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body)).toMatchObject({
            user: { name: "Alice (mock)" },
            view: {
                blocks: expect.arrayContaining([
                    expect.objectContaining({
                        type: "heading",
                        text: "Preview external service URLs",
                    }),
                ]),
            },
        });
        expect(response.body).not.toContain("mock-access-");
        const real = createPluginHandler([definition]);
        expect(
            JSON.parse(
                (await call(real, { action: "resolve", url: "https://service.example/card" })).body,
            ),
        ).toEqual({ plugin: "sample" });
        expect(
            (
                await call(real, {
                    action: "read",
                    plugin: "sample",
                    url: "https://service.example/card",
                })
            ).status,
        ).toBe(401);
        expect(network).not.toHaveBeenCalled();
    });
    it("binds OAuth to an HttpOnly session, and serves private data only to that browser", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(JSON.stringify({ access_token: "secret-token" }))),
        );
        const handler = createPluginHandler([definition]);
        const begin = await call(handler, { action: "connect", plugin: "sample" });
        expect(begin.status).toBe(200);
        expect(begin.headers["set-cookie"]).toContain("HttpOnly; SameSite=Lax; Path=/api/plugins");
        const cookie = begin.headers["set-cookie"]?.split(";")[0];
        const authorize = new URL(JSON.parse(begin.body).url);
        const path = `/api/plugins/callback/sample?code=code&state=${authorize.searchParams.get("state")}`;
        expect((await call(handler, undefined, { method: "GET", path })).status).toBe(401);
        const complete = await call(handler, undefined, { method: "GET", path, cookie });
        expect(complete.status).toBe(200);
        expect(complete.body).not.toContain("secret-token");
        const read = await call(
            handler,
            { action: "read", plugin: "sample", url: "https://service.example/日本語" },
            { cookie },
        );
        expect(read.status).toBe(200);
        expect(JSON.parse(read.body).view.header.title).toBe("日本語");
        expect(read.headers["cache-control"]).toBe("no-store");
        expect(read.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
        expect(read.body).not.toContain("secret-token");
        expect(
            (
                await call(handler, {
                    action: "read",
                    plugin: "sample",
                    url: "https://service.example/card",
                    user: "alice",
                })
            ).status,
        ).toBe(401);
        expect(
            (await call(handler, { action: "disconnect", plugin: "sample" }, { cookie })).status,
        ).toBe(200);
        expect(
            (
                await call(
                    handler,
                    { action: "read", plugin: "sample", url: "https://service.example/card" },
                    { cookie },
                )
            ).status,
        ).toBe(401);
    });

    it("rejects cross-origin requests, DNS rebinding, incorrect ports, GET reads, and oversized bodies", async () => {
        const handler = createPluginHandler([definition]);
        const input = { action: "connect", plugin: "sample" };
        for (const options of [
            { origin: "https://attacker.example" },
            { origin: "null" },
            { host: "attacker.example:5179" },
            { host: "localhost:5180" },
            { method: "GET" },
        ])
            expect((await call(handler, input, options)).status).toBe(403);
        expect((await call(handler, { ...input, url: "x".repeat(70_000) })).status).toBe(413);
        expect((await call(handler, { action: "read", plugin: "sample", url: {} })).status).toBe(
            400,
        );
        expect((await call(handler, { action: "connect", plugin: "missing" })).status).toBe(404);
        expect((await call(handler, undefined, { path: "/ordinary-page" })).handled).toBe(false);
    });

    it("does not reflect provider errors or authorization codes into an error response", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(JSON.stringify({ access_token: "secret-token" }))),
        );
        const handler = createPluginHandler([
            {
                ...definition,
                identifyUser: async () => {
                    throw new Error("secret-token");
                },
            },
        ]);
        const begin = await call(handler, { action: "connect", plugin: "sample" });
        const state = new URL(JSON.parse(begin.body).url).searchParams.get("state");
        const response = await call(handler, undefined, {
            method: "GET",
            path: `/api/plugins/callback/sample?state=${state}&code=private-code`,
            cookie: begin.headers["set-cookie"]?.split(";")[0],
        });
        expect(response.status).toBe(502);
        expect(response.body).toBe('{"error":"Plugin request failed"}');
        expect(response.headers["referrer-policy"]).toBe("no-referrer");
    });
});

it("exchanges one-use terminal login tickets for browser-bound OAuth sessions", async () => {
    const handler = createPluginHandler([definition]);
    const link = new URL(handler.loginLink("sample", "http://localhost:5179"));
    const started = await call(handler, undefined, {
        method: "GET",
        path: link.pathname + link.search,
    });
    expect(started.status).toBe(303);
    expect(started.headers["set-cookie"]).toContain("HttpOnly; SameSite=Lax");
    const authorization = new URL(started.headers.location ?? "");
    expect(authorization.origin).toBe("https://oauth.example");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(
        (await call(handler, undefined, { method: "GET", path: link.pathname + link.search }))
            .status,
    ).toBe(400);
    const another = new URL(handler.loginLink("sample", "http://localhost:5179"));
    expect(
        (
            await call(handler, undefined, {
                method: "GET",
                path: another.pathname + another.search,
                host: "127.0.0.1:5179",
            })
        ).status,
    ).toBe(400);
    expect((await call(handler, { action: "status", plugin: "sample" })).body).toBe(
        '{"user":null}',
    );
});

it("keeps the automatic demo usable while the separate mock login is approved or cancelled", async () => {
    const network = vi.fn(() => {
        throw new Error("The demo must not use the network");
    });
    vi.stubGlobal("fetch", network);
    const config = await loadViewerPlugins(
        fileURLToPath(new URL("../../../examples/viewer-plugins/index.mjs", import.meta.url)),
    );
    const handler = createPluginHandler(config.plugins, config);
    const automaticUrl = "https://sample.dooc.invalid/tickets/DOC-42";
    const manualUrl = "https://auth.sample.dooc.invalid/tickets/DOC-42";
    expect(JSON.parse((await call(handler, { action: "resolve", url: manualUrl })).body)).toEqual({
        plugin: "sample-auth",
    });
    const begin = await call(handler, { action: "connect", plugin: "sample" });
    const cookie = begin.headers["set-cookie"]?.split(";")[0];
    const authorization = new URL(JSON.parse(begin.body).url);
    const approved = await call(handler, undefined, {
        method: "GET",
        path: authorization.pathname + authorization.search,
        cookie,
    });
    const redirect = new URL(approved.headers.location ?? "");
    expect(
        (
            await call(handler, undefined, {
                method: "GET",
                path: redirect.pathname + redirect.search,
                cookie,
            })
        ).status,
    ).toBe(200);
    for (const user of ["deny", "bob", "alice"]) {
        const start = await call(handler, { action: "connect", plugin: "sample-auth" }, { cookie });
        const url = new URL(JSON.parse(start.body).url);
        const path = url.pathname + url.search;
        const consent = await call(handler, undefined, { method: "GET", path, cookie });
        expect(consent.status).toBe(200);
        expect(consent.body).toContain("Authorize Bob (mock)");
        const transaction = /name="transaction" value="([^"]+)"/.exec(consent.body)?.[1] ?? "";
        const accepted = await call(
            handler,
            new URLSearchParams({ transaction, user }).toString(),
            { path, cookie, contentType: "application/x-www-form-urlencoded" },
        );
        const callback = new URL(accepted.headers.location ?? "");
        expect(callback.pathname).toBe("/api/plugins/callback/sample-auth");
        const returned = await call(handler, undefined, {
            method: "GET",
            path: callback.pathname + callback.search,
            cookie,
        });
        expect(returned.status).toBe(user === "deny" ? 400 : 200);
        if (user === "deny")
            expect(returned.body).toContain("Sign-in was not completed. No account was connected.");
        const manual = await call(
            handler,
            { action: "read", plugin: "sample-auth", url: manualUrl },
            { cookie },
        );
        expect(manual.status).toBe(user === "deny" ? 401 : 200);
        if (user !== "deny") expect(JSON.parse(manual.body).user.id).toBe(`mock-${user}`);
        const automatic = await call(
            handler,
            { action: "read", plugin: "sample", url: automaticUrl },
            { cookie },
        );
        expect(automatic.status).toBe(200);
        expect(JSON.parse(automatic.body).user.id).toBe("mock-alice");
    }
    expect(network).not.toHaveBeenCalled();
});
