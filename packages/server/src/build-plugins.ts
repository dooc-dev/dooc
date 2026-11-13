import type { PluginTransport } from "../../../plugins/src/transport.js";
import { PLUGIN_BLOCK_CSS } from "../../frontend/src/plugin-style.js";
import { pluginViewHtml } from "../../frontend/src/plugin-view.js";
import { createExtensionManager } from "./extensions.js";
import { loadViewerPlugins } from "./plugin-config.js";
import { createLocalPluginStorage } from "./plugins/local-storage.js";
import { createPluginRuntime } from "./plugins/runtime.js";

/** Only previously enabled packages execute; personal credentials never enter the artifact. */
export const loadBuildPlugins = async (root: string, module?: string) => {
    const initial = await loadViewerPlugins(module);
    if (initial.setup)
        throw new Error("Build plugins must be declared without a viewer setup callback");
    const personal = createLocalPluginStorage();
    let config = initial;
    const manager = createExtensionManager(
        root,
        {
            configuration: () => config,
            register(plugin, options) {
                config = {
                    ...config,
                    plugins: [...config.plugins, plugin],
                    mocks: {
                        ...config.mocks,
                        ...(options?.mock ? { [plugin.id]: options.mock } : {}),
                    },
                };
            },
            unregister(id) {
                config = {
                    ...config,
                    plugins: config.plugins.filter((plugin) => plugin.id !== id),
                };
            },
        },
        initial,
        personal,
    );
    try {
        const errors = await manager.restore();
        if (errors.length) throw new Error(errors.join("\n"));
        const runtime = createPluginRuntime(
            config.plugins,
            async (input, init) => {
                const request = new Request(input, init);
                const mock = Object.values(config.mocks).find(
                    (mock) => mock.origin === new URL(request.url).origin,
                );
                return mock ? mock.handle(request) : fetch(request);
            },
            personal.credentials,
        );
        const session = runtime.createSession();
        const request: PluginTransport = async (input) => {
            if (input.action === "resolve") return { plugin: runtime.resolve(input.url) };
            if (input.action === "read" && input.plugin)
                return runtime.read(session, input.plugin, input.url);
            throw new Error("Static builds only resolve and read plugins");
        };
        return { request, dispose: () => manager.dispose() };
    } catch (error) {
        manager.dispose();
        throw error;
    }
};

export const pluginSnapshot =
    (request: PluginTransport) =>
    async (url: string): Promise<string | undefined> => {
        const { plugin } = await request({ action: "resolve", url });
        if (!plugin) return undefined;
        const { view } = await request({ action: "read", plugin, url });
        if (!view) throw new Error(`Plugin ${plugin} returned no view for ${url}`);
        const html = pluginViewHtml(view).replace(/<button\b/g, "<button disabled");
        return `<div class="plugin"><style>${PLUGIN_BLOCK_CSS}
.plugin { container-type: inline-size; color: var(--doc-fg, #000000); --doc-mono: ui-monospace, monospace; }
.plugin-copy { display: none; }
.plugin button:disabled { cursor: default; }
</style><div class="plugin-content">${html}</div></div>`;
    };
