import {
    chmodSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { DataPlugin } from "../../../../plugins/src/types.js";
import { createLocalPluginStorage } from "./local-storage.js";
import { createPluginRuntime } from "./runtime.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-personal-test-"));
    roots.push(root);
    const store = createLocalPluginStorage(root);
    const plugin: DataPlugin = {
        id: "example",
        matches: () => true,
        oauth: {
            authorizationUrl: "https://example.com/authorize",
            tokenUrl: "https://example.com/token",
            clientId: "test",
            scopes: ["read"],
        },
        apiOrigins: ["https://example.com"],
        identifyUser: async () => ({ id: "tenant/alice", name: "Alice" }),
        read: async (_url, { request }) => ({
            blocks: [
                { type: "code", text: JSON.stringify(await request("https://example.com/item")) },
            ],
        }),
    };
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
        if (init?.body instanceof URLSearchParams)
            return new Response(
                JSON.stringify({
                    access_token:
                        init.body.get("grant_type") === "refresh_token"
                            ? "refreshed-secret"
                            : "initial-secret",
                    refresh_token: "refresh-secret",
                    expires_in: 3600,
                }),
            );
        return new Response(
            JSON.stringify({ authorization: new Headers(init?.headers).get("authorization") }),
        );
    });
    const makeRuntime = () => createPluginRuntime([plugin], transport, store.credentials);
    const connect = async (runtime: ReturnType<typeof makeRuntime>) => {
        const session = runtime.createSession(),
            redirect = "http://localhost:5179/api/plugins/callback/example";
        const url = new URL(runtime.connect(session, plugin.id, redirect));
        await runtime.callback(
            session,
            plugin.id,
            redirect,
            new URLSearchParams({ state: url.searchParams.get("state") ?? "", code: "code" }),
        );
        return session;
    };
    return { root, store, plugin, transport, makeRuntime, connect };
};
it("persists private per-user tokens across restarts and clears them on logout", async () => {
    const { root, store, plugin, makeRuntime, connect } = fixture();
    const first = makeRuntime();
    const session = await connect(first);
    expect(first.status(session, "example")).toEqual({ id: "tenant/alice", name: "Alice" });
    const file = join(root, "plugins", readdirSync(join(root, "plugins"))[0] ?? "");
    expect(readFileSync(file, "utf8")).toContain("initial-secret");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const restarted = makeRuntime(),
        next = restarted.createSession();
    expect(restarted.status(next, "example")?.name).toBe("Alice");
    await expect(
        restarted.read(next, "example", "https://example.com/item"),
    ).resolves.toMatchObject({
        view: {
            blocks: [
                { type: "code", text: JSON.stringify({ authorization: "Bearer initial-secret" }) },
            ],
        },
    });
    restarted.disconnect(next, "example");
    expect(store.credentials.get(plugin)).toBeUndefined();
    await expect(first.read(session, "example", "https://example.com/item")).rejects.toMatchObject({
        status: 401,
    });
});
it("serializes rotating refresh tokens across runtimes and persists the refreshed token", async () => {
    const { store, plugin, transport, makeRuntime, connect } = fixture();
    const first = makeRuntime(),
        session = await connect(first);
    const saved = store.credentials.get(plugin);
    if (!saved) throw new Error("Missing fixture login");
    store.credentials.set(plugin, { ...saved, expires: Date.now() - 1 });
    const second = makeRuntime(),
        third = makeRuntime();
    await Promise.all([
        second.read(second.createSession(), "example", "https://example.com/item"),
        third.read(third.createSession(), "example", "https://example.com/item"),
    ]);
    expect(
        transport.mock.calls.filter(
            ([, init]) =>
                init?.body instanceof URLSearchParams &&
                init.body.get("grant_type") === "refresh_token",
        ),
    ).toHaveLength(1);
    expect(store.credentials.get(plugin)?.token.access_token).toBe("refreshed-secret");
    first.disconnect(session, "example");
});
it("isolates OAuth configurations and refuses symlinked or public credential files", async () => {
    const { root, store, plugin, makeRuntime, connect } = fixture();
    await connect(makeRuntime());
    expect(
        store.credentials.get({ ...plugin, oauth: { ...plugin.oauth, clientId: "other" } }),
    ).toBeUndefined();
    const file = join(root, "plugins", readdirSync(join(root, "plugins"))[0] ?? "");
    if (process.platform !== "win32") {
        chmodSync(file, 0o644);
        expect(() => store.credentials.get(plugin)).toThrow("private");
    }
    rmSync(file);
    symlinkSync("/etc/passwd", file);
    expect(() => store.credentials.get(plugin)).toThrow("private");
});
