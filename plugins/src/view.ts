import { type PluginBlockContent, validPluginBlocks } from "./blocks.js";

export type PluginContent = PluginBlockContent;
export type PluginView = PluginContent & { collapsed?: PluginContent };

export const validatePluginView = (input: unknown): PluginView => {
    const encoded = JSON.stringify(input);
    if (typeof encoded !== "string") throw new Error("Invalid plugin view");
    if (new TextEncoder().encode(encoded).length > 2 * 1024 * 1024)
        throw new Error("Plugin view is too large");
    const view = JSON.parse(encoded) as PluginView;
    if (
        !validPluginBlocks(view) ||
        (view.collapsed !== undefined && !validPluginBlocks(view.collapsed))
    )
        throw new Error("Invalid plugin view");
    return view;
};

export const parsePluginUrl = (input: unknown): URL => {
    if (typeof input !== "string" || input.length > 4096 || /[\s\\]/.test(input))
        throw new Error("Expected a service URL");
    const url = new URL(input);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password)
        throw new Error("Expected an HTTP(S) URL without credentials");
    return url;
};
