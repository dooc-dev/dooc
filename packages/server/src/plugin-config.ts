import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { httpsUrl, validatePlugins } from "../../../plugins/src/oauth.js";
import type { DataPlugin } from "../../../plugins/src/types.js";
import { parsePreviewSettings } from "../../engine/src/core/previewers.js";
import { parseWorkspaceSource, type WorkspaceSource } from "../../engine/src/core/workspace.js";
import type { GitOrigin } from "../../workspace/src/git-types.js";
import { validateGitOrigin } from "./git.js";

export interface PluginMock {
    origin: string;
    /** Complete local mock authorization automatically when displaying a preview. */
    autoConnect?: boolean;
    handle: (request: Request) => Response | Promise<Response>;
}

export interface ReaderPlugins {
    workspace?: WorkspaceSource;
    gitOrigin?: GitOrigin;
    allowedDomains?: string[];
    setup?: (reader: ReaderRuntime) => void | Promise<void>;
    plugins: readonly DataPlugin[];
    mocks: Readonly<Record<string, PluginMock>>;
}

export interface ReaderPluginRegistry {
    /** Replacing an ID clears that plugin's connections and pending authorization attempts. */
    register(plugin: DataPlugin, options?: { mock?: PluginMock }): void;
    unregister(id: string): void;
}

export interface ReaderRuntime extends ReaderPluginRegistry {
    /** Replaces the host-owned workspace location; undefined restores local discovery. */
    setWorkspace(workspace: WorkspaceSource | undefined): void;
    /** The host owns origin operations and authentication; undefined disconnects it. */
    setGitOrigin(origin: GitOrigin | undefined): void;
    /** Replaces the network policy and refreshes open readers; an empty list revokes all hosts. */
    setAllowedDomains(domains: readonly string[]): void;
}

/** Reader modules are explicitly injected; document roots never select executable plugins. */
export const loadReaderPlugins = async (specifier?: string): Promise<ReaderPlugins> => {
    if (!specifier) return { plugins: [], mocks: {} };
    const path =
        isAbsolute(specifier) || specifier.startsWith(".")
            ? resolve(specifier)
            : createRequire(resolve("dooc-reader.cjs")).resolve(specifier);
    const { default: config } = await import(pathToFileURL(path).href);
    return validateReaderPlugins(config);
};

export const validateReaderPlugins = (input: unknown): ReaderPlugins => {
    const config = input as ReaderPlugins;
    if (!config || typeof config !== "object" || Array.isArray(config))
        throw new Error("Reader plugin module must export a configuration object");
    if (config.setup !== undefined && typeof config.setup !== "function")
        throw new Error("Reader setup must be a function");
    const plugins = validatePlugins(config.plugins);
    if ("mounts" in config) throw new Error("Use ![](service-url) instead of reader mounts");
    const mocks = config.mocks ?? {};
    if (typeof mocks !== "object" || Array.isArray(mocks))
        throw new Error("Reader mocks must be an object");
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
            throw new Error("Reader mocks require distinct HTTPS .invalid origins and handlers");
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
