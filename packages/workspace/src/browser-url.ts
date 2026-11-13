import path from "path-browserify";
export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;
export const fileURLToPath = (value: string | URL): string => {
    const url = new URL(value);
    if (url.protocol !== "file:" || url.hostname) throw new Error("Expected a local file URL");
    return decodeURIComponent(url.pathname);
};
export const pathToFileURL = (value: string): URL =>
    new URL(`file://${path.resolve(value).split("/").map(encodeURIComponent).join("/")}`);
