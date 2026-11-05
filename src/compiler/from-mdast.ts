// Converter from dialect mdast → normalized Block AST (internal module for build / preview only,
// outside the publish surface). The consumer contract (Block / TocEntry / slugify) lives in
// blocks.ts; validation is handled by dialect.ts.
import { basename, extname } from "node:path";
import type { Heading, List as MdList, Table as MdTable, PhrasingContent, Root } from "mdast";
import type { ContainerDirective } from "mdast-util-directive";
import {
    type Block,
    type CalloutItem,
    type ListItem,
    slugify,
    type TocEntry,
} from "../core/blocks.js";
import { parseFileEmbed } from "../core/file-embed.js";
import { standaloneImages } from "../core/markdown.js";
import type { PreviewSettings } from "../core/previewers.js";
import { parseSchemaSource } from "../core/schema-graph.js";
import { directiveRawBody } from "../core/taxonomy.js";
import { parseTermReference, termFileUrl } from "../core/term-reference.js";
import { textfileName } from "../core/textfile.js";
import { parseContentCode } from "./code-blocks.js";
import { figureName } from "./figures.js";

// Turn inline nodes (text / `code` / [text](url)) back into a mini-syntax string. Assumes the
// dialect validator rejects anything but these 3 kinds (= the reverse conversion is faithful).
const inlineToText = (nodes: PhrasingContent[]): string =>
    nodes
        .map((n) => {
            switch (n.type) {
                case "text":
                    return n.value.replace(/(\[[^\]]*\]\([^)]*\))/g, "\\$1");
                case "inlineCode":
                    return `\`${n.value}\``;
                case "link": {
                    let url = n.url;
                    try {
                        const file = parseTermReference(url);
                        if (file) url = termFileUrl(file);
                    } catch {
                        /* Reported by validation. */
                    }
                    return `[${inlineToText(n.children)}](${url})`;
                }
                default:
                    return "";
            }
        })
        .join("");

const listItems = (n: MdList): ListItem[] =>
    n.children.map((li) => {
        const text = li.children
            .filter((c) => c.type === "paragraph")
            .map((c) => inlineToText(c.children))
            .join("");
        const nested = li.children.filter((c) => c.type === "list") as MdList[];
        if (nested.length === 0) {
            return text;
        }
        return {
            text,
            children: nested.flatMap((c) => listItems(c)),
            ...(nested[0]?.ordered ? { ordered: true } : {}),
        };
    });

const tableBlock = (t: MdTable): Block => {
    const [head, ...rows] = t.children;
    return {
        type: "table",
        headers: (head?.children ?? []).map((c) => inlineToText(c.children)),
        rows: rows.map((r) => r.children.map((c) => inlineToText(c.children))),
    };
};

// `[caption]` = a leaf's children themselves; for a container, the leading paragraph carrying
// data.directiveLabel.
const captionOf = (d: ContainerDirective): { caption?: string } => {
    const head = d.children[0];
    const label =
        head?.type === "paragraph" && head.data != null && "directiveLabel" in head.data
            ? head.children
            : [];
    return label.length > 0 ? { caption: inlineToText(label) } : {};
};

/**
 * Dialect mdast → normalized Block[] + TOC. Heading slugs are made unique within the document.
 * `raw` is the whole source document (front-matter included) — needed so directives whose
 * content isn't interpreted as markdown, like `:::schema`, can read raw text by position offset.
 * `lines` holds the source start line at the same index as blocks (1-indexed relative to the
 * whole raw, as root is).
 * Only the edit tool's "body element ↔ source line" mapping uses it (the artifact/Block contract
 * is unaffected).
 */
