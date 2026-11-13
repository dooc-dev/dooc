// Validate authored Markdown, front matter, semantic code fences, and file references.
import type { Image, Link, Node, Parent, Root } from "mdast";
import { visit } from "unist-util-visit";
import type { TermEntry } from "../core/content-types.js";
import { parseFigureLink, parseFileEmbed } from "../core/file-embed.js";
import { contentLinks, embeddedImages, parseMdast } from "../core/markdown.js";
import type { PreviewSettings } from "../core/previewers.js";
import { isReferenceUrl, parseDocLink } from "../core/routing.js";
import { parseTermReference } from "../core/term-reference.js";
import { parseTextfileRange } from "../core/textfile.js";
import { parseContentCode } from "./code-blocks.js";

export { parseMdast } from "../core/markdown.js";

export interface ParsedDoc {
    terms: TermEntry[];
    /** Body text: the whole source. */
    body: string;
    /** Source passed to parse; root position offsets use it. */
    source: string;
    root: Root;
    errors: string[];
}

// Unsupported nodes are reported before conversion so source content is never silently dropped.
const ALLOWED_TYPES = new Set([
    "root",
    "yaml",
    "paragraph",
    "heading",
    "list",
    "listItem",
    "code",
    "inlineCode",
    "table",
    "tableRow",
    "tableCell",
    "text",
    "link",
    "image",
    "strong",
    "emphasis",
    "blockquote",
]);

const line = (n: Node): string => (n.position ? `L${n.position.start.line}` : "L?");

// Quotes retain their block structure even when nested inside list items.
const checkListItem = (n: Parent, errors: string[]): void => {
    for (const child of n.children) {
        if (child.type !== "paragraph" && child.type !== "list" && child.type !== "blockquote") {
            errors.push(
                `${line(child)}: ${child.type} is not allowed directly under listItem (paragraph / list / quote only)`,
            );
        }
    }
};

const checkLink = (n: Link, errors: string[]): void => {
    if (!isReferenceUrl(n.url))
        errors.push(`${line(n)}: links require a local reference, HTTP(S) URL or email address`);
    try {
        parseDocLink(n.url);
        parseFigureLink(n.url);
        parseTermReference(n.url);
    } catch (error) {
        errors.push(`${line(n)}: ${error instanceof Error ? error.message : error}`);
    }
    if (n.url.startsWith("doc:"))
        errors.push(`${line(n)}: use a Markdown file link instead of doc:`);
    if (n.url === "") {
        errors.push(`${line(n)}: link with an empty URL`);
    }
};

export const parseDoc = (input: string, settings?: PreviewSettings, file?: string): ParsedDoc => {
    const errors: string[] = [];
    const raw = input;
    const root = parseMdast(raw);
    const embeds = new Set(embeddedImages(root));
    const terms: TermEntry[] = [];

    // Titles live in the manifest; a leading YAML block would otherwise render as stray text.
    if (root.children[0]?.type === "yaml")
        errors.push("front-matter (---) is not supported; set the title in dooc.yaml");
    const body = input;

    visit(root, (node, _index, parent) => {
        if (
            node.type === "text" &&
            /(?:^|\n)[ \t]*:{2,}[a-z]+\b/.test(
                raw.slice(node.position?.start.offset, node.position?.end.offset),
            )
        )
            errors.push(
                `${line(node)}: removed directive; use Markdown file links or callouth / schemath / graphth / termth code fences`,
            );
        if (!ALLOWED_TYPES.has(node.type)) {
            const hint =
                node.type === "html" ? ' (put "<" inside backticks or escape it as "\\<")' : "";
            errors.push(`${line(node)}: ${node.type} is outside the dialect${hint}`);
            return;
        }
        switch (node.type) {
            case "code": {
                const parsed = parseContentCode(node, raw, file);
                if (!parsed) break;
                if (parent?.type !== "root") {
                    errors.push(`${line(node)}: ${node.lang} must be a top-level code block`);
                    break;
                }
                for (const error of parsed.errors)
                    errors.push(
                        `L${(node.position?.start.line ?? 0) + 1 + error.line}: ${node.lang} ${error.message}`,
                    );
                for (const block of parsed.blocks)
                    if (block.type === "term") terms.push(block.entry);
                break;
            }
            case "image": {
                if (!embeds.has(node as Image)) {
                    errors.push(`${line(node)}: file previews must occupy a standalone paragraph`);
                    break;
                }
                try {
                    const { range } = parseFileEmbed((node as Image).url, settings);
                    if (range !== undefined) parseTextfileRange(range);
                } catch (error) {
                    errors.push(`${line(node)}: ${error instanceof Error ? error.message : error}`);
                }
                break;
            }
            case "listItem":
                checkListItem(node as Parent, errors);
                break;
            case "link":
                checkLink(node as Link, errors);
                break;
            default:
                break;
        }
    });

    return { body, source: raw, root, errors, terms };
};

/**
 * Collect files referenced by Markdown links and embeds for validation and export.
 */
export const collectRefs = (
    root: Root,
    settings?: PreviewSettings,
): { figures: string[]; terms: string[]; textfiles: string[] } => {
    const figures: string[] = [];
    const terms: string[] = [];
    const textfiles: string[] = [];
    for (const image of embeddedImages(root)) {
        try {
            const { file, kind } = parseFileEmbed(image.url, settings);
            if (kind === "textfile") textfiles.push(file);
            else if (kind !== "external") figures.push(file);
        } catch {
            // Invalid references are reported by parseDoc and must not reach file I/O.
        }
    }
    for (const node of contentLinks(root)) {
        try {
            const file = parseTermReference(node.url);
            if (file) terms.push(file);
            const figure = parseFigureLink(node.url);
            if (figure) figures.push(figure.file);
        } catch {
            /* Validation reports invalid file paths. */
        }
    }
    return {
        figures: [...new Set(figures)],
        terms: [...new Set(terms)],
        textfiles: [...new Set(textfiles)],
    };
};
