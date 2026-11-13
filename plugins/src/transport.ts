import type { PluginAction, PluginActionRequest, PluginActionResult } from "./actions.js";
import type { PluginUser } from "./types.js";
import type { PluginView } from "./view.js";

export interface PluginRequest {
    action: string;
    plugin?: string;
    url?: string;
    operation?: PluginActionRequest;
    requestId?: string;
}

export interface PluginResponse {
    plugin?: string;
    connected?: boolean;
    autoConnect?: boolean;
    user?: PluginUser | null;
    view?: PluginView;
    actions?: PluginAction[];
    result?: PluginActionResult;
    url?: string;
}

/** The host authenticates requests; rejecting with status 401/403 clears the plugin's views. */
export type PluginTransport = (request: PluginRequest) => Promise<PluginResponse>;
