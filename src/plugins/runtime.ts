import { createHash, randomBytes } from "node:crypto";
import {
    type PluginActionContext,
    type PluginActionResult,
    validatePluginActionRequest,
    validatePluginActions,
    validatePluginActionValues,
} from "./actions.js";
import type { PluginCredentialStore } from "./local-storage.js";
import {
    fetchPluginJson,
    httpsUrl,
    isPluginError,
    PluginError,
    parseOAuthToken,
    validatePlugins,
} from "./oauth.js";
import type { DataPlugin, OAuthToken, PluginUser } from "./types.js";
import { parsePluginUrl, validatePluginView } from "./view.js";

interface Connection {
    token: OAuthToken;
    expires: number;
    user: PluginUser;
    refreshing?: Promise<void>;
    operations?: Map<string, { fingerprint: string; promise: Promise<PluginActionResult> }>;
    writing?: Promise<PluginActionResult>;
}

interface Attempt {
    state: string;
    verifier: string;
    redirectUri: string;
    expires: number;
}

interface DeviceAttempt {
    state: string;
    expires: number;
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    interval: number;
    nextPoll: number;
    polling: boolean;
}

interface Session {
    expires: number;
    connections: Map<string, Connection>;
    attempts: Map<string, Attempt | DeviceAttempt>;
}

const nonce = (): string => randomBytes(32).toString("base64url");
const expired = (): PluginError => new PluginError(401, "Connect this plugin again");
const expiry = (token: OAuthToken): number =>
    token.expires_in === undefined ? Infinity : Date.now() + token.expires_in * 1000;

