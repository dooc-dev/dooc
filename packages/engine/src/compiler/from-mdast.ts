// Converter from dialect mdast → normalized Block AST (internal module for build / preview only,
// outside the publish surface). The consumer contract (Block / TocEntry / slugify) lives in
// blocks.ts; validation is handled by dialect.ts.

import type { Heading, Table as MdTable, Root, RootContent } from "mdast";
import { type Block, slugify, type TocEntry } from "../core/blocks.js";
import { parseFileEmbed } from "../core/file-embed.js";
import { inlineSegmenter } from "../core/inline.js";
import { inlineToText, listItems, standaloneImages } from "../core/markdown.js";
import type { PreviewSettings } from "../core/previewers.js";
import { textfileName } from "../core/textfile.js";
import { parseContentCode } from "./code-blocks.js";
import { figureName } from "./figures.js";
import { basename, extname } from "./host.js";

const tableBlock = (t: MdTable): Block => {
    const [head, ...rows] = t.children;
    return {
        type: "table",
        headers: (head?.children ?? []).map((c) => inlineToText(c.children)),
        rows: rows.map((r) => r.children.map((c) => inlineToText(c.children))),
    };
};

/**
 * Dialect mdast → normalized Block[] + TOC. Heading slugs are made unique within the document.
 * `raw` is the whole source document, used to validate semantic code fences.
 * `lines` holds the source start line at the same index as blocks (1-indexed relative to the
 * whole raw, as root is).
 * Only the edit tool's "body element ↔ source line" mapping uses it (the rendering model
 * is unaffected).
 */
export const toBlocks = (
    root: Root,
    raw: string,
    settings?: PreviewSettings,
    file?: string,
): { blocks: Block[]; toc: TocEntry[]; lines: number[] } => {
    const toc: TocEntry[] = [];
    const lines: number[] = [];
    const seen = new Map<string, number>();
    let unslugged = 0;

    const inline = inlineSegmenter();
    const convert = (nodes: RootContent[], topLevel = false): Block[] => {
        const blocks: Block[] = [];
        for (const n of nodes) {
            // Every push to blocks also pushes the source line in lockstep (defined in one place).
            const add = (b: Block): void => {
                blocks.push(b);
                if (topLevel) lines.push(n.position?.start.line ?? 1);
            };
            switch (n.type) {
                case "yaml":
                    break;
                case "heading": {
                    const h = n as Heading;
                    const depth = h.depth;
                    const text = inlineToText(h.children);
                    // Headings with no ASCII slug (e.g. all-Japanese text) are numbered per doc.
                    const label = inline(text)
                        .map((part) => part.text)
                        .join("");
                    const base = slugify(label) || `section-${++unslugged}`;
                    const dup = seen.get(base) ?? 0;
                    seen.set(base, dup + 1);
                    const slug = dup === 0 ? base : `${base}-${dup}`;
                    toc.push({ depth, text: label, slug });
                    add({ type: "h", level: depth, text, slug });
                    break;
                }
                case "blockquote":
                    add({ type: "quote", blocks: convert(n.children) });
                    break;
                case "paragraph": {
                    const images = standaloneImages(n);
                    if (!images.length) add({ type: "p", text: inlineToText(n.children) });
                    for (const image of images) {
                        try {
                            const { file, range, tableMode, kind } = parseFileEmbed(
                                image.url,
                                settings,
                            );
                            if (kind === "external") {
                                add({
                                    type: "external",
                                    url: file,
                                    ...(image.alt ? { alt: image.alt } : {}),
                                });
                                if (topLevel)
                                    lines[lines.length - 1] = image.position?.start.line ?? 1;
                                continue;
                            }
                            if (kind !== "textfile") {
                                add({
                                    type: "figureRef",
                                    name: figureName(file),
                                    alt: image.alt ?? "",
                                });
                                if (topLevel)
                                    lines[lines.length - 1] = image.position?.start.line ?? 1;
                                continue;
                            }
                            add({
                                type: "code",
                                filename: file,
                                ...(range !== undefined ? { range } : {}),
                                ...(tableMode ? { tableMode } : {}),
                                ...(image.alt ? { alt: image.alt } : {}),
                                lang: (
                                    extname(textfileName(file)).slice(1) ||
                                    basename(textfileName(file))
                                ).toLowerCase(),
                                lines: [],
                            });
                            if (topLevel) lines[lines.length - 1] = image.position?.start.line ?? 1;
                        } catch {
                            // parseDoc reports malformed URLs; do not try to read them.
                        }
                    }
                    break;
                }
                case "list":
                    add({
                        type: "list",
                        items: listItems(n, convert),
                        ...(n.ordered ? { ordered: true } : {}),
                    });
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
                default:
                    break;
            }
        }
        return blocks;
    };
    return { blocks: convert(root.children, true), toc, lines };
};
