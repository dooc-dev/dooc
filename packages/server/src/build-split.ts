import { createHash } from "node:crypto";
import { assetReferences } from "../../engine/src/compiler/asset-references.js";
import type { PublishOutput } from "../../frontend/src/document-application.js";
import { compressMedia } from "./build-media.js";

export interface SplitBuildOptions {
    split?: boolean;
    compress?: boolean;
    maxFileSize?: string | number;
    maxBuildSize?: string | number;
    warningsAsErrors?: boolean;
}

export const buildSize = (
    value: string | number | undefined,
    option: string,
): number | undefined => {
    if (value === undefined) return undefined;
    const match =
        typeof value === "string" &&
        /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|KiB|MiB|GiB)?$/i.exec(value.trim());
    const units: Record<string, number> = {
        b: 1,
        kb: 1000,
        mb: 1000 ** 2,
        gb: 1000 ** 3,
        kib: 1024,
        mib: 1024 ** 2,
        gib: 1024 ** 3,
    };
    const bytes =
        typeof value === "number"
            ? value
            : match
              ? Number(match[1]) * (units[match[2]?.toLowerCase() ?? "b"] ?? 1)
              : Number.NaN;
    if (!Number.isSafeInteger(bytes) || bytes <= 0)
        throw new Error(`${option} must be a positive byte count or size such as 25MiB or 100MB`);
    return bytes;
};

export const checkBuildSize = (
    files: ReadonlyMap<string, Buffer>,
    maxFileSize?: number,
    maxBuildSize?: number,
): number => {
    const errors: string[] = [];
    let bytes = 0;
    for (const [name, data] of files) {
        bytes += data.length;
        if (maxFileSize !== undefined && data.length > maxFileSize)
            errors.push(
                `${name}: ${data.length} bytes exceeds --max-file-size (${maxFileSize} bytes)`,
            );
    }
    if (maxBuildSize !== undefined && bytes > maxBuildSize)
        errors.push(`Build: ${bytes} bytes exceeds --max-build-size (${maxBuildSize} bytes)`);
    if (errors.length)
        throw new Error(
            `${errors.join("\n")}\nTry --compress, reduce the resource size, split a large document, or increase the limit. No output was replaced.`,
        );
    return bytes;
};

const hash = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const extensions: Record<string, string> = {
    "text/plain": "txt",
    "text/css": "css",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/bmp": "bmp",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/mp4": "m4a",
    "audio/webm": "webm",
    "application/pdf": "pdf",
    "font/woff2": "woff2",
    "font/woff": "woff",
    "font/ttf": "ttf",
    "font/otf": "otf",
    "application/font-woff": "woff",
    "application/font-woff2": "woff2",
};

export const splitBuild = async (
    render: (output: PublishOutput) => string,
    options: SplitBuildOptions,
    fontSources: readonly string[] = [],
    graph: ReadonlyMap<string, Buffer> = new Map(),
): Promise<{ data: string; files: Map<string, Buffer>; warnings: string[] }> => {
    const files = new Map<string, Buffer>();
    const sources = new Map<string, { source: string; extension: "html" | "js" | "css" }>();
    const warnings = new Set<string>();
    const put = (data: string | Buffer, extension: string): string => {
        const name = `dooc-assets/${hash(data)}.${extension}`;
        files.set(name, Buffer.from(data));
        return `./${name}`;
    };
    let graphEntry: string | undefined;
    if (graph.size) {
        const digest = createHash("sha256");
        for (const [name, data] of [...graph].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
            digest.update(`${name}\0${data.length}\0`).update(data);
        const directory = `dooc-assets/${digest.digest("hex")}`;
        for (const [name, data] of graph) files.set(`${directory}/${name}`, data);
        graphEntry = `./${directory}/schema-graph-global.js`;
    }
    let html = render({
        asset: (source, extension) => {
            const url = `./dooc-assets/${hash(source)}.${extension}`;
            sources.set(url, { source, extension });
            return url;
        },
        graph: graphEntry,
    });
    const resources = new Map<
        string,
        { embedded: boolean; data: Buffer; mime: string; fragment: string }
    >();
    const resourceExtensions = new Map<string, string>();
    const collect = (url: string, embedded: boolean): string => {
        const key = `${embedded}:${url}`;
        if (resources.has(key)) return url;
        // shortcut: authored non-base64 data URLs stay inline; decode them if the compiler starts emitting them.
        const match = /^data:([^,]*);base64,([^#]*)(#.*)?$/is.exec(url);
        if (!match) return url;
        const mime = (match[1]?.split(";")[0] || "text/plain").toLowerCase();
        // Keep active markup in its original isolated data URL context.
        if (
            ["text/html", "image/svg+xml", "text/javascript", "application/javascript"].includes(
                mime,
            )
        )
            return url;
        if (embedded && !extensions[mime]) {
            if (options.compress)
                warnings.add(`No preview compressor for ${mime}; keeping its inline MIME type`);
            return url;
        }
        const data = Buffer.from(match[2] ?? "", "base64");
        const digest = hash(data);
        if (extensions[mime] || !resourceExtensions.has(digest))
            resourceExtensions.set(digest, extensions[mime] ?? "bin");
        resources.set(key, { embedded, data, mime, fragment: match[3] ?? "" });
        return url;
    };
    assetReferences(html, "html", collect);
    for (const { source, extension } of sources.values())
        if (extension !== "js") assetReferences(source, extension, collect);
    for (const source of fontSources) assetReferences(`a{src:${source}}`, "css", collect);
    const replacements = new Map<string, string>();
    for (const [key, resource] of resources) {
        const result =
            options.compress &&
            resource.embedded &&
            (/^(image|video|audio)\//.test(resource.mime) || resource.mime === "application/pdf")
                ? await compressMedia(resource.data, resource.mime)
                : resource;
        if ("warning" in result && result.warning)
            warnings.add(`${hash(resource.data).slice(0, 12)}: ${result.warning}`);
        const extension =
            resourceExtensions.get(hash(result.data)) ?? extensions[result.mime] ?? "bin";
        replacements.set(key, put(result.data, extension) + resource.fragment);
    }
    const replace = (url: string, embedded: boolean) =>
        replacements.get(`${embedded}:${url}`) ?? url;
    html = assetReferences(html, "html", replace);
    const fonts = fontSources.map(
        (font) =>
            [
                JSON.stringify(font),
                JSON.stringify(assetReferences(`a{src:${font}}`, "css", replace).slice(6, -1)),
            ] as const,
    );
    for (const [url, { source, extension }] of sources) {
        let data = source;
        if (extension === "js") {
            for (const [before, after] of fonts) data = data.replaceAll(before, after);
        } else {
            data = assetReferences(source, extension, (url, embedded) => {
                const next = replace(url, embedded);
                return extension === "css" && next.startsWith("./dooc-assets/")
                    ? next.slice("./dooc-assets/".length)
                    : next;
            });
        }
        html = html.replaceAll(`"${url}"`, `"${put(data, extension)}"`);
    }
    return { data: html, files, warnings: [...warnings] };
};