export const createPluginRuntime = (
    definitions: readonly DataPlugin[],
    transport?: typeof fetch,
    credentials?: PluginCredentialStore,
) => {
    const plugins = new Map(validatePlugins(definitions).map((plugin) => [plugin.id, plugin]));
    // Browser sessions expire independently of optional personal credential persistence.
    const sessions = new Map<string, Session>();
    const sessionFor = (id: string): Session => {
        const session = sessions.get(id);
        if (!session || session.expires <= Date.now()) {
            sessions.delete(id);
            throw expired();
        }
        return session;
    };
    const pluginFor = (id: string): DataPlugin => {
        const plugin = plugins.get(id);
        if (!plugin) throw new PluginError(404, "Plugin is not configured");
        return plugin;
    };
    const tokenFrom = (plugin: DataPlugin, result: unknown): OAuthToken => {
        if (
            !result ||
            typeof result !== "object" ||
            "error" in result ||
            ("ok" in result && result.ok === false)
        ) {
            if (
                result &&
                typeof result === "object" &&
                "error" in result &&
                result.error === "invalid_grant"
            )
                throw expired();
            throw new PluginError(502, "OAuth exchange failed");
        }
        try {
            return parseOAuthToken(
                plugin.oauth.parseToken ? plugin.oauth.parseToken(result) : result,
            );
        } catch {
            throw new PluginError(502, "Invalid OAuth token response");
        }
    };
    const exchange = async (
        plugin: DataPlugin,
        fields: Record<string, string>,
    ): Promise<OAuthToken> => {
        const { oauth } = plugin;
        const body = new URLSearchParams({ ...fields, client_id: oauth.clientId });
        if (oauth.clientSecret) body.set("client_secret", oauth.clientSecret);
        const result = await fetchPluginJson(
            oauth.tokenUrl,
            {
                method: "POST",
                body,
                headers: { accept: "application/json" },
            },
            true,
            transport,
        );
        return tokenFrom(plugin, result);
    };
    const context = (
        plugin: DataPlugin,
        accessToken: string,
        write = false,
        check = () => {},
    ): Omit<PluginActionContext, "user"> => ({
        request: async (source, init) => {
            check();
            if (plugins.get(plugin.id) !== plugin) throw expired();
            const url = httpsUrl(source);
            if (!plugin.apiOrigins.includes(url.origin))
                throw new PluginError(400, "Plugin API origin is not allowed");
            if (
                init?.method !== undefined &&
                !(write ? ["GET", "POST", "PUT", "PATCH", "DELETE"] : ["GET", "POST"]).includes(
                    init.method,
                )
            )
                throw new PluginError(400, "Invalid plugin request method");
            return fetchPluginJson(
                url.href,
                {
                    method: init?.method ?? "GET",
                    headers: {
                        authorization: `Bearer ${accessToken}`,
                        accept: "application/json",
                        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
                    },
                    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
                },
                false,
                transport,
            );
        },
    });
    const assertCurrent = (id: string, pluginId: string, connection: Connection): void => {
        if (sessionFor(id).connections.get(pluginId) !== connection) throw expired();
    };
    const begin = (id: string, plugin: DataPlugin, attempt: Attempt | DeviceAttempt): void => {
        const session = sessionFor(id);
        session.connections.delete(plugin.id);
        credentials?.set(plugin);
        if (credentials) for (const other of sessions.values()) other.connections.delete(plugin.id);
        session.attempts.set(plugin.id, attempt);
    };
    const complete = async (
        id: string,
        plugin: DataPlugin,
        attempt: Attempt | DeviceAttempt,
        token: OAuthToken,
    ): Promise<void> => {
        const expires = expiry(token);
        const user = await plugin.identifyUser(context(plugin, token.access_token));
        if (
            !user ||
            typeof user.id !== "string" ||
            !user.id ||
            typeof user.name !== "string" ||
            !user.name ||
            user.id.length > 512 ||
            user.name.length > 512
        )
            throw new PluginError(502, "Plugin could not identify the authorized user");
        const session = sessionFor(id);
        if (session.attempts.get(plugin.id) !== attempt || attempt.expires <= Date.now())
            throw expired();
        session.attempts.delete(plugin.id);
        const connection = { token, expires, user: { id: user.id, name: user.name } };
        credentials?.set(plugin, connection);
        session.connections.set(plugin.id, connection);
    };
    const unregister = (pluginId: string): void => {
        plugins.delete(pluginId);
        for (const session of sessions.values()) {
            session.connections.delete(pluginId);
            session.attempts.delete(pluginId);
        }
    };
    const access = async <T>(
        id: string,
        pluginId: string,
        source: unknown,
        run: (plugin: DataPlugin, url: URL, connection: Connection) => Promise<T>,
    ): Promise<T> => {
        let url: URL;
        try {
            url = parsePluginUrl(source);
        } catch {
            throw new PluginError(400, "Invalid service URL");
        }
        const session = sessionFor(id);
        const plugin = pluginFor(pluginId);
        if (!plugin.matches(url)) throw new PluginError(400, "URL is not supported by this plugin");
        let restored = session.connections.get(pluginId);
        if (credentials) {
            const saved = credentials.get(plugin);
            if (!saved) {
                session.connections.delete(pluginId);
                throw expired();
            }
            if (!restored || restored.user.id !== saved.user.id) {
                restored = saved;
                session.connections.set(pluginId, restored);
            } else if (restored.token.access_token !== saved.token.access_token) {
                restored.token = saved.token;
                restored.expires = saved.expires;
            }
        }
        if (!restored) throw expired();
        const connection = restored;
        try {
            if (connection.expires <= Date.now() + 30_000) {
                const refreshToken = connection.token.refresh_token;
                if (!refreshToken) throw expired();
                connection.refreshing ??= (async () => {
                    const refresh = async () => {
                        const saved = credentials?.get(plugin);
                        if (credentials && (!saved || saved.user.id !== connection.user.id))
                            throw expired();
                        if (saved && saved.token.access_token !== connection.token.access_token) {
                            connection.token = saved.token;
                            connection.expires = saved.expires;
                            if (connection.expires > Date.now() + 30_000) return;
                        }
                        const previous = connection.token.access_token;
                        const usedRefresh = connection.token.refresh_token ?? refreshToken;
                        const token = await exchange(plugin, {
                            grant_type: "refresh_token",
                            refresh_token: usedRefresh,
                        });
                        assertCurrent(id, pluginId, connection);
                        if (credentials && credentials.get(plugin)?.token.access_token !== previous)
                            throw expired();
                        connection.token = {
                            ...token,
                            refresh_token: token.refresh_token ?? usedRefresh,
                            scope: token.scope ?? connection.token.scope,
                        };
                        connection.expires = expiry(token);
                        credentials?.set(plugin, connection);
                    };
                    try {
                        await (credentials?.withLock
                            ? credentials.withLock(plugin, refresh)
                            : refresh());
                    } finally {
                        connection.refreshing = undefined;
                    }
                })();
                await connection.refreshing;
            }
            assertCurrent(id, pluginId, connection);
            const result = await run(plugin, url, connection);
            assertCurrent(id, pluginId, connection);
            return result;
        } catch (error) {
            if (
                isPluginError(error) &&
                error.status === 401 &&
                session.connections.get(pluginId) === connection
            ) {
                session.connections.delete(pluginId);
                const saved = credentials?.get(plugin);
                if (saved?.token.access_token === connection.token.access_token)
                    credentials?.set(plugin);
            }
            throw error;
        }
    };
    return {
        resolve(source: unknown): string | undefined {
            let url: URL;
            try {
                url = parsePluginUrl(source);
            } catch {
                throw new PluginError(400, "Invalid service URL");
            }
            return [...plugins.values()].find((plugin) => plugin.matches(url))?.id;
        },
        register(plugin: DataPlugin): void {
            validatePlugins([plugin]);
            unregister(plugin.id);
            plugins.set(plugin.id, { ...plugin });
        },
        unregister,
        createSession(): string {
            for (const [id, session] of sessions)
                if (session.expires <= Date.now()) sessions.delete(id);
            if (sessions.size >= 128) throw new PluginError(503, "Too many plugin sessions");
            const id = nonce();
            sessions.set(id, {
                expires: Date.now() + 8 * 60 * 60 * 1000,
                connections: new Map(),
                attempts: new Map(),
            });
            return id;
        },
        hasSession(id: string): boolean {
            try {
                sessionFor(id);
                return true;
            } catch {
                return false;
            }
        },
        connect(id: string, pluginId: string, redirectUri: string): string {
            const plugin = pluginFor(pluginId);
            if (plugin.oauth.deviceAuthorizationUrl)
                throw new PluginError(400, "Use device authorization for this plugin");
            const redirect = new URL(redirectUri);
            if (
                redirect.protocol !== "http:" ||
                !["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname) ||
                redirect.username ||
                redirect.password ||
                redirect.search ||
                redirect.hash ||
                redirect.pathname !== `/api/plugins/callback/${pluginId}`
            )
                throw new PluginError(400, "OAuth callback must use the local viewer");
            const attempt = {
                state: nonce(),
                verifier: nonce(),
                redirectUri,
                expires: Date.now() + 10 * 60 * 1000,
            };
            begin(id, plugin, attempt);
            const url = new URL(plugin.oauth.authorizationUrl);
            for (const [key, value] of Object.entries(plugin.oauth.authorizationParams ?? {}))
                url.searchParams.set(key, value);
            url.searchParams.set(
                plugin.oauth.scopeParameter ?? "scope",
                plugin.oauth.scopes.join(plugin.oauth.scopeSeparator ?? " "),
            );
            for (const [key, value] of Object.entries({
                client_id: plugin.oauth.clientId,
                redirect_uri: redirectUri,
                response_type: "code",
                state: attempt.state,
                code_challenge: createHash("sha256").update(attempt.verifier).digest("base64url"),
                code_challenge_method: "S256",
            }))
                url.searchParams.set(key, value);
            return url.href;
        },
        async connectDevice(id: string, pluginId: string): Promise<string> {
            const plugin = pluginFor(pluginId);
            if (!plugin.oauth.deviceAuthorizationUrl)
                throw new PluginError(400, "Device authorization is not configured");
            const attempt: DeviceAttempt = {
                state: nonce(),
                expires: Date.now() + 15 * 60_000,
                deviceCode: "",
                userCode: "",
                verificationUri: "",
                interval: 5,
                nextPoll: Infinity,
                polling: false,
            };
            begin(id, plugin, attempt);
            try {
                const result = (await fetchPluginJson(
                    plugin.oauth.deviceAuthorizationUrl,
                    {
                        method: "POST",
                        headers: { accept: "application/json" },
                        body: new URLSearchParams({
                            client_id: plugin.oauth.clientId,
                            [plugin.oauth.scopeParameter ?? "scope"]: plugin.oauth.scopes.join(
                                plugin.oauth.scopeSeparator ?? " ",
                            ),
                        }),
                    },
                    true,
                    transport,
                )) as Record<string, unknown> | null;
                if (
                    !result ||
                    typeof result.device_code !== "string" ||
                    !result.device_code ||
                    result.device_code.length > 4096 ||
                    typeof result.user_code !== "string" ||
                    !result.user_code ||
                    result.user_code.length > 128 ||
                    typeof result.verification_uri !== "string" ||
                    result.verification_uri.length > 2048 ||
                    typeof result.expires_in !== "number" ||
                    !Number.isFinite(result.expires_in) ||
                    result.expires_in <= 0 ||
                    result.expires_in > 3600 ||
                    (result.interval !== undefined &&
                        (typeof result.interval !== "number" ||
                            !Number.isFinite(result.interval) ||
                            result.interval <= 0 ||
                            result.interval > 60))
                )
                    throw new PluginError(502, "Invalid device authorization response");
                const verificationUri = httpsUrl(result.verification_uri).href;
                if (sessionFor(id).attempts.get(pluginId) !== attempt) throw expired();
                Object.assign(attempt, {
                    deviceCode: result.device_code,
                    userCode: result.user_code,
                    verificationUri,
                    expires: Date.now() + result.expires_in * 1000,
                    interval: result.interval ?? 5,
                    nextPoll: Date.now() + Number(result.interval ?? 5) * 1000,
                });
                return attempt.state;
            } catch (error) {
                if (sessionFor(id).attempts.get(pluginId) === attempt)
                    sessionFor(id).attempts.delete(pluginId);
                throw error;
            }
        },
        async pollDevice(
            id: string,
            pluginId: string,
            state: string,
        ): Promise<{ userCode: string; verificationUri: string; retryAfter: number } | undefined> {
            const session = sessionFor(id);
            const plugin = pluginFor(pluginId);
            const attempt = session.attempts.get(pluginId);
            if (
                !state ||
                !attempt ||
                !("deviceCode" in attempt) ||
                !attempt.deviceCode ||
                attempt.state !== state ||
                attempt.expires <= Date.now()
            )
                throw new PluginError(400, "Invalid or expired device authorization");
            if (!attempt.polling && Date.now() >= attempt.nextPoll) {
                attempt.polling = true;
                attempt.nextPoll = Date.now() + attempt.interval * 1000;
                try {
                    const result = await fetchPluginJson(
                        plugin.oauth.tokenUrl,
                        {
                            method: "POST",
                            headers: { accept: "application/json" },
                            body: new URLSearchParams({
                                client_id: plugin.oauth.clientId,
                                device_code: attempt.deviceCode,
                                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                            }),
                        },
                        "device",
                        transport,
                    );
                    if (
                        sessionFor(id).attempts.get(pluginId) !== attempt ||
                        attempt.expires <= Date.now()
                    )
                        throw expired();
                    if (result && typeof result === "object" && "error" in result) {
                        if (result.error === "slow_down") {
                            attempt.interval += 5;
                            if (
                                "interval" in result &&
                                typeof result.interval === "number" &&
                                Number.isFinite(result.interval) &&
                                result.interval > attempt.interval
                            )
                                attempt.interval = result.interval;
                        } else if (result.error !== "authorization_pending") {
                            session.attempts.delete(pluginId);
                            throw new PluginError(
                                400,
                                "Device sign-in was not completed. Connect this plugin again.",
                            );
                        }
                    } else {
                        await complete(id, plugin, attempt, tokenFrom(plugin, result));
                        return;
                    }
                } finally {
                    attempt.polling = false;
                    attempt.nextPoll = Date.now() + attempt.interval * 1000;
                }
            }
            return {
                userCode: attempt.userCode,
                verificationUri: attempt.verificationUri,
                retryAfter: Math.max(
                    1,
                    Math.ceil((Math.min(attempt.nextPoll, attempt.expires) - Date.now()) / 1000),
                ),
            };
        },
        async callback(
            id: string,
            pluginId: string,
            redirectUri: string,
            params: URLSearchParams,
        ): Promise<void> {
            const session = sessionFor(id);
            const plugin = pluginFor(pluginId);
            const attempt = session.attempts.get(pluginId);
            if (
                !attempt?.state ||
                !("verifier" in attempt) ||
                attempt.expires <= Date.now() ||
                attempt.redirectUri !== redirectUri ||
                params.getAll("state").length !== 1 ||
                params.get("state") !== attempt.state
            )
                throw new PluginError(400, "Invalid or expired OAuth state");
            // Consume the state before exchanging a code so callbacks cannot be replayed.
            attempt.state = "";
            const code = params.get("code");
            if (params.has("error") || !code || params.getAll("code").length !== 1)
                throw new PluginError(400, "OAuth authorization was not completed");
            const token = await exchange(plugin, {
                grant_type: "authorization_code",
                code,
                redirect_uri: redirectUri,
                code_verifier: attempt.verifier,
            });
            await complete(id, plugin, attempt, token);
        },
        disconnect(id: string, pluginId: string): void {
            const session = sessionFor(id);
            session.connections.delete(pluginId);
            session.attempts.delete(pluginId);
            credentials?.set(pluginFor(pluginId));
            if (credentials)
                for (const other of sessions.values()) other.connections.delete(pluginId);
        },
        status(id: string, pluginId: string): PluginUser | undefined {
            const plugin = pluginFor(pluginId);
            const session = sessionFor(id);
            const connection = credentials
                ? credentials.get(plugin)
                : session.connections.get(pluginId);
            if (
                !connection ||
                (connection.expires <= Date.now() && !connection.token.refresh_token)
            )
                return undefined;
            return { ...connection.user };
        },
        read(id: string, pluginId: string, source: unknown) {
            return access(id, pluginId, source, async (plugin, url, connection) => ({
                user: connection.user,
                view: validatePluginView(
                    await plugin.read(url, {
                        ...context(plugin, connection.token.access_token, false, () =>
                            assertCurrent(id, pluginId, connection),
                        ),
                        user: { ...connection.user },
                    }),
                ),
            }));
        },
        actions(id: string, pluginId: string, source: unknown) {
            return access(id, pluginId, source, async (plugin, url, connection) => ({
                user: connection.user,
                actions: validatePluginActions(
                    plugin.actions && plugin.act
                        ? await plugin.actions(url, {
                              ...context(plugin, connection.token.access_token, false, () =>
                                  assertCurrent(id, pluginId, connection),
                              ),
                              user: { ...connection.user },
                          })
                        : [],
                ),
            }));
        },
        act(id: string, pluginId: string, source: unknown, input: unknown, requestId: unknown) {
            const operation = validatePluginActionRequest(input);
            if (typeof requestId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId))
                throw new PluginError(400, "Invalid operation ID");
            return access(id, pluginId, source, async (plugin, url, connection) => {
                const { actions: listActions, act } = plugin;
                if (!listActions || !act)
                    throw new PluginError(403, "Plugin operations are not supported");
                const fingerprint = createHash("sha256")
                    .update(JSON.stringify([url.href, operation]))
                    .digest("hex");
                connection.operations ??= new Map();
                const requests = connection.operations;
                let request = requests.get(requestId);
                if (request && request.fingerprint !== fingerprint)
                    throw new PluginError(409, "Operation ID was already used for another request");
                if (!request) {
                    // shortcut: retain 128 operation results per connection; use durable idempotency for longer sessions.
                    if (requests.size >= 128)
                        throw new PluginError(429, "Reconnect before performing more operations");
                    const previous = connection.writing;
                    const promise = (async () => {
                        try {
                            await previous;
                        } catch {
                            // A failed operation must not block later writes.
                        }
                        const check = () => assertCurrent(id, pluginId, connection);
                        check();
                        const user = { ...connection.user };
                        const actions = validatePluginActions(
                            await listActions.call(plugin, url, {
                                ...context(plugin, connection.token.access_token, false, check),
                                user,
                            }),
                        );
                        const action = actions.find((a) => a.id === operation.id);
                        if (!action)
                            throw new PluginError(
                                403,
                                "Operation is not available for this user and URL",
                            );
                        validatePluginActionValues(action, operation);
                        check();
                        const result = await act.call(
                            plugin,
                            url,
                            {
                                ...context(plugin, connection.token.access_token, true, check),
                                user,
                            },
                            operation,
                        );
                        if (
                            !result ||
                            typeof result.message !== "string" ||
                            result.message.length > 4000 ||
                            (result.deleted !== undefined && typeof result.deleted !== "boolean")
                        )
                            throw new PluginError(502, "Invalid plugin operation result");
                        return result;
                    })();
                    connection.writing = promise;
                    request = { fingerprint, promise };
                    requests.set(requestId, request);
                }
                return { user: connection.user, result: await request.promise };
            });
        },
    };
};
