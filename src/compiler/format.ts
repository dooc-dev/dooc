import type { Node } from "mdast";
import remarkDirective from "remark-directive";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import stringWidth from "string-width";
import { unified } from "unified";
import { parseMdast } from "./dialect.js";

export function formatMarkdown(body: string): string {
    if (!body.trim()) return "";
    const lines = body.replaceAll("\r\n", "\n").split("\n");
    // Directive bodies may contain a DSL rather than Markdown; preserve their source verbatim.
    const preserve = (node: Node): string => {
        const position = node.position;
        if (!position) throw new Error("Missing source position for Markdown formatting");
        const raw = lines.slice(position.start.line - 1, position.end.line);
        const indent = position.start.column - 1;
        return raw
            .map((line, index) =>
                index === 0 ? line.slice(indent) : line.replace(new RegExp(`^ {0,${indent}}`), ""),
            )
            .join("\n");
    };
    const printer = unified()
        .use(remarkFrontmatter)
        .use(remarkGfm, { stringLength: stringWidth })
        .use(remarkDirective)
        .use(remarkStringify, {
            bullet: "-",
            listItemIndent: "one",
            fences: true,
            handlers: {
                containerDirective: preserve,
                leafDirective: preserve,
                code: (node, parent) => {
                    // Nested blocks need the printer to reconstruct list/quote prefixes.
                    if (parent?.type !== "root") {
                        const marker = "`".repeat(
                            Math.max(
                                3,
                                ...[...node.value.matchAll(/`+/g)].map(
                                    (match) => match[0].length + 1,
                                ),
                            ),
                        );
                        return `${marker}${node.lang ?? ""}${node.meta ? ` ${node.meta}` : ""}\n${node.value}\n${marker}`;
                    }
                    return preserve(node);
                },
            },
        });
    const formatted = printer.stringify(parseMdast(body));
    return body.includes("\r\n") ? formatted.replaceAll("\n", "\r\n") : formatted;
}
