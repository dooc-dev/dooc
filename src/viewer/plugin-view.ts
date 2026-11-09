import { type PluginView, validatePluginView } from "../plugins/view.js";
import { pluginBlocksHtml } from "./plugin-blocks.js";

export const pluginViewHtml = (input: PluginView): string => {
    const view = validatePluginView(input);
    return `<div class="plugin-blocks">${pluginBlocksHtml(view.blocks)}</div>`;
};
