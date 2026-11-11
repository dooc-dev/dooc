import type { PluginTransport } from "../plugins/transport.js";
import { mountPlugins } from "./plugins-ui.js";

declare global {
    interface Window {
        dooc: { setPluginTransport(transport: PluginTransport | null): void };
    }
}

window.dooc = { ...window.dooc, setPluginTransport: mountPlugins(true) };
