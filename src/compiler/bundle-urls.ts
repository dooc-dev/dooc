import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { type DefaultTreeAdapterTypes as Html, parseFragment, serialize } from "parse5";
import postcss from "postcss";
import valueParser from "postcss-value-parser";
import { embeddedImages, parseMdast } from "../core/markdown.js";
import { isRemoteTextfile } from "../core/textfile.js";
import { collectRefs } from "./dialect.js";
import { readManifest } from "./manifest.js";
import { fetchPublicFile } from "./public-file.js";
import { textfilePath } from "./textfile.js";
import { remoteTextfileSource } from "./textfile-remote.js";
import type { ZipEntry } from "./zip.js";

const types: Record<string, string> = {
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    mp4: "video/mp4",
    webm: "video/webm",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    json: "application/json",
};
const extension = (source: string): string =>
    posix.extname(new URL(source).pathname).slice(1).toLowerCase();
const decode = (data: Buffer): string => new TextDecoder("utf-8", { fatal: true }).decode(data);

/** Snapshot embedded URLs and their declarative assets without changing the source bundle. */
export const embedBundleUrls = async (
    root: string,
    entries: readonly ZipEntry[],
): Promise<ZipEntry[]> => {
    const result = new Map(entries.map((entry) => [entry.name, { ...entry }]));
    const figures = new Set(
        entries
            .filter((entry) => /\.(md|callouth)$/.test(entry.name))
            .flatMap((entry) => collectRefs(parseMdast(decode(entry.data))).figures),
    );
    const siteIcon = readManifest(root).icon;
    if (siteIcon) figures.add(siteIcon);
    const cache = new Map<string, { data: Buffer; type: string }>();
    const sources = new Map<string, { data: Buffer; type: string }>();
    const pending = new Set<string>();
    let total = 0;
    let downloads = 0;
    const keyOf = (source: string, base: string): URL => {
        const url = new URL(source, base);
        if (
            url.protocol !== "https:" &&
            !(url.protocol === "bundle:" && new URL(base).protocol === "bundle:")
        )
            throw new Error(`Cannot bundle resource: ${url.href} (public HTTPS required)`);
        if (url.username || url.password || url.port)
            throw new Error(
                `Cannot bundle resource with credentials or a custom port: ${url.origin}`,
            );
        return url;
    };
    const resource = async (
        url: URL,
        stylesheet = true,
    ): Promise<{ data: Buffer; type: string }> => {
        url = new URL(url);
        url.hash = "";
        const key = url.href;
        const cacheKey = `${stylesheet}:${key}`;
        const cached = cache.get(cacheKey);
        if (cached) return cached;
        if (pending.has(key)) throw new Error(`Circular embedded resource: ${key}`);
        pending.add(key);
        try {
            let source = sources.get(key);
            if (!source) {
                if (url.protocol === "https:" && ++downloads > 256)
                    throw new Error("Bundle exceeds 256 remote assets");
                let type = "";
                const data =
                    url.protocol === "bundle:"
                        ? readFileSync(
                              textfilePath(root, decodeURIComponent(url.pathname.slice(1))),
                          )
                        : await fetchPublicFile(url.href, (value) => {
                              type = value.split(";")[0]?.trim().toLowerCase() ?? "";
                          });
                if (url.protocol === "https:") total += data.length;
                if (total > 64 * 1024 * 1024) throw new Error("Embedded assets exceed 64 MiB");
                if (!type || type === "application/octet-stream")
                    type = types[extension(key)] ?? "text/plain";
                source = { data, type };
                sources.set(key, source);
            }
            const { data, type } = source;
            let output = data;
            if (type === "text/html" || type === "image/svg+xml")
                output = Buffer.from(await markup(decode(data), key));
            else if (type === "text/css" && stylesheet)
                output = Buffer.from(await css(decode(data), key));
            const asset = { data: output, type };
            cache.set(cacheKey, asset);
            return asset;
        } catch (error) {
            throw new Error(`${key}: ${error instanceof Error ? error.message : error}`);
        } finally {
            pending.delete(key);
        }
    };
    const inline = async (source: string, base: string): Promise<string> => {
        if (!source || source.startsWith("#") || source.startsWith("data:")) return source;
        const url = keyOf(source, base);
        const asset = await resource(url);
        return `data:${asset.type};base64,${asset.data.toString("base64")}${url.hash}`;
    };
    const css = async (source: string, base: string): Promise<string> => {
        const tree = postcss.parse(source);
        const values: { value: string; set: (value: string) => void; imports?: boolean }[] = [];
        tree.walkDecls((node) => {
            values.push({
                value: node.value,
                set: (value) => {
                    node.value = value;
                },
            });
        });
        tree.walkAtRules((node) => {
            values.push({
                value: node.params,
                set: (value) => {
                    node.params = value;
                },
                imports: node.name.toLowerCase() === "import",
            });
        });
        for (const item of values) {
            const parsed = valueParser(item.value);
            const urls: valueParser.Node[] = [];
            parsed.walk((node) => {
                if (node.type === "function" && node.value.toLowerCase() === "url") {
                    urls.push(node);
                    return false;
                }
                if (node.type === "function" && /^(?:-webkit-)?image-set$/i.test(node.value))
                    urls.push(...node.nodes.filter((child) => child.type === "string"));
            });
            const first = parsed.nodes.find(
                (node) => node.type !== "space" && node.type !== "comment",
            );
            if (item.imports && first?.type === "string") urls.push(first);
            for (const node of urls) {
                const source =
                    node.type === "function"
                        ? valueParser.stringify(node.nodes).replace(/^(['"])(.*)\1$/, "$2")
                        : node.value;
                if (source.includes("\\"))
                    throw new Error(
                        "Escaped CSS resource URLs are not supported in static bundles",
                    );
                const next = await inline(source, base);
                if (node.type === "function")
                    node.nodes = [
                        {
                            type: "string",
                            quote: '"',
                            value: next,
                            sourceIndex: 0,
                            sourceEndIndex: 0,
                        },
                    ];
                else node.value = next;
            }
            item.set(parsed.toString());
        }
        return tree.toString();
    };
    const srcset = async (source: string, base: string): Promise<string> => {
        const candidates: string[] = [];
        let rest = source;
        while (rest.trim()) {
            rest = rest.replace(/^[\s,]+/, "");
            const token = /^\S+/.exec(rest)?.[0];
            if (!token) break;
            rest = rest.slice(token.length);
            const url = token.replace(/,+$/, "");
            const descriptor = token.endsWith(",") ? "" : (/^[^,]*/.exec(rest)?.[0] ?? "");
            if (!token.endsWith(",")) rest = rest.slice(descriptor.length).replace(/^,/, "");
            candidates.push(`${await inline(url, base)}${descriptor}`);
        }
        return candidates.join(", ");
    };
    const markup = async (source: string, base: string): Promise<string> => {
        const tree = parseFragment(source);
        const walk = async (parent: Html.ParentNode): Promise<void> => {
            for (const node of [...parent.childNodes]) {
                if (!("tagName" in node)) continue;
                const attr = (name: string) => node.attrs.find((item) => item.name === name)?.value;
                const href = attr("href");
                if (node.tagName === "base" && href) base = keyOf(href, base).href;
                if (
                    ["script", "base"].includes(node.tagName) ||
                    (node.tagName === "meta" && attr("http-equiv"))
                ) {
                    parent.childNodes.splice(parent.childNodes.indexOf(node), 1);
                    continue;
                }
                node.attrs = node.attrs.filter(
                    (item) =>
                        !/^on/i.test(item.name) &&
                        ![
                            "ping",
                            "integrity",
                            "crossorigin",
                            "nonce",
                            "formaction",
                            "action",
                        ].includes(item.name),
                );
                if (node.tagName === "link" && !/^(stylesheet|icon)$/i.test(attr("rel") ?? "")) {
                    parent.childNodes.splice(parent.childNodes.indexOf(node), 1);
                    continue;
                }
                for (const item of node.attrs) {
                    if (item.name === "style") item.value = await css(item.value, base);
                    else if (item.name === "srcdoc") item.value = await markup(item.value, base);
                    else if (item.name === "srcset" || item.name === "imagesrcset")
                        item.value = await srcset(item.value, base);
                    else if (
                        ["src", "poster", "background"].includes(item.name) ||
                        (item.name === "data" && node.tagName === "object") ||
                        (item.name === "href" && !["a", "area"].includes(node.tagName))
                    )
                        item.value = await inline(item.value, base);
                    else if (item.name === "href" && !item.value.startsWith("#")) {
                        const url = new URL(item.value, base);
                        item.value = /^(https?:|mailto:)$/.test(url.protocol) ? url.href : "#";
                    }
                }
                if (node.tagName === "style") {
                    for (const child of node.childNodes)
                        if ("value" in child) child.value = await css(child.value, base);
                }
                if (node.tagName === "iframe") node.attrs.push({ name: "sandbox", value: "" });
                await walk("content" in node ? (node as Html.Template).content : node);
            }
        };
        await walk(tree);
        return serialize(tree);
    };
    for (const entry of entries) {
        if (
            /\.(svg|html?)$/i.test(entry.name) &&
            (figures.has(entry.name) ||
                /^(?:figures|icons)\//.test(entry.name) ||
                (entry.name.startsWith("themes/") &&
                    [...figures].some((file) => entry.name.endsWith(`/${file}`))))
        ) {
            const base = `bundle:///${entry.name.split("/").map(encodeURIComponent).join("/")}`;
            const data = await resource(new URL(base));
            result.set(entry.name, { name: entry.name, data: data.data });
        }
        if (!/\.(md|callouth)$/.test(entry.name)) continue;
        let source = decode(entry.data);
        const changes: { start: number; end: number; value: string }[] = [];
        const images = embeddedImages(parseMdast(source));
        for (const image of images) {
            if (!isRemoteTextfile(image.url)) continue;
            const remote = remoteTextfileSource(image.url);
            if (remote.ref) throw new Error("Git URL embeds require a public HTTPS file URL");
            const url = keyOf(remote.url, image.url);
            const asset = await resource(url, false);
            const ext =
                Object.entries(types).find(([, type]) => type === asset.type)?.[0] ??
                (extension(url.href) || "txt");
            const name = `files/bundle/${createHash("sha256").update(url.href).digest("hex")}.${ext}`;
            const data =
                asset.type === "text/html"
                    ? Buffer.from(`<!--fig\ntitle: ${url.hostname}\n-->\n${decode(asset.data)}`)
                    : asset.data;
            const existing = result.get(name);
            if (existing && !existing.data.equals(data))
                throw new Error(`Bundle resource path is already in use: ${name}`);
            result.set(name, { name, data });
            const hash = new URL(image.url).hash;
            const range = /^#(?:L\d+(?:-L\d+)?|H)$/.test(hash) ? hash : "";
            const start = image.position?.start.offset,
                end = image.position?.end.offset;
            if (start === undefined || end === undefined)
                throw new Error(`Cannot rewrite embed: ${image.url}`);
            const alt = (image.alt ?? "").replace(/[\\[\]]/g, "\\$&");
            changes.push({
                start,
                end,
                value: `![${alt}](${name}${range}${image.title ? ` "${image.title.replace(/[\\"]/g, "\\$&")}"` : ""})`,
            });
        }
        for (const change of changes.sort((a, b) => b.start - a.start))
            source = source.slice(0, change.start) + change.value + source.slice(change.end);
        result.set(entry.name, { name: entry.name, data: Buffer.from(source) });
    }
    return [...result.values()];
};
