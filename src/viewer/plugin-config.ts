import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parsePreviewSettings } from "../core/previewers.js";
import { parseWorkspaceSource, type WorkspaceSource } from "../core/workspace.js";
import { httpsUrl, validatePlugins } from "../plugins/oauth.js";
import type { DataPlugin } from "../plugins/types.js";
import { validateGitOrigin } from "./git.js";
import type { GitOrigin } from "./git-types.js";

export interface PluginMock {
    origin: string;
    /** Complete local mock authorization automatically when displaying a preview. */
    autoConnect?: boolean;
    handle: (request: Request) => Response | Promise<Response>;
}

export interface ViewerPlugins {
    workspace?: WorkspaceSource;
    gitOrigin?: GitOrigin;
    allowedDomains?: string[];
    setup?: (viewer: ViewerRuntime) => void | Promise<void>;
    plugins: readonly DataPlugin[];
    mocks: Readonly<Record<string, PluginMock>>;
}

export interface ViewerPluginRegistry {
    /** Replacing an ID clears that plugin's connections and pending authorization attempts. */
    register(plugin: DataPlugin, options?: { mock?: PluginMock }): void;
    unregister(id: string): void;
}

export interface ViewerRuntime extends ViewerPluginRegistry {
    /** Replaces the host-owned workspace location; undefined restores local discovery. */
    setWorkspace(workspace: WorkspaceSource | undefined): void;
    /** The host owns origin operations and authentication; undefined disconnects it. */
    setGitOrigin(origin: GitOrigin | undefined): void;
    /** Replaces the network policy and refreshes open viewers; an empty list revokes all hosts. */
    setAllowedDomains(domains: readonly string[]): void;
}

/** Viewer modules are explicitly injected; document roots never select executable plugins. */
export const loadViewerPlugins = async (specifier?: string): Promise<ViewerPlugins> => {
    if (!specifier) return { plugins: [], mocks: {} };
    const path =
        isAbsolute(specifier) || specifier.startsWith(".")
            ? resolve(specifier)
            : createRequire(resolve("dooc-viewer.cjs")).resolve(specifier);
    const { default: config } = await import(pathToFileURL(path).href);
    return validateViewerPlugins(config);
};

export const validateViewerPlugins = (input: unknown): ViewerPlugins => {
    const config = input as ViewerPlugins;
    if (!config || typeof config !== "object" || Array.isArray(config))
        throw new Error("Viewer plugin module must export a configuration object");
    if (config.setup !== undefined && typeof config.setup !== "function")
        throw new Error("Viewer setup must be a function");
    const plugins = validatePlugins(config.plugins);
    if ("mounts" in config) throw new Error("Use ![](service-url) instead of viewer mounts");
    const mocks = config.mocks ?? {};
    if (typeof mocks !== "object" || Array.isArray(mocks))
        throw new Error("Viewer mocks must be an object");
    const origins = new Set<string>();
    for (const [id, mock] of Object.entries(mocks) as [string, PluginMock][]) {
        if (
            !/^[a-z][a-z0-9-]{0,63}$/.test(id) ||
            !mock ||
            typeof mock.handle !== "function" ||
            (mock.autoConnect !== undefined && typeof mock.autoConnect !== "boolean") ||
            typeof mock.origin !== "string" ||
            httpsUrl(mock.origin).origin !== mock.origin ||
            !new URL(mock.origin).hostname.endsWith(".invalid") ||
            origins.has(mock.origin)
        )
            throw new Error("Viewer mocks require distinct HTTPS .invalid origins and handlers");
        origins.add(mock.origin);
    }
    return {
        plugins,
        mocks,
        ...(config.gitOrigin === undefined
            ? {}
            : { gitOrigin: validateGitOrigin(config.gitOrigin) }),
        ...(config.allowedDomains === undefined
            ? {}
            : { allowedDomains: parsePreviewSettings({ domains: config.allowedDomains }).domains }),
        ...(config.setup === undefined ? {} : { setup: config.setup }),
        ...(config.workspace === undefined
            ? {}
            : { workspace: parseWorkspaceSource(config.workspace) }),
    };
};
