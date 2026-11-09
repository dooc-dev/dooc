/** OAuth credentials belong in environment variables, never in document source. */
export interface PluginOAuth {
    authorizationUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    scopes: readonly string[];
    /** Provider-specific user authorization parameters, such as actor=user. */
    authorizationParams?: Readonly<Record<string, string>>;
    scopeParameter?: string;
    scopeSeparator?: string;
    /** Normalize provider responses; select the user token and reject bot/app tokens. */
    parseToken?: (response: unknown) => OAuthToken;
}

export interface OAuthToken {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string | string[];
}

export interface PluginUser {
    /** Include the tenant/workspace in the ID if user IDs are not globally unique. */
    id: string;
    name: string;
}

export interface PluginContext {
    /** Authenticated JSON requests to apiOrigins only; credentials never reach the browser. */
    request: (url: string, init?: { method?: "GET" | "POST"; body?: unknown }) => Promise<unknown>;
}

export type { PluginContent, PluginView } from "./view.js";

import type {
    PluginAction,
    PluginActionContext,
    PluginActionRequest,
    PluginActionResult,
} from "./actions.js";
import type { PluginIcon } from "./blocks.js";
import type { PluginView } from "./view.js";

/** Trusted server code injected into the viewer, independently of document configuration. */
export interface DataPlugin {
    id: string;
    name?: string;
    icon?: PluginIcon;
    /** Match a service URL without fetching it; unmatched embeds remain ordinary links. */
    matches: (url: URL) => boolean;
    oauth: PluginOAuth;
    /** Exact HTTPS origins; API requests and their redirects cannot leave these origins. */
    apiOrigins: readonly string[];
    /** Resolve the token's actual user; reject application identities and provider errors. */
    identifyUser: (context: PluginContext) => Promise<PluginUser>;
    /** Fetch the matched URL's data using read operations and reject provider-level API errors. */
    read: (url: URL, context: PluginContext & { user: PluginUser }) => Promise<PluginView>;
    /** Resolve operations available to the current user without performing writes. */
    actions?: (url: URL, context: PluginContext & { user: PluginUser }) => Promise<PluginAction[]>;
    /** Recheck provider permissions and resource versions before changing remote data. */
    act?: (
        url: URL,
        context: PluginActionContext,
        request: PluginActionRequest,
    ) => Promise<PluginActionResult>;
}
