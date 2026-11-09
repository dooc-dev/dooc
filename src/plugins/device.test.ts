import { afterEach, expect, it, vi } from "vitest";
import { createPluginRuntime } from "./runtime.js";
import type { DataPlugin } from "./types.js";

const definition: DataPlugin = {
    id: "device",
    oauth: {
        authorizationUrl: "https://service.example/authorize",
        deviceAuthorizationUrl: "https://service.example/device/code",
        tokenUrl: "https://service.example/token",
        clientId: "public-app",
        scopes: ["read", "write"],
    },
    apiOrigins: ["https://service.example"],
    matches: (url) => url.origin === "https://service.example",
    identifyUser: async () => ({ id: "alice", name: "Alice" }),
    read: async () => ({ blocks: [{ type: "text", text: "Connected" }] }),
};
const grant = {
    device_code: "private-device-code",
    user_code: "ABCD-EFGH",
    verification_uri: "https://service.example/device",
    expires_in: 900,
    interval: 5,
};
const setup = () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(grant));
    const runtime = createPluginRuntime([definition], transport);
    const session = runtime.createSession();
    return { transport, runtime, session };
};
afterEach(() => vi.useRealTimers());

it("connects a public client without secrets and obeys pending and slow-down intervals", async () => {
    const { transport, runtime, session } = setup();
    const state = await runtime.connectDevice(session, "device");
    expect(transport.mock.calls[0]?.[1]?.body?.toString()).toBe(
        "client_id=public-app&scope=read+write",
    );
    expect(await runtime.pollDevice(session, "device", state)).toEqual({
        userCode: grant.user_code,
        verificationUri: grant.verification_uri,
        retryAfter: 5,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    vi.setSystemTime(5000);
    transport.mockResolvedValueOnce(
        Response.json({ error: "authorization_pending" }, { status: 400 }),
    );
    expect((await runtime.pollDevice(session, "device", state))?.retryAfter).toBe(5);
    vi.setSystemTime(10_000);
    transport.mockResolvedValueOnce(
        Response.json({ error: "slow_down", interval: 12 }, { status: 400 }),
    );
    expect((await runtime.pollDevice(session, "device", state))?.retryAfter).toBe(12);
    vi.setSystemTime(15_000);
    expect((await runtime.pollDevice(session, "device", state))?.retryAfter).toBe(7);
    expect(transport).toHaveBeenCalledTimes(3);
    vi.setSystemTime(22_000);
    transport.mockResolvedValueOnce(
        Response.json({ access_token: "private-user-token", token_type: "bearer" }),
    );
    expect(await runtime.pollDevice(session, "device", state)).toBeUndefined();
    expect(runtime.status(session, "device")).toEqual({ id: "alice", name: "Alice" });
    for (const [, options] of transport.mock.calls.slice(1)) {
        const body = options?.body as URLSearchParams;
        expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
        expect(body.get("device_code")).toBe(grant.device_code);
        expect(body.has("client_secret")).toBe(false);
    }
    await expect(runtime.pollDevice(session, "device", state)).rejects.toThrow(
        "Invalid or expired",
    );
});

it("binds device authorization to its session and state, expires it, and rejects code callbacks", async () => {
    const { transport, runtime, session } = setup();
    const state = await runtime.connectDevice(session, "device");
    await expect(runtime.pollDevice(runtime.createSession(), "device", state)).rejects.toThrow();
    await expect(runtime.pollDevice(session, "device", "wrong")).rejects.toThrow();
    await expect(
        runtime.callback(
            session,
            "device",
            "http://localhost:5179/api/plugins/callback/device",
            new URLSearchParams({ state, code: "code" }),
        ),
    ).rejects.toThrow();
    expect(() =>
        runtime.connect(session, "device", "http://localhost:5179/api/plugins/callback/device"),
    ).toThrow("device authorization");
    vi.setSystemTime(900_001);
    await expect(runtime.pollDevice(session, "device", state)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
});

it.each([
    "access_denied",
    "expired_token",
    "device_flow_disabled",
])("stops polling after %s", async (error) => {
    const { transport, runtime, session } = setup();
    const state = await runtime.connectDevice(session, "device");
    vi.setSystemTime(5000);
    transport.mockResolvedValueOnce(Response.json({ error }, { status: 400 }));
    await expect(runtime.pollDevice(session, "device", state)).rejects.toThrow("not completed");
    vi.setSystemTime(10_000);
    await expect(runtime.pollDevice(session, "device", state)).rejects.toThrow(
        "Invalid or expired",
    );
    expect(transport).toHaveBeenCalledTimes(2);
    expect(runtime.status(session, "device")).toBeUndefined();
});

it("serializes polls and does not save a token after disconnecting", async () => {
    const { transport, runtime, session } = setup();
    const state = await runtime.connectDevice(session, "device");
    vi.setSystemTime(5000);
    let respond!: (response: Response) => void;
    transport.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                respond = resolve;
            }),
    );
    const pending = runtime.pollDevice(session, "device", state);
    expect((await runtime.pollDevice(session, "device", state))?.retryAfter).toBe(5);
    expect(transport).toHaveBeenCalledTimes(2);
    runtime.disconnect(session, "device");
    respond(Response.json({ access_token: "private-user-token" }));
    await expect(pending).rejects.toThrow("Connect this plugin again");
    expect(runtime.status(session, "device")).toBeUndefined();
});

it.each([
    { verification_uri: "http://service.example/device" },
    { verification_uri: "https://user:password@service.example/device" },
    { device_code: "" },
    { user_code: "" },
    { expires_in: 0 },
    { expires_in: 3601 },
    { interval: 0 },
    { interval: "5" },
])("rejects invalid device grants: %j", async (invalid) => {
    const { transport, runtime, session } = setup();
    transport.mockReset().mockResolvedValueOnce(Response.json({ ...grant, ...invalid }));
    await expect(runtime.connectDevice(session, "device")).rejects.toThrow();
    expect(runtime.status(session, "device")).toBeUndefined();
});

it("rejects insecure device endpoints and shared client secrets", () => {
    for (const oauth of [
        { ...definition.oauth, deviceAuthorizationUrl: "http://service.example/device" },
        {
            ...definition.oauth,
            deviceAuthorizationUrl: "https://service.example/device?client_secret=secret",
        },
        { ...definition.oauth, clientSecret: "shared-secret" },
    ])
        expect(() => createPluginRuntime([{ ...definition, oauth }])).toThrow();
});
