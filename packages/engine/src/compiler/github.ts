import { type DefaultTreeAdapterTypes as Html, parseFragment } from "parse5";
import type { Block, ListItem } from "../core/blocks.js";
import type { FigureEntry, TermEntry } from "../core/content-types.js";
import { fileExtension, localFile } from "../core/files.js";
import { blocksHtml, escapeHtml as esc, type RenderCtx } from "../core/html.js";
import { contentLinks, embeddedImages, parseMdast } from "../core/markdown.js";
import { sortSubformatRecords } from "../core/subformats.js";
import { docDisplayName } from "../core/taxonomy.js";
import { termAnchor } from "../core/term-reference.js";
import { parseFileReference } from "../core/textfile.js";
import { assetReferences } from "./asset-references.js";
import type { Compiled } from "./compile.js";
import { withSvgTheme } from "./figures.js";
import { createHash, posix } from "./host.js";
import type { ZipEntry } from "./zip.js";

const attr = (node: Html.Element, name: string): string | undefined =>
    node.attrs.find((item) => item.name === name)?.value;
const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");
const digest = (value: string | Buffer): string =>
    createHash("sha256").update(value).digest("hex").slice(0, 24);
const anchor = (id: string): string => `<a name="${esc(id)}"></a>`;
const details = (title: string, body: string): string =>
    `<details>\n<summary>${esc(title)}</summary>\n\n${body}\n\n</details>`;
