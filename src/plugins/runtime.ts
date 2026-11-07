import { createHash, randomBytes } from "node:crypto";
import {
    fetchPluginJson,
    httpsUrl,
    isPluginError,
    PluginError,
    parseOAuthToken,
    validatePlugins,
} from "./oauth.js";
import type { DataPlugin, OAuthToken, PluginContext, PluginUser } from "./types.js";
import { parsePluginUrl, validatePluginView } from "./view.js";

interface Connection {
    token: OAuthToken;
    expires: number;
    user: PluginUser;
    refreshing?: Promise<void>;
}

interface Attempt {
    state: string;
    verifier: string;
    redirectUri: string;
    expires: number;
}

interface Session {
    expires: number;
    connections: Map<string, Connection>;
    attempts: Map<string, Attempt>;
}

const nonce = (): string => randomBytes(32).toString("base64url");
const expired = (): PluginError => new PluginError(401, "Connect this plugin again");
const expiry = (token: OAuthToken): number =>
    token.expires_in === undefined ? Infinity : Date.now() + token.expires_in * 1000;

export const createPluginRuntime = (
    definitions: readonly DataPlugin[],
    transport?: typeof fetch,
) => {
    const plugins = new Map(validatePlugins(definitions).map((plugin) => [plugin.id, plugin]));
    // shortcut: sessions and tokens live in memory for eight hours; add an OS credential store for persistent login.
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
            return parseOAuthToken(oauth.parseToken ? oauth.parseToken(result) : result);
        } catch {
            throw new PluginError(502, "Invalid OAuth token response");
        }
    };
    const context = (plugin: DataPlugin, accessToken: string): PluginContext => ({
        request: async (source, init) => {
            if (plugins.get(plugin.id) !== plugin) throw expired();
            const url = httpsUrl(source);
            if (!plugin.apiOrigins.includes(url.origin))
                throw new PluginError(400, "Plugin API origin is not allowed");
            if (init?.method !== undefined && !["GET", "POST"].includes(init.method))
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
    const unregister = (pluginId: string): void => {
        plugins.delete(pluginId);
        for (const session of sessions.values()) {
            session.connections.delete(pluginId);
            session.attempts.delete(pluginId);
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
            const session = sessionFor(id);
            const plugin = pluginFor(pluginId);
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
            session.connections.delete(pluginId);
            session.attempts.set(pluginId, attempt);
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
            if (sessionFor(id).attempts.get(pluginId) !== attempt) throw expired();
            session.attempts.delete(pluginId);
            session.connections.set(pluginId, {
                token,
                expires,
                user: { id: user.id, name: user.name },
            });
        },
        disconnect(id: string, pluginId: string): void {
            const session = sessionFor(id);
            session.connections.delete(pluginId);
            session.attempts.delete(pluginId);
        },
        async read(id: string, pluginId: string, source: unknown) {
            let url: URL;
            try {
                url = parsePluginUrl(source);
            } catch {
                throw new PluginError(400, "Invalid service URL");
            }
            const session = sessionFor(id);
            const plugin = pluginFor(pluginId);
            if (!plugin.matches(url))
                throw new PluginError(400, "URL is not supported by this plugin");
            const connection = session.connections.get(pluginId);
            if (!connection) throw expired();
            try {
                if (connection.expires <= Date.now() + 30_000) {
                    if (!connection.token.refresh_token) throw expired();
                    connection.refreshing ??= (async () => {
                        const token = await exchange(plugin, {
                            grant_type: "refresh_token",
                            refresh_token: connection.token.refresh_token as string,
                        });
                        assertCurrent(id, pluginId, connection);
                        connection.token = {
                            ...token,
                            refresh_token: token.refresh_token ?? connection.token.refresh_token,
                            scope: token.scope ?? connection.token.scope,
                        };
                        connection.expires = expiry(token);
                    })().finally(() => {
                        connection.refreshing = undefined;
                    });
                    await connection.refreshing;
                }
                assertCurrent(id, pluginId, connection);
                const view = validatePluginView(
                    await plugin.read(url, {
                        ...context(plugin, connection.token.access_token),
                        user: { ...connection.user },
                    }),
                );
                assertCurrent(id, pluginId, connection);
                return { user: connection.user, view };
            } catch (error) {
                if (
                    isPluginError(error) &&
                    error.status === 401 &&
                    session.connections.get(pluginId) === connection
                )
                    session.connections.delete(pluginId);
                throw error;
            }
        },
    };
};
