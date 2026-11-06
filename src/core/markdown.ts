import type { Image, Link, List as MdList, PhrasingContent, Root, RootContent } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import type { Block, ListItem } from "./blocks.js";
import { parseFigureLink } from "./file-embed.js";
import { parseDocLink } from "./routing.js";
import { parseTermReference, termFileUrl } from "./term-reference.js";

const processor = unified().use(remarkParse).use(remarkFrontmatter).use(remarkGfm);
const inlinePrinter = unified().use(remarkGfm).use(remarkStringify);

export const parseMdast = (raw: string): Root => processor.parse(raw);

/** File previews occupy whole paragraphs; prose, lists and tables keep their inline layout. */
export const standaloneImages = (node: RootContent): Image[] =>
    node.type === "paragraph" &&
    node.children.every(
        (child) => child.type === "image" || (child.type === "text" && !child.value.trim()),
    )
        ? node.children.filter((child): child is Image => child.type === "image")
        : [];

export const embeddedImages = (root: Root): Image[] => {
    const images: Image[] = [];
    visit(root, "paragraph", (node, _index, parent) => {
        if (parent?.type === "root" || parent?.type === "blockquote")
            images.push(...standaloneImages(node));
    });
    return images;
};

export const offsetAt = (body: string, line: number, column: number): number =>
    body
        .split("\n")
        .slice(0, line - 1)
        .reduce((offset, text) => offset + text.length + 1, 0) +
    column -
    1;

/** A closed fenced block. Offsets are UTF-16 offsets in the editor body. */
export function codeBlockAt(body: string, position: number) {
    if (!Number.isInteger(position) || position < 0 || position > body.length) {
        throw new Error("Invalid cursor position");
    }
    const tree = parseMdast(body);
    let block:
        | {
              start: number;
              end: number;
              topLevel: boolean;
              meta: string;
              from: number;
              to: number;
              language: string;
              code: string;
              indent: string;
              eol: string;
              marker: string;
              offsets: number[];
          }
        | undefined;
    visit(tree, (node, _index, parent) => {
        if (node.type !== "code") return;
        const start = node.position
            ? offsetAt(body, node.position.start.line, node.position.start.column)
            : undefined;
        const end = node.position
            ? offsetAt(body, node.position.end.line, node.position.end.column)
            : undefined;
        if (start == null || end == null || position < start || position > end) return;
        const raw = body.slice(start, end);
        const opening = /^( {0,3})(`{3,}|~{3,})[^\r\n]*\r?\n/.exec(raw);
        if (!opening?.[2]) throw new Error("Select a fenced code block");
        const closing = /(?:^|\n)([ \t>]*)(`{3,}|~{3,})[ \t]*$/.exec(raw);
        if (
            !closing?.[2] ||
            closing[2][0] !== opening[2][0] ||
            closing[2].length < opening[2].length
        )
            throw new Error("Close the code fence before running a tool");
        const from = start + opening[0].length;
        const to = start + closing.index + (raw[closing.index] === "\n" ? 1 : 0);
        if (to < from) throw new Error("Invalid code fence");
        const offsets: number[] = [];
        let offset = from;
        const lines = body.slice(from, to).split(/\r?\n/);
        lines.pop();
        const values = node.value.replaceAll("\r\n", "\n").split("\n");
        for (const [index, line] of lines.entries()) {
            const value = values[index] ?? "";
            if (!line.endsWith(value)) throw new Error("Unsupported code indentation");
            offsets.push(offset + line.length - value.length);
            offset += line.length + (body[offset + line.length] === "\r" ? 2 : 1);
        }
        const code = node.value.replaceAll("\r\n", "\n");
        if (!offsets.length) offsets.push(from);
        block = {
            start,
            end,
            topLevel: parent?.type === "root",
            meta: node.meta ?? "",
            from,
            to,
            language: node.lang ?? "",
            code,
            indent: closing[1] ?? "",
            eol: opening[0].endsWith("\r\n") ? "\r\n" : "\n",
            marker: opening[2],
            offsets,
        };
    });
    if (!block) throw new Error("Place the cursor inside a fenced code block");
    return block;
}

/** Keep inline content as standard Markdown, including escapes and nested emphasis. */
export const inlineToText = (nodes: PhrasingContent[]): string => {
    const root: Root = {
        type: "root",
        children: [{ type: "paragraph", children: structuredClone(nodes) }],
    };
    visit(root, "link", (node) => {
        try {
            const file = parseTermReference(node.url);
            if (file) node.url = termFileUrl(file);
            const ref = parseDocLink(node.url) ?? parseFigureLink(node.url);
            if (ref)
                node.url =
                    termFileUrl(ref.file) +
                    (ref.fragment ? `#${encodeURIComponent(ref.fragment)}` : "");
        } catch {
            /* Reported by validation. */
        }
    });
    return inlinePrinter.stringify(root).replace(/\n$/, "");
};

export const listItems = (n: MdList, convert?: (nodes: RootContent[]) => Block[]): ListItem[] =>
    n.children.map((li) => {
        if (convert && li.children.some((child) => child.type === "blockquote"))
            return { blocks: convert(li.children) };
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
            children: nested.flatMap((c) => listItems(c, convert)),
            ...(nested[0]?.ordered ? { ordered: true } : {}),
        };
    });

/** Links inside callouts are authored Markdown; other code fences remain opaque. */
export const contentLinks = (root: Root): Link[] => {
    const links: Link[] = [];
    visit(root, (node) => {
        if (node.type === "link") links.push(node);
        if (node.type === "code" && node.lang === "callouth") {
            for (const link of contentLinks(parseMdast(node.value))) {
                if (link.position) {
                    link.position.start.line += node.position?.start.line ?? 0;
                    link.position.end.line += node.position?.start.line ?? 0;
                }
                links.push(link);
            }
        }
    });
    return links;
};
