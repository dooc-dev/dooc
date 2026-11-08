import { type PluginBlockContent, validPluginBlocks } from "./blocks.js";

export type PluginContent =
    | PluginBlockContent
    | { format: "html"; html: string; height?: number | "auto" }
    | { format: "json"; preset: "card"; title: string; text: string }
    | { format: "json"; preset: "list"; items: string[] }
    | {
          format: "json";
          preset: "table";
          headers: string[];
          rows: (string | number | boolean | null)[][];
      }
    | { format: "json"; preset: "code"; value: unknown };

export type PluginView = PluginContent & { collapsed?: PluginContent };

const validContent = (view: PluginContent): boolean => {
    let valid = false;
    if (view && typeof view === "object") {
        if (view.format === "blocks") return validPluginBlocks(view);
        if (view.format === "html")
            valid =
                typeof view.html === "string" &&
                (view.height === undefined ||
                    view.height === "auto" ||
                    (Number.isInteger(view.height) && view.height >= 32 && view.height <= 1200));
        if (view.format === "json") {
            switch (view.preset) {
                case "card":
                    valid = typeof view.title === "string" && typeof view.text === "string";
                    break;
                case "list":
                    valid =
                        Array.isArray(view.items) &&
                        view.items.every((item) => typeof item === "string");
                    break;
                case "table":
                    valid =
                        Array.isArray(view.headers) &&
                        view.headers.every((h) => typeof h === "string") &&
                        Array.isArray(view.rows) &&
                        view.rows.every(
                            (row) =>
                                Array.isArray(row) &&
                                row.length === view.headers.length &&
                                row.every(
                                    (cell) =>
                                        cell === null ||
                                        ["string", "boolean"].includes(typeof cell) ||
                                        (typeof cell === "number" && Number.isFinite(cell)),
                                ),
                        );
                    break;
                case "code":
                    valid = view.value !== undefined;
                    break;
            }
        }
    }
    return valid;
};

export const validatePluginView = (input: unknown): PluginView => {
    const encoded = JSON.stringify(input);
    if (typeof encoded !== "string") throw new Error("Invalid plugin view");
    if (new TextEncoder().encode(encoded).length > 2 * 1024 * 1024)
        throw new Error("Plugin view is too large");
    const view = JSON.parse(encoded) as PluginView;
    if (!validContent(view) || (view.collapsed !== undefined && !validContent(view.collapsed)))
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
