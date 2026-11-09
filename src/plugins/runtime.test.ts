import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginError, parseOAuthToken, validatePlugins } from "./oauth.js";
import { createPluginRuntime } from "./runtime.js";
import type { DataPlugin, PluginUser } from "./types.js";

const callback = "http://localhost:5179/api/plugins/callback/example";
const plugin = (extra: Partial<DataPlugin> = {}): DataPlugin => ({
    id: "example",
    matches: (url) => url.origin === "https://service.example",
    oauth: {
        authorizationUrl: "https://service.example/authorize",
        tokenUrl: "https://service.example/token",
        clientId: "client",
        scopes: ["read"],
    },
    apiOrigins: ["https://api.example"],
    identifyUser: async ({ request }) => (await request("https://api.example/me")) as PluginUser,
    read: async (url, { request }) => ({
        blocks: [
            {
                type: "code",
                text: JSON.stringify(await request(`https://api.example${url.pathname}`)),
            },
        ],
    }),
    ...extra,
});
const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status });
const mockService = () => {
    const fetcher = vi.fn(async (source: string, init: RequestInit) => {
        if (source.endsWith("/token"))
            return json({
                access_token: `token-${(init.body as URLSearchParams).get("code")}`,
                refresh_token: "refresh",
                expires_in: 3600,
            });
        const token = new Headers(init.headers).get("authorization");
        return source.endsWith("/me")
            ? json({ id: token?.replace("Bearer token-", ""), name: "Reader" })
            : json({ item: "Private data" });
    });
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
};
const connect = async (
    runtime: ReturnType<typeof createPluginRuntime>,
    session: string,
    code = "alice",
    pluginId = "example",
) => {
    const target = callback.replace("/example", `/${pluginId}`);
    const url = new URL(runtime.connect(session, pluginId, target));
    await runtime.callback(
        session,
        pluginId,
        target,
        new URLSearchParams({ state: url.searchParams.get("state") ?? "", code }),
    );
    return url;
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("user OAuth plugin runtime", () => {
    it("rejects writes for read-only plugins", async () => {
        mockService();
        const runtime = createPluginRuntime([plugin()]);
        const session = runtime.createSession();
        await connect(runtime, session);
        const source = "https://service.example/item";
        expect((await runtime.actions(session, "example", source)).actions).toEqual([]);
        await expect(
            runtime.act(
                session,
                "example",
                source,
                { id: "edit", values: {} },
                "request-000000001",
            ),
        ).rejects.toMatchObject({ status: 403 });
    });

    it("continues queued writes after failure and preserves plugin method context", async () => {
        mockService();
        const events: string[] = [];
        let writes = 0;
        const runtime = createPluginRuntime([
            plugin({
                async actions(this: DataPlugin) {
                    events.push(`actions:${this.id}`);
                    return [{ id: "edit", label: "Edit", target: "Item", fields: [] }];
                },
                async act(this: DataPlugin) {
                    const attempt = ++writes;
                    events.push(`start:${attempt}:${this.id}`);
                    await setTimeout(0);
                    events.push(`end:${attempt}`);
                    if (attempt === 1) throw new PluginError(502, "Write outcome unknown");
                    return { message: "Saved" };
                },
            }),
        ]);
        const session = runtime.createSession();
        await connect(runtime, session);
        const write = (requestId: string) =>
            runtime.act(
                session,
                "example",
                "https://service.example/item",
                { id: "edit", values: {} },
                requestId,
            );
        const results = await Promise.allSettled([
            write("request-000000001"),
            write("request-000000002"),
        ]);
        expect(results[0]).toMatchObject({ status: "rejected", reason: { status: 502 } });
        expect(results[1]).toMatchObject({
            status: "fulfilled",
            value: { result: { message: "Saved" } },
        });
        expect(events).toEqual([
            "actions:example",
            "start:1:example",
            "end:1",
            "actions:example",
            "start:2:example",
            "end:2",
        ]);
        await expect(write("request-000000001")).rejects.toMatchObject({ status: 502 });
        expect(writes).toBe(2);
    });

    it("authorizes and validates actions, serializes writes and deduplicates retries", async () => {
        mockService();
        let version = "one";
        const act = vi.fn(async (_url, { request }, input) => {
            await request("https://api.example/item", { method: "PATCH", body: input.values });
            version = "two";
            return { message: "Saved" };
        });
        const runtime = createPluginRuntime([
            plugin({
                actions: async () => [
                    {
                        id: "edit",
                        label: "Edit",
                        target: "Item",
                        version,
                        fields: [{ name: "title", label: "Title", type: "text", required: true }],
                    },
                ],
                act,
            }),
        ]);
        const session = runtime.createSession();
        await connect(runtime, session);
        const source = "https://service.example/item";
        const input = { id: "edit", version: "one", values: { title: "New title" } };
        await expect(
            runtime.act(
                session,
                "example",
                source,
                { ...input, id: "delete" },
                "request-000000001",
            ),
        ).rejects.toMatchObject({ status: 403 });
        await expect(
            runtime.act(
                session,
                "example",
                source,
                { ...input, values: { title: "" } },
                "request-000000002",
            ),
        ).rejects.toMatchObject({ status: 400 });
        const results = await Promise.all([
            runtime.act(session, "example", source, input, "request-000000003"),
            runtime.act(session, "example", source, input, "request-000000003"),
        ]);
        expect(results[0]).toEqual(results[1]);
        expect(act).toHaveBeenCalledTimes(1);
        await expect(
            runtime.act(session, "example", source, input, "request-000000004"),
        ).rejects.toMatchObject({ status: 409 });
        await expect(
            runtime.act(
                session,
                "example",
                source,
                { ...input, values: { title: "Other" } },
                "request-000000003",
            ),
        ).rejects.toMatchObject({ status: 409 });
        runtime.disconnect(session, "example");
        await expect(runtime.actions(session, "example", source)).rejects.toMatchObject({
            status: 401,
        });
    });

    it("keeps failed writes idempotent and requires explicit confirmation for destructive actions", async () => {
        mockService();
        const act = vi.fn(async () => {
            throw new PluginError(502, "Write outcome unknown");
        });
        const runtime = createPluginRuntime([
            plugin({
                actions: async () => [
                    {
                        id: "delete",
                        label: "Delete",
                        target: "Item",
                        destructive: true,
                        fields: [],
                    },
                ],
                act,
            }),
        ]);
        const session = runtime.createSession();
        await connect(runtime, session);
        const source = "https://service.example/item",
            input = { id: "delete", values: {} };
        await expect(
            runtime.act(session, "example", source, input, "request-000000001"),
        ).rejects.toMatchObject({ status: 400 });
        for (let i = 0; i < 2; i++)
            await expect(
                runtime.act(
                    session,
                    "example",
                    source,
                    { ...input, confirmed: true },
                    "request-000000002",
                ),
            ).rejects.toMatchObject({ status: 502 });
        expect(act).toHaveBeenCalledTimes(1);
    });

    it("prevents a delayed operation from sending requests after disconnect", async () => {
        mockService();
        let release: () => void = () => {};
        let ready: () => void = () => {};
        const entered = new Promise<void>((resolve) => {
            ready = resolve;
        });
        const pause = new Promise<void>((resolve) => {
            release = resolve;
        });
        const runtime = createPluginRuntime([
            plugin({
                actions: async () => [{ id: "edit", label: "Edit", target: "Item", fields: [] }],
                act: async (_url, { request }) => {
                    ready();
                    await pause;
                    await request("https://api.example/item", { method: "DELETE" });
                    return { message: "Deleted" };
                },
            }),
        ]);
        const session = runtime.createSession();
        await connect(runtime, session);
        const pending = runtime.act(
            session,
            "example",
            "https://service.example/item",
            { id: "edit", values: {} },
            "request-000000001",
        );
        await entered;
        runtime.disconnect(session, "example");
        release();
        await expect(pending).rejects.toMatchObject({ status: 401 });
    });
    it("matches URLs without fetching and rejects mismatched reads even for connected users", async () => {
        const fetcher = mockService();
        const read = vi.fn(async (url: URL) => ({
            blocks: [{ type: "code" as const, text: url.href }],
        }));
        const runtime = createPluginRuntime([plugin({ read })]);
        const source = "https://service.example/pulls/17?view=full#comment-7";
        expect(runtime.resolve(source)).toBe("example");
        expect(runtime.resolve("https://other.example/pulls/17")).toBeUndefined();
        expect(() => runtime.resolve("https://user:secret@service.example/pulls/17")).toThrow();
        expect(fetcher).not.toHaveBeenCalled();
        const session = runtime.createSession();
        await connect(runtime, session);
        await expect(
            runtime.read(session, "example", "https://other.example/pulls/17"),
        ).rejects.toMatchObject({ status: 400 });
        expect(read).not.toHaveBeenCalled();
        const result = await runtime.read(session, "example", source);
        expect(result.view).toEqual({ blocks: [{ type: "code", text: source }] });
        expect(read.mock.calls[0]?.[0]).toBeInstanceOf(URL);
    });

    it("registers and replaces plugins while preserving other connections", async () => {
        mockService();
        const runtime = createPluginRuntime([]);
        const session = runtime.createSession();
        runtime.register(plugin());
        runtime.register(plugin({ id: "other" }));
        await connect(runtime, session);
        await connect(runtime, session, "bob", "other");
        expect(() => runtime.register(plugin({ apiOrigins: ["http://unsafe.example"] }))).toThrow();
        await expect(
            runtime.read(session, "example", "https://service.example/items/one"),
        ).resolves.toHaveProperty("view");
        const pending = runtime.read(session, "example", "https://service.example/items/one");
        runtime.register(plugin());
        await expect(pending).rejects.toMatchObject({ status: 401 });
        await expect(
            runtime.read(session, "example", "https://service.example/items/one"),
        ).rejects.toMatchObject({
            status: 401,
        });
        await expect(
            runtime.read(session, "other", "https://service.example/items/one"),
        ).resolves.toHaveProperty("user.id", "bob");
        await connect(runtime, session);
        await expect(
            runtime.read(session, "example", "https://service.example/items/one"),
        ).resolves.toHaveProperty("view");
        runtime.unregister("example");
        await expect(
            runtime.read(session, "example", "https://service.example/items/one"),
        ).rejects.toMatchObject({
            status: 404,
        });
    });

    it("invalidates pending authorization and old request contexts even when the same definition is registered again", async () => {
        const fetcher = mockService();
        let finishUser!: (user: PluginUser) => void;
        const user = new Promise<PluginUser>((resolve) => {
            finishUser = resolve;
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const definition = plugin({
            identifyUser: () => user,
            read: async (_resource, { request }) => {
                await gate;
                return {
                    blocks: [
                        {
                            type: "code",
                            text: JSON.stringify(await request("https://api.example/items/one")),
                        },
                    ],
                };
            },
        });
        const runtime = createPluginRuntime([definition]);
        const session = runtime.createSession();
        const authorizing = connect(runtime, session);
        runtime.unregister("example");
        runtime.register(definition);
        finishUser({ id: "alice", name: "Alice" });
        await expect(authorizing).rejects.toMatchObject({ status: 401 });
        await connect(runtime, session);
        const pending = runtime.read(session, "example", "https://service.example/items/one");
        runtime.unregister("example");
        runtime.register(definition);
        const calls = fetcher.mock.calls.length;
        release();
        await expect(pending).rejects.toMatchObject({ status: 401 });
        expect(fetcher).toHaveBeenCalledTimes(calls);
    });

    it("exchanges a browser-bound code with S256 PKCE and never returns credentials", async () => {
        const fetcher = mockService();
        const runtime = createPluginRuntime([plugin()]);
        const session = runtime.createSession();
        const url = await connect(runtime, session);
        const request = fetcher.mock.calls[0]?.[1];
        const body = request?.body as URLSearchParams;
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("redirect_uri")).toBe(callback);
        expect(body.get("client_id")).toBe("client");
        expect(
            createHash("sha256")
                .update(body.get("code_verifier") ?? "")
                .digest("base64url"),
        ).toBe(url.searchParams.get("code_challenge"));
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        const result = await runtime.read(session, "example", "https://service.example/items/one");
        expect(result.view).toEqual({
            blocks: [{ type: "code", text: JSON.stringify({ item: "Private data" }) }],
        });
        expect(result).not.toHaveProperty("token");
        expect(JSON.stringify(result)).not.toContain("token-alice");
        for (const [, init] of fetcher.mock.calls) {
            expect(init.redirect).toBe("error");
            expect(init.cache).toBe("no-store");
            expect(init.signal).toBeInstanceOf(AbortSignal);
        }
    });

    it("rejects wrong sessions, state replay, changed callbacks, and expired state", async () => {
        const fetcher = mockService();
        const runtime = createPluginRuntime([plugin()]);
        const alice = runtime.createSession();
        const bob = runtime.createSession();
        const url = new URL(runtime.connect(alice, "example", callback));
        const params = new URLSearchParams({
            state: url.searchParams.get("state") ?? "",
            code: "alice",
        });
        await expect(runtime.callback(bob, "example", callback, params)).rejects.toMatchObject({
            status: 400,
        });
        await expect(
            runtime.callback(alice, "example", callback.replace("5179", "5180"), params),
        ).rejects.toMatchObject({ status: 400 });
        expect(fetcher).not.toHaveBeenCalled();
        await runtime.callback(alice, "example", callback, params);
        await expect(runtime.callback(alice, "example", callback, params)).rejects.toMatchObject({
            status: 400,
        });
        const second = new URL(runtime.connect(alice, "example", callback));
        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + 11 * 60_000);
        await expect(
            runtime.callback(
                alice,
                "example",
                callback,
                new URLSearchParams({
                    state: second.searchParams.get("state") ?? "",
                    code: "again",
                }),
            ),
        ).rejects.toMatchObject({ status: 400 });
    });

    it("keeps users separate, fetches afresh, and forgets only the selected connection", async () => {
        const fetcher = mockService();
        const runtime = createPluginRuntime([plugin()]);
        const alice = runtime.createSession();
        const bob = runtime.createSession();
        await connect(runtime, alice, "alice");
        await expect(
            runtime.read(bob, "example", "https://service.example/items/one"),
        ).rejects.toMatchObject({ status: 401 });
        await connect(runtime, bob, "bob");
        await runtime.read(alice, "example", "https://service.example/items/one");
        await runtime.read(bob, "example", "https://service.example/items/one");
        await runtime.read(alice, "example", "https://service.example/items/one");
        const requests = fetcher.mock.calls.filter(([url]) => url.includes("/items/"));
        expect(requests.map(([, init]) => new Headers(init.headers).get("authorization"))).toEqual([
            "Bearer token-alice",
            "Bearer token-bob",
            "Bearer token-alice",
        ]);
        runtime.disconnect(alice, "example");
        await expect(
            runtime.read(alice, "example", "https://service.example/items/one"),
        ).rejects.toMatchObject({ status: 401 });
        await expect(
            runtime.read(bob, "example", "https://service.example/items/one"),
        ).resolves.toHaveProperty("view");
    });

    it("refreshes an expiring token once for concurrent reads and uses the rotated token", async () => {
        const fetcher = mockService();
        fetcher.mockImplementationOnce(async () =>
            json({ access_token: "old", refresh_token: "refresh-old", expires_in: 1 }),
        );
        const runtime = createPluginRuntime([plugin()]);
        const session = runtime.createSession();
        await connect(runtime, session);
        fetcher.mockImplementationOnce(async (_url, init) => {
            expect((init.body as URLSearchParams).get("refresh_token")).toBe("refresh-old");
            return json({ access_token: "new", refresh_token: "refresh-new", expires_in: 3600 });
        });
        await Promise.all([
            runtime.read(session, "example", "https://service.example/items/one"),
            runtime.read(session, "example", "https://service.example/items/two"),
        ]);
        expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/token"))).toHaveLength(2);
        for (const [, init] of fetcher.mock.calls.filter(([url]) => url.includes("/items/")))
            expect(new Headers(init.headers).get("authorization")).toBe("Bearer new");
    });

    it("allows token refresh to be retried after a temporary failure", async () => {
        const fetcher = mockService();
        fetcher.mockImplementationOnce(async () =>
            json({ access_token: "old", refresh_token: "refresh-old", expires_in: 1 }),
        );
        const runtime = createPluginRuntime([plugin()]);
        const session = runtime.createSession();
        await connect(runtime, session);
        const read = () => runtime.read(session, "example", "https://service.example/items/one");
        fetcher.mockImplementationOnce(async () => json({ error: "Unavailable" }, 503));
        await expect(read()).rejects.toMatchObject({ status: 502 });
        fetcher.mockImplementationOnce(async () => json({ access_token: "new", expires_in: 3600 }));
        await expect(read()).resolves.toHaveProperty("view");
        expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/token"))).toHaveLength(3);
    });

    it("cannot restore a connection or return stale results after disconnect", async () => {
        mockService();
        let finishUser: ((value: PluginUser) => void) | undefined;
        const identity = new Promise<PluginUser>((resolve) => {
            finishUser = resolve;
        });
        const runtime = createPluginRuntime([plugin({ identifyUser: () => identity })]);
        const session = runtime.createSession();
        const pending = connect(runtime, session);
        runtime.disconnect(session, "example");
        finishUser?.({ id: "alice", name: "Alice" });
        await expect(pending).rejects.toMatchObject({ status: 401 });
        await connect(runtime, session);
        const read = runtime.read(session, "example", "https://service.example/items/one");
        runtime.disconnect(session, "example");
        await expect(read).rejects.toMatchObject({ status: 401 });
    });

    it("rejects API origins outside the registration before sending credentials", async () => {
        const fetcher = mockService();
        const runtime = createPluginRuntime([
            plugin({
                read: async (_resource, { request }) => ({
                    blocks: [
                        {
                            type: "code",
                            text: JSON.stringify(await request("https://attacker.example/data")),
                        },
                    ],
                }),
            }),
        ]);
        const session = runtime.createSession();
        await connect(runtime, session);
        await expect(
            runtime.read(session, "example", "https://service.example/items/one"),
        ).rejects.toMatchObject({
            status: 400,
        });
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("clears revoked credentials, preserves a connection on forbidden data, and hides upstream bodies", async () => {
        const fetcher = mockService();
        const runtime = createPluginRuntime([plugin()]);
        const session = runtime.createSession();
        await connect(runtime, session);
        fetcher.mockImplementationOnce(async () => json({ error: "SECRET" }, 403));
        await expect(
            runtime.read(session, "example", "https://service.example/items/one"),
        ).rejects.toMatchObject({
            status: 403,
            message: "Access denied by the service",
        });
        await expect(
            runtime.read(session, "example", "https://service.example/items/two"),
        ).resolves.toHaveProperty("view");
        fetcher.mockImplementationOnce(async () => json({ error: "SECRET" }, 401));
        await expect(
            runtime.read(session, "example", "https://service.example/items/one"),
        ).rejects.toMatchObject({
            status: 401,
        });
        const calls = fetcher.mock.calls.length;
        await expect(
            runtime.read(session, "example", "https://service.example/items/one"),
        ).rejects.toMatchObject({
            status: 401,
        });
        expect(fetcher).toHaveBeenCalledTimes(calls);
    });

    it("lets adapters select user tokens without overriding state or PKCE", async () => {
        const fetcher = mockService();
        const definition = plugin();
        definition.oauth = {
            ...definition.oauth,
            scopeParameter: "user_scope",
            scopeSeparator: ",",
            scopes: ["one", "two"],
            authorizationParams: { actor: "user" },
            parseToken: (response) => parseOAuthToken((response as { user: unknown }).user),
        };
        fetcher.mockImplementationOnce(async () =>
            json({ access_token: "BOT", user: { access_token: "USER" } }),
        );
        const runtime = createPluginRuntime([definition]);
        const session = runtime.createSession();
        const url = await connect(runtime, session);
        expect(url.searchParams.get("user_scope")).toBe("one,two");
        expect(url.searchParams.get("actor")).toBe("user");
        expect(new Headers(fetcher.mock.calls[1]?.[1].headers).get("authorization")).toBe(
            "Bearer USER",
        );
        definition.oauth.authorizationParams = { state: "fixed" };
        expect(() => validatePlugins([definition])).toThrow("security parameters");
    });

    it("rejects malformed registrations, tokens, oversized responses, and API error bodies", async () => {
        expect(() => validatePlugins([plugin(), plugin()])).toThrow("unique");
        expect(() => validatePlugins([plugin({ apiOrigins: ["http://localhost"] })])).toThrow(
            "HTTPS",
        );
        expect(() => validatePlugins([plugin({ name: " " })])).toThrow("invalid plugin");
        expect(() =>
            validatePlugins([plugin({ icon: { light: "https://example.com/icon.svg" } })]),
        ).toThrow("invalid plugin");
        expect(() => parseOAuthToken({ access_token: "secret\r\nInjected: true" })).toThrow();
        expect(() => parseOAuthToken({ access_token: "bot", token_type: "bot" })).toThrow();
        const fetcher = mockService();
        const runtime = createPluginRuntime([plugin()]);
        const session = runtime.createSession();
        await connect(runtime, session);
        fetcher.mockImplementationOnce(async () => json("x".repeat(2 * 1024 * 1024)));
        await expect(
            runtime.read(session, "example", "https://service.example/items/one"),
        ).rejects.toMatchObject({
            status: 502,
        });
        fetcher.mockImplementationOnce(async () => {
            throw new Error("secret in network error");
        });
        await expect(
            runtime.read(session, "example", "https://service.example/items/one"),
        ).rejects.toEqual(new PluginError(502, "Plugin service request failed"));
    });
});