const fence = (source: string, lang = ""): string => {
    const ticks = "`".repeat(
        Math.max(3, ...Array.from(source.matchAll(/`+/g), (m) => m[0].length + 1)),
    );
    return `${ticks}${lang.replace(/[^\w+-]/g, "")}\n${source}\n${ticks}`;
};
const mime: Record<string, string> = {
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    css: "text/css",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
};
const allowed = new Set(
    "a p br hr h1 h2 h3 h4 h5 h6 strong b em i s del code pre blockquote ul ol li table thead tbody tfoot tr th td details summary img picture source dl dt dd sub sup kbd div span".split(
        " ",
    ),
);
const dropped = new Set(
    "script style link meta base iframe object embed canvas form input select textarea button template".split(
        " ",
    ),
);

/** GitHub renders a restricted HTML subset inside Markdown; the reader itself cannot run there. */
export const githubEntries = (
    sites: { site: Compiled; locale?: string }[],
    sources: readonly ZipEntry[],
    authoredSources: readonly ZipEntry[] = sources,
    options: { html?: boolean; resources?: "copy" | "reference"; referenceBase?: string } = {},
): { entries: ZipEntry[]; warnings: string[] } => {
    const input = new Map(sources.map((entry) => [entry.name, entry.data]));
    const authored = new Map(authoredSources.map((entry) => [entry.name, entry.data]));
    const output = new Map<string, Buffer>();
    const references = new Set<string>();
    const imageWidths = new Map<string, number>();
    const warnings = new Set<string>();
    const warn = (message: string) => warnings.add(message);
    const code = (source: string, lang = "") =>
        options.html ? `<pre><code>${esc(source)}</code></pre>` : fence(source, lang);
    const put = (name: string, data: string | Buffer): string => {
        output.set(name, Buffer.isBuffer(data) ? data : Buffer.from(data));
        return name;
    };
    const resolveAsset = (url: string, base: string): string | undefined => {
        if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(url)) return;
        try {
            const { file } = parseFileReference(url);
            const path = posix.normalize(
                file.startsWith("/") ? file.slice(1) : posix.join(posix.dirname(base), file),
            );
            return localFile(path) ? path : undefined;
        } catch {
            return;
        }
    };
    const copy = (file: string): string | undefined => {
        const data = input.get(file);
        if (!data || !localFile(file.replace(/[?#]/g, "_"))) {
            warn(`Source is not included: ${file}`);
            return;
        }
        const name = `resources/${file}`;
        if (options.resources === "reference" && authored.has(file)) {
            const target = posix.join(options.referenceBase ?? "..", file);
            references.add(target);
            return target;
        }
        if (output.has(name)) return name;
        put(name, data);
        if (/^(svg|html?|css)$/.test(fileExtension(file)))
            assetReferences(data.toString("utf8"), fileExtension(file), (url) => {
                const dependency = resolveAsset(url, file);
                if (dependency) copy(dependency);
                return url;
            });
        return name;
    };
    const svgAsset = (markup: string, base: string): string => {
        const pending = new Set<string>();
        const inlineAssets = (source: string, file: string): string =>
            assetReferences(source, fileExtension(file), (url, embedded) => {
                if (!embedded || url.startsWith("#") || url.startsWith("data:")) return url;
                const path = resolveAsset(url, file);
                const data = path && input.get(path);
                const type = path && mime[fileExtension(path)];
                if (!path || !data || !type) {
                    warn(`SVG dependency cannot be displayed in a GitHub image: ${file}: ${url}`);
                    return "";
                }
                if (pending.has(path)) throw new Error(`Circular SVG dependency: ${path}`);
                pending.add(path);
                const content = /\.(css|svg)$/i.test(path)
                    ? Buffer.from(inlineAssets(data.toString("utf8"), path))
                    : data;
                pending.delete(path);
                return `data:${type};base64,${content.toString("base64")}`;
            });
        const themed = markup.includes("data-doc-figure-theme") ? markup : withSvgTheme(markup);
        const tree = parseFragment(
            inlineAssets(themed, base.endsWith(".svg") ? base : `${base}.svg`),
        );
        const xml = (node: Html.ChildNode, namespace?: string): string => {
            if (node.nodeName === "#text") return esc((node as Html.TextNode).value);
            if (
                !("tagName" in node) ||
                ["script", "iframe", "object", "embed"].includes(node.tagName)
            )
                return "";
            const attrs = node.attrs.filter(
                (a) =>
                    !/^on/i.test(a.name) &&
                    a.name !== "data-sg-layout" &&
                    !(a.name === "href" && /^\s*(?:javascript|vbscript):/i.test(a.value)),
            );
            if (namespace !== node.namespaceURI && !attrs.some((a) => a.name === "xmlns"))
                attrs.push({ name: "xmlns", value: node.namespaceURI });
            if (
                attrs.some((a) => a.prefix === "xlink") &&
                !attrs.some((a) => a.name === "xlink" && a.prefix === "xmlns")
            )
                attrs.push({
                    name: "xlink",
                    prefix: "xmlns",
                    value: "http://www.w3.org/1999/xlink",
                });
            return `<${node.tagName}${attrs.map((a) => ` ${a.prefix ? `${a.prefix}:` : ""}${a.name}="${esc(a.value)}"`).join("")}>${node.childNodes.map((child) => xml(child, node.namespaceURI)).join("")}</${node.tagName}>`;
        };
        const svg = tree.childNodes.find((node) => "tagName" in node && node.tagName === "svg");
        if (!svg || !("tagName" in svg)) throw new Error(`SVG output is missing: ${base}`);
        const content = xml(svg);
        const file = put(`assets/${digest(content)}.svg`, content);
        const width = attr(svg, "width") ?? "";
        const pixels = /^[\d.]+(?:px)?$/.test(width)
            ? Number.parseFloat(width)
            : Number(
                  attr(svg, "viewBox")
                      ?.trim()
                      .split(/[\s,]+/)[2],
              );
        if (Number.isFinite(pixels) && pixels > 0) imageWidths.set(file, Math.ceil(pixels));
        return file;
    };

    for (const { site, locale } of sites) {
        const prefix = locale ? `locales/${locale}/` : "";
        const pages = new Map(
            site.docs.map((doc, index) => [
                doc.file,
                `${prefix}${index === 0 ? "README.md" : doc.library || doc.subformat ? `views/${doc.id}.md` : `pages/${doc.file}`}`,
            ]),
        );
        const termsFile = `${prefix}terms.md`;
        let page = `${prefix}README.md`;
        const relative = (file: string) => encodePath(posix.relative(posix.dirname(page), file));
        const link = (file: string, label: string, hash = "") =>
            `<a href="${esc(relative(file) + hash)}">${esc(label)}</a>`;
        const sourceLink = (file: string, label = "Source"): string => {
            if (/^https?:\/\//i.test(file)) return `<a href="${esc(file)}">${esc(label)}</a>`;
            const range = input.has(file) ? "" : (/#(?:L\d+(?:-L\d+)?|H)$/.exec(file)?.[0] ?? "");
            const target = copy(range ? file.slice(0, -range.length) : file);
            return target ? link(target, label, range) : "";
        };
        const href = (url: string, base = ""): string | undefined => {
            if (/^(https?:|mailto:)/i.test(url)) return url;
            if (url.startsWith("#")) return url;
            if (url.startsWith("/_github/"))
                return (
                    relative(url.slice(9).split("#")[0] ?? "") +
                    (url.includes("#") ? url.slice(url.indexOf("#")) : "")
                );
            if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) return;
            try {
                const { file: raw, range = "" } = parseFileReference(
                    url.replace(/^\/_files\/file\//, ""),
                );
                const file = base ? resolveAsset(url, base) : raw.replace(/^(\.\/)+/, "");
                if (!file) return;
                const emitted = posix.normalize(posix.join(posix.dirname(page), file));
                if (!base && (output.has(emitted) || references.has(emitted)))
                    return relative(emitted) + range;
                const target = pages.get(file) ?? copy(file);
                return target ? relative(target) + range : undefined;
            } catch {
                return;
            }
        };
        const image = (file: string, alt: string): string =>
            `<img src="${esc(relative(file))}" alt="${esc(alt)}"${imageWidths.has(file) ? ` width="${imageWidths.get(file)}"` : ""}>`;
        const ctx: RenderCtx = {
            figures: new Map(site.figures.map((figure) => [figure.name, figure])),
            terms: site.terms,
            docLinks: new Map([...pages].map(([file, target]) => [file, `/_github/${target}`])),
            termLinks: new Map(
                site.terms.map((term) => [term.id, `/_github/${termsFile}#${termAnchor(term.id)}`]),
            ),
        };
        const sanitize = (html: string, base = ""): string => {
            const walk = (node: Html.ChildNode): string => {
                if (node.nodeName === "#text") return esc((node as Html.TextNode).value);
                if (!("tagName" in node)) return "";
                const { tagName: tag } = node;
                const classes = (attr(node, "class") ?? "").split(" ");
                if (
                    dropped.has(tag) ||
                    attr(node, "hidden") !== undefined ||
                    classes.some((c) => ["dictpop", "figpop", "term-icon"].includes(c))
                )
                    return "";
                if (tag === "svg") {
                    // Use the shared graph renderer, but remove its surrounding figure element.
                    const markup = html.slice(
                        node.sourceCodeLocation?.startOffset,
                        node.sourceCodeLocation?.endOffset,
                    );
                    const title = node.childNodes.find((child) => child.nodeName === "title");
                    const label =
                        title && "childNodes" in title
                            ? title.childNodes
                                  .map((child) => ("value" in child ? child.value : ""))
                                  .join("")
                            : "";
                    return image(
                        svgAsset(markup, base || "diagram.svg"),
                        attr(node, "aria-label") ?? (label || "Diagram"),
                    );
                }
                const children = node.childNodes.map(walk).join("");
                const id = attr(node, "id");
                const start = id ? anchor(id) : "";
                if (!allowed.has(tag)) return `${start}<div>${children}</div>`;
                const attrs: string[] = [];
                for (const item of node.attrs) {
                    if (["href", "src"].includes(item.name)) {
                        let url = href(item.value, base);
                        if (item.name === "src" && item.value.startsWith("data:image/")) {
                            const match =
                                /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,([\s\S]+)$/.exec(
                                    item.value,
                                );
                            if (match) {
                                const data = Buffer.from(match[2] ?? "", "base64");
                                const target =
                                    match[1] === "svg+xml"
                                        ? svgAsset(data.toString("utf8"), base || "image.svg")
                                        : put(`assets/${digest(data)}.${match[1]}`, data);
                                url = relative(target);
                            }
                        }
                        if (url) attrs.push(`${item.name}="${esc(url)}"`);
                    } else if (
                        [
                            "alt",
                            "title",
                            "width",
                            "height",
                            "colspan",
                            "rowspan",
                            "open",
                            "name",
                            "start",
                        ].includes(item.name)
                    )
                        attrs.push(`${item.name}="${esc(item.value)}"`);
                }
                const attributes = attrs.length ? ` ${attrs.join(" ")}` : "";
                return `${start}<${tag}${attributes}>${["br", "hr", "img", "source"].includes(tag) ? "" : `${children}</${tag}>`}`;
            };
            return parseFragment(html, { sourceCodeLocationInfo: true })
                .childNodes.map(walk)
                .join("");
        };
        const termHtml = (term: TermEntry) =>
            `${anchor(termAnchor(term.id))}<h2>${esc(term.name)}</h2>${term.description ? `<p>${esc(term.description)}</p>` : ""}<p>${esc(term.definition)}</p>`;
        const figureImage = (fig: FigureEntry): string | undefined => {
            if (fig.kind === "svg") {
                let standalone = true;
                const original = authored.get(fig.file);
                if (
                    options.resources === "reference" &&
                    original &&
                    fileExtension(fig.file) === "svg"
                ) {
                    assetReferences(original.toString("utf8"), "svg", (url, embedded) => {
                        if (embedded && !/^(#|data:)/.test(url)) standalone = false;
                        return url;
                    });
                    if (standalone) return copy(fig.file);
                }
                return svgAsset(fig.markup, fig.file);
            }
            return fig.kind === "image" ? copy(fig.file) : undefined;
        };
        ctx.figurePreview = (fig, _class, alt) => {
            const file = figureImage(fig);
            if (file) return image(file, alt ?? fig.title ?? fig.name);
            if (fig.kind === "html") {
                warn(`HTML figure exported without its CSS or interactive controls: ${fig.file}`);
                return `${sanitize(fig.markup, fig.file)}<p>${sourceLink(fig.file)}</p>`;
            }
            return `<p>${sourceLink(fig.file, alt ?? fig.title ?? fig.file)}</p>`;
        };
        const blockImage = (block: Block): string | undefined => {
            if (block.type === "figureRef") {
                const figure = ctx.figures.get(block.name);
                return figure && figureImage(figure);
            }
            if (block.type === "graph" || block.type === "schemaGraph") {
                const html = blocksHtml([block], ctx);
                const start = html.indexOf("<svg ");
                if (start >= 0)
                    return svgAsset(
                        html.slice(start, html.indexOf("</svg>") + 6),
                        block.sourceFile ?? "diagram.svg",
                    );
            }
            return;
        };
        const renderList = (items: ListItem[], ordered = false): string => {
            const contents = items
                .map((item, index) => {
                    const marker = ordered ? `${index + 1}. ` : "- ";
                    const body =
                        typeof item === "string"
                            ? sanitize(blocksHtml([{ type: "p", text: item }], ctx))
                            : "blocks" in item
                              ? render(item.blocks)
                              : `${sanitize(blocksHtml([{ type: "p", text: item.text }], ctx))}\n\n${renderList(item.children, item.ordered)}`;
                    return options.html
                        ? `<li>${body}</li>`
                        : marker + body.replace(/\n/g, `\n${" ".repeat(marker.length)}`);
                })
                .join("\n\n");
            return options.html
                ? `<${ordered ? "ol" : "ul"}>${contents}</${ordered ? "ol" : "ul"}>`
                : contents;
        };
        const render = (blocks: Block[]): string =>
            blocks
                .map((block): string => {
                    if (block.type === "themeVariants") {
                        const fallback = blockImage(block.default);
                        const variants = Object.entries(block.variants).map(([theme, variant]) => ({
                            theme,
                            file: blockImage(variant),
                        }));
                        if (fallback && variants.every((variant) => variant.file))
                            return `<picture>${variants.map(({ theme, file }) => `<source media="(prefers-color-scheme: ${esc(theme)})" srcset="${esc(relative(file as string))}">`).join("")}${image(fallback, "alt" in block.default ? (block.default.alt ?? "Figure") : "Figure")}</picture>`;
                        return (
                            render([block.default]) +
                            "\n\n" +
                            Object.entries(block.variants)
                                .map(([theme, variant]) =>
                                    details(`${theme} variant`, render([variant])),
                                )
                                .join("\n\n")
                        );
                    }
                    if (block.type === "code") {
                        if (options.html && block.lang === "mermaid")
                            warn(
                                "Mermaid is exported as source code in GitHub HTML; Markdown ZIPs keep Mermaid fences.",
                            );
                        if (block.unavailable)
                            warn(
                                `Embedded code is unavailable; exported as a link: ${block.filename}`,
                            );
                        const label = block.filename
                            ? sourceLink(
                                  block.filename + (block.range ?? ""),
                                  block.alt || block.filename,
                              )
                            : "";
                        return `${label ? `<p>${label}</p>\n\n` : ""}${block.unavailable ? "" : code(block.lines.join("\n"), block.lang)}`;
                    }
                    if (block.type === "list") return renderList(block.items, block.ordered);
                    if (block.type === "quote")
                        return options.html
                            ? `<blockquote>${render(block.blocks)}</blockquote>`
                            : render(block.blocks)
                                  .split("\n")
                                  .map((line) => `> ${line}`)
                                  .join("\n");
                    if (block.type === "term") return termHtml(block.entry);
                    if (block.type === "external")
                        warn(`External preview exported as a link: ${block.url}`);
                    const rendered = sanitize(blocksHtml([block], ctx));
                    return (
                        rendered +
                        (block.sourceFile
                            ? `\n\n${sourceLink(block.sourceFile)}`
                            : block.type === "table" && block.dataSource
                              ? `\n\n${sourceLink(block.dataSource)}`
                              : (block.type === "graph" || block.type === "schemaGraph") &&
                                  block.source
                                ? `\n\n${details("Diagram source", code(block.source, block.type === "graph" ? "graphth" : "schemath"))}`
                                : "")
                    );
                })
                .join("\n\n");
        const navigation = () =>
            details(
                "Pages",
                `<ul>${site.docs.map((doc) => `<li>${link(pages.get(doc.file) as string, docDisplayName(doc, doc.id))}</li>`).join("")}</ul>`,
            );
        for (const doc of site.docs) {
            page = pages.get(doc.file) as string;
            const languages =
                sites.length > 1
                    ? `<p>${sites.map((other) => link(other.locale ? `locales/${other.locale}/README.md` : "README.md", other.locale ?? other.site.defaultLang)).join(" · ")}</p>\n\n`
                    : "";
            let body = render(doc.blocks);
            if (doc.library === "termth") body = site.terms.map(termHtml).join("\n\n");
            else if (doc.library === "urls" || doc.library === "url-previews") {
                const urls = new Set(
                    site.docs.flatMap((source) => {
                        const original =
                            authored.get(`${prefix}${source.file}`) ?? authored.get(source.file);
                        const tree = parseMdast(original?.toString("utf8") ?? source.body);
                        return (doc.library === "urls" ? contentLinks(tree) : embeddedImages(tree))
                            .map((node) => node.url)
                            .filter((url) => /^https?:\/\//i.test(url));
                    }),
                );
                body = `<ul>${[...urls].map((url) => `<li><a href="${esc(url)}">${esc(url)}</a></li>`).join("")}</ul>`;
            } else if (doc.library) {
                warn(`Library exported as a source listing without filters: ${doc.library}`);
                body = `<ul>${sources
                    .filter(({ name }) => fileExtension(name) === doc.library)
                    .map(({ name }) => `<li>${sourceLink(name, name)}</li>`)
                    .join("")}</ul>`;
            }
            if (doc.subformat) {
                const collection = doc.subformat;
                const layout = collection.layouts;
                const records = sortSubformatRecords(
                    collection.records,
                    collection.fields.find((field) => field.name === layout?.sort_by),
                    layout?.sort_order === "desc",
                );
                const groups = new Map<string, string[]>();
                for (const record of records) {
                    const group = layout?.group_by
                        ? String(record.data[layout.group_by] ?? "Ungrouped")
                        : "";
                    const title = String(record.data[layout?.card_title ?? "title"] ?? record.file);
                    const value = (item: unknown): string => {
                        if (typeof item === "string" && input.has(item))
                            return `<a href="${esc(href(encodePath(item)) ?? "#")}">${esc(item)}</a>`;
                        return `<code>${esc(typeof item === "string" ? item : JSON.stringify(item))}</code>`;
                    };
                    const table = `<table>${Object.entries(record.data)
                        .map(
                            ([key, item]) =>
                                `<tr><th>${esc(collection.fields.find((field) => field.name === key)?.title ?? key)}</th><td>${value(item)}</td></tr>`,
                        )
                        .join("")}</table>`;
                    const references = record.references
                        ?.map(
                            (ref) =>
                                `<li><a href="${esc(href(encodePath(ref.file)) ?? "#")}">${esc(ref.file)}</a></li>`,
                        )
                        .join("");
                    const rows = groups.get(group) ?? [];
                    rows.push(
                        details(
                            title,
                            `${table}\n\n${sourceLink(record.file)}${references ? `\n\n<ul>${references}</ul>` : ""}`,
                        ),
                    );
                    groups.set(group, rows);
                }
                body = [...groups]
                    .map(
                        ([group, rows]) =>
                            `${group ? `<h2>${esc(group)}</h2>\n\n` : ""}${rows.join("\n\n")}`,
                    )
                    .join("\n\n");
            }
            put(
                page,
                `${languages}<h1>${esc(docDisplayName(doc, doc.id))}</h1>\n\n${navigation()}\n\n${body}\n`,
            );
        }
        if (!site.docs.length) put(page, `<h1>${esc(site.title ?? "Documentation")}</h1>\n`);
        if (site.terms.length) put(termsFile, `${site.terms.map(termHtml).join("\n\n")}\n`);
    }
    return {
        entries: [...output].map(([name, data]) => ({ name, data })),
        warnings: [...warnings],
    };
};
