import { validPluginIcon } from "./blocks.js";
import type { DataPlugin, OAuthToken } from "./types.js";

export class PluginError extends Error {
    override readonly name = "DoocPluginError";

    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

/** A plugin may load a separate installed copy of the SDK. */
export const isPluginError = (error: unknown): error is PluginError =>
    error instanceof Error &&
    error.name === "DoocPluginError" &&
    "status" in error &&
    typeof error.status === "number" &&
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599;

export const httpsUrl = (source: string): URL => {
    const url = new URL(source);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
        throw new Error("Plugin endpoints must use HTTPS without credentials or fragments");
    return url;
};

/** Use after selecting a provider's user-token object in parseToken. */
export const parseOAuthToken = (input: unknown): OAuthToken => {
    const token = input as (OAuthToken & { token_type?: unknown }) | null;
    if (
        !token ||
        typeof token !== "object" ||
        typeof token.access_token !== "string" ||
        !token.access_token ||
        /[\s\p{Cc}]/u.test(token.access_token) ||
        (token.token_type !== undefined &&
            token.token_type !== "user" &&
            (typeof token.token_type !== "string" ||
                token.token_type.toLowerCase() !== "bearer")) ||
        (token.refresh_token !== undefined &&
            (typeof token.refresh_token !== "string" || !token.refresh_token)) ||
        (token.expires_in !== undefined &&
            (typeof token.expires_in !== "number" ||
                !Number.isFinite(token.expires_in) ||
                token.expires_in <= 0)) ||
        (token.scope !== undefined &&
            typeof token.scope !== "string" &&
            (!Array.isArray(token.scope) || token.scope.some((s) => typeof s !== "string")))
    )
        throw new PluginError(502, "Invalid OAuth token response");
    return {
        access_token: token.access_token,
        ...(token.refresh_token === undefined ? {} : { refresh_token: token.refresh_token }),
        ...(token.expires_in === undefined ? {} : { expires_in: token.expires_in }),
        ...(token.scope === undefined ? {} : { scope: token.scope }),
    };
};

/** Bound both transfer time and decoded size; never include remote error bodies in errors. */
export const fetchPluginJson = async (
    url: string,
    init: RequestInit,
    tokenExchange: boolean | "device" = false,
    transport: typeof fetch = fetch,
): Promise<unknown> => {
    try {
        const response = await transport(url, {
            ...init,
            redirect: "error",
            cache: "no-store",
            signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok && !(tokenExchange === "device" && response.status === 400)) {
            await response.body?.cancel();
            throw new PluginError(
                response.status === 400 && tokenExchange
                    ? 401
                    : [400, 401, 403, 404, 409, 422, 429].includes(response.status)
                      ? response.status
                      : 502,
                response.status === 401 || (response.status === 400 && tokenExchange)
                    ? "Connect this plugin again"
                    : response.status === 403
                      ? "Access denied by the service"
                      : "Plugin service request failed",
            );
        }
        if (response.status === 204) return null;
        const reader = response.body?.getReader();
        if (!reader) return null;
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > 2 * 1024 * 1024) throw new Error("Response too large");
                chunks.push(value);
            }
        } finally {
            await reader.cancel();
        }
        return size === 0 ? null : JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
        if (isPluginError(error)) throw error;
        throw new PluginError(502, "Plugin service request failed");
    }
};

export const validatePlugins = (input: unknown): DataPlugin[] => {
    if (!Array.isArray(input)) throw new Error("Viewer plugins: plugins must be an array");
    const ids = new Set<string>();
    return input.map((plugin: DataPlugin) => {
        if (
            !plugin ||
            typeof plugin.id !== "string" ||
            !/^[a-z][a-z0-9-]{0,63}$/.test(plugin.id) ||
            ids.has(plugin.id)
        )
            throw new Error("Viewer plugins: plugin IDs must be unique lowercase names");
        ids.add(plugin.id);
        const oauth = plugin.oauth;
        if (
            !oauth ||
            (plugin.name !== undefined &&
                (typeof plugin.name !== "string" ||
                    !plugin.name.trim() ||
                    plugin.name.length > 100)) ||
            (plugin.icon !== undefined && !validPluginIcon(plugin.icon)) ||
            typeof oauth.clientId !== "string" ||
            !oauth.clientId.trim() ||
            (oauth.clientSecret !== undefined && typeof oauth.clientSecret !== "string") ||
            (oauth.deviceAuthorizationUrl !== undefined &&
                (typeof oauth.deviceAuthorizationUrl !== "string" || !!oauth.clientSecret)) ||
            !Array.isArray(oauth.scopes) ||
            oauth.scopes.some((s) => typeof s !== "string" || !s.trim()) ||
            typeof plugin.identifyUser !== "function" ||
            typeof plugin.matches !== "function" ||
            typeof plugin.read !== "function" ||
            (plugin.actions !== undefined && typeof plugin.actions !== "function") ||
            (plugin.act !== undefined && typeof plugin.act !== "function") ||
            Boolean(plugin.actions) !== Boolean(plugin.act) ||
            !Array.isArray(plugin.apiOrigins) ||
            !plugin.apiOrigins.length ||
            (oauth.parseToken !== undefined && typeof oauth.parseToken !== "function")
        )
            throw new Error(`Viewer plugins: invalid plugin ${plugin.id}`);
        for (const endpoint of [
            oauth.authorizationUrl,
            oauth.tokenUrl,
            ...(oauth.deviceAuthorizationUrl === undefined ? [] : [oauth.deviceAuthorizationUrl]),
        ]) {
            if (typeof endpoint !== "string" || httpsUrl(endpoint).search)
                throw new Error("OAuth endpoints must not contain query parameters");
        }
        for (const origin of plugin.apiOrigins)
            if (typeof origin !== "string" || httpsUrl(origin).origin !== origin)
                throw new Error("apiOrigins must contain exact HTTPS origins");
        const reserved = new Set([
            "client_id",
            "client_secret",
            "redirect_uri",
            "response_type",
            "state",
            "code_challenge",
            "code_challenge_method",
        ]);
        if (
            oauth.scopeParameter !== undefined &&
            (!/^[a-z_]+$/.test(oauth.scopeParameter) || reserved.has(oauth.scopeParameter))
        )
            throw new Error("Invalid OAuth scope parameter");
        if (oauth.scopeSeparator !== undefined && ![" ", ","].includes(oauth.scopeSeparator))
            throw new Error("OAuth scope separator must be a space or comma");
        if (oauth.authorizationParams !== undefined) {
            if (
                !oauth.authorizationParams ||
                typeof oauth.authorizationParams !== "object" ||
                Array.isArray(oauth.authorizationParams)
            )
                throw new Error("Invalid OAuth authorization parameters");
            for (const [key, value] of Object.entries(oauth.authorizationParams))
                if (
                    reserved.has(key) ||
                    key === (oauth.scopeParameter ?? "scope") ||
                    typeof value !== "string"
                )
                    throw new Error(
                        "OAuth authorization parameters cannot override security parameters",
                    );
        }
        return plugin;
    });
};