export const toBlocks = (
    root: Root,
    raw: string,
    settings?: PreviewSettings,
    file?: string,
): { blocks: Block[]; toc: TocEntry[]; lines: number[] } => {
    const blocks: Block[] = [];
    const toc: TocEntry[] = [];
    const lines: number[] = [];
    const seen = new Map<string, number>();
    let unslugged = 0;

    for (const n of root.children) {
        // Every push to blocks also pushes the source line in lockstep (defined in one place).
        const add = (b: Block): void => {
            blocks.push(b);
            lines.push(n.position?.start.line ?? 1);
        };
        switch (n.type) {
            case "yaml":
                break;
            case "heading": {
                const h = n as Heading;
                const depth = h.depth as 1 | 2 | 3;
                const text = inlineToText(h.children);
                // Headings with no ASCII slug (e.g. all-Japanese text) are numbered per doc.
                const base = slugify(text) || `section-${++unslugged}`;
                const dup = seen.get(base) ?? 0;
                seen.set(base, dup + 1);
                const slug = dup === 0 ? base : `${base}-${dup}`;
                toc.push({ depth, text, slug });
                add({ type: "h", level: depth, text, slug });
                break;
            }
            case "paragraph": {
                const images = standaloneImages(n);
                if (!images.length) add({ type: "p", text: inlineToText(n.children) });
                for (const image of images) {
                    try {
                        const { file, range, kind } = parseFileEmbed(image.url, settings);
                        if (kind !== "textfile") {
                            add({
                                type: "figureRef",
                                name: figureName(file),
                                ...(image.alt ? { caption: image.alt } : {}),
                            });
                            lines[lines.length - 1] = image.position?.start.line ?? 1;
                            continue;
                        }
                        add({
                            type: "code",
                            filename: file,
                            ...(range !== undefined ? { range } : {}),
                            ...(image.alt ? { alt: image.alt } : {}),
                            lang: (
                                extname(textfileName(file)).slice(1) || basename(textfileName(file))
                            ).toLowerCase(),
                            lines: [],
                        });
                        lines[lines.length - 1] = image.position?.start.line ?? 1;
                    } catch {
                        // parseDoc reports malformed URLs; do not try to read them.
                    }
                }
                break;
            }
            case "list":
                add({ type: "list", items: listItems(n), ...(n.ordered ? { ordered: true } : {}) });
                break;
            case "code": {
                const parsed = parseContentCode(n, raw, file);
                if (parsed) {
                    for (const block of parsed.blocks) add(block);
                    break;
                }
                add({
                    type: "code",
                    lines: n.value.split("\n"),
                    ...(n.lang != null ? { lang: n.lang } : {}),
                });
                break;
            }
            case "table":
                add(tableBlock(n));
                break;
            case "containerDirective": {
                const d = n as ContainerDirective;
                if (d.name === "callout") {
                    const body: CalloutItem[] = d.children
                        .filter((c) => !(c.data && "directiveLabel" in c.data))
                        .flatMap((c): CalloutItem[] => {
                            if (c.type === "paragraph") {
                                return [{ type: "p", text: inlineToText(c.children) }];
                            }
                            if (c.type === "list") {
                                const l = c as MdList;
                                return [
                                    {
                                        type: "list",
                                        items: listItems(l),
                                        ...(l.ordered ? { ordered: true } : {}),
                                    },
                                ];
                            }
                            return [];
                        });
                    const { caption } = captionOf(d);
                    add({ type: "callout", ...(caption != null ? { title: caption } : {}), body });
                } else if (d.name === "schema") {
                    // The content is raw DSL text, not markdown = slice it from raw and read it.
                    // Parsed at build time with the model baked into the artifact (consumers
                    // don't parse). DSL errors are already validated by dialect.ts = render
                    // partial results here.
                    const start = d.position?.start.offset;
                    const end = d.position?.end.offset;
                    const source =
                        start == null || end == null ? "" : directiveRawBody(raw.slice(start, end));
                    const caption = captionOf(d);
                    add({
                        type: "schemaGraph",
                        ...caption,
                        graph: parseSchemaSource(source).model,
                        source,
                    });
                }
                break;
            }
            default:
                break;
        }
    }
    return { blocks, toc, lines };
};
