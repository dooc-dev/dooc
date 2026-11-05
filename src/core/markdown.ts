import type { Image, Root, RootContent } from "mdast";
import remarkDirective from "remark-directive";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { SKIP, visit } from "unist-util-visit";
import { findDirective } from "./taxonomy.js";

const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter)
    .use(remarkGfm)
    .use(remarkDirective);

export const parseMdast = (raw: string): Root => processor.parse(raw);

/** File previews occupy whole paragraphs; prose, lists and tables keep their inline layout. */
export const standaloneImages = (node: RootContent): Image[] =>
    node.type === "paragraph" &&
    node.children.every(
        (child) => child.type === "image" || (child.type === "text" && !child.value.trim()),
    )
        ? node.children.filter((child): child is Image => child.type === "image")
        : [];

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
        if (node.type === "containerDirective" && findDirective("container", node.name)?.raw)
            return SKIP;
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
