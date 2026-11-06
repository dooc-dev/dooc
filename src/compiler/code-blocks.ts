import type { Code } from "mdast";
import { visit } from "unist-util-visit";
import type { Block, CalloutItem } from "../core/blocks.js";
import { parseFigureLink } from "../core/file-embed.js";
import { parseGraphSource } from "../core/graph.js";
import { inlineToText, listItems, parseMdast } from "../core/markdown.js";
import { parseDocLink } from "../core/routing.js";
import { parseSchemaSource } from "../core/schema-graph.js";
import { CODE_TEMPLATES } from "../core/taxonomy.js";
import { parseTermReference } from "../core/term-reference.js";
import { parseTermSource } from "./terms.js";

export const parseContentSource = (
    language: string,
    source: string,
    id: string,
    caption?: string,
) => {
    if (language === "callouth") {
        const root = parseMdast(source);
        const errors: { line: number; message: string }[] = [];
        const allowed = new Set([
            "root",
            "paragraph",
            "text",
            "inlineCode",
            "link",
            "strong",
            "emphasis",
            "list",
            "listItem",
        ]);
        if (!root.children.length) errors.push({ line: 0, message: "callout is empty" });
        visit(root, (node, _index, parent) => {
            const line = (node.position?.start.line ?? 1) - 1;
            if (
                !allowed.has(node.type) ||
                (parent?.type === "listItem" && node.type !== "paragraph" && node.type !== "list")
            )
                errors.push({
                    line,
                    message: "use paragraphs and lists with text, code, or links",
                });
            if (node.type === "link") {
                try {
                    if (!node.url || node.url.startsWith("doc:"))
                        throw new Error("Use a Markdown file link");
                    parseDocLink(node.url);
                    parseFigureLink(node.url);
                    parseTermReference(node.url);
                } catch (error) {
                    errors.push({
                        line,
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        });
        const body = root.children.flatMap((node): CalloutItem[] =>
            node.type === "paragraph"
                ? [{ type: "p", text: inlineToText(node.children) }]
                : node.type === "list"
                  ? [
                        {
                            type: "list",
                            items: listItems(node),
                            ...(node.ordered ? { ordered: true } : {}),
                        },
                    ]
                  : [],
        );
        return {
            blocks: [{ type: "callout", body, ...(caption ? { title: caption } : {}) }] as Block[],
            errors,
        };
    }
    if (language === "schemath") {
        const lines = source.split("\n");
        const indent = Math.min(
            ...lines
                .filter((line) => line.trim())
                .map((line) => /^\s*/.exec(line)?.[0].length ?? 0),
        );
        const parsed = parseSchemaSource(lines.map((line) => line.slice(indent)).join("\n"));
        if (!source.trim()) parsed.errors.push({ line: 0, message: "schema is empty" });
        return {
            blocks: [
                {
                    type: "schemaGraph",
                    source,
                    graph: parsed.model,
                    ...(caption ? { caption } : {}),
                },
            ] as Block[],
            errors: parsed.errors,
        };
    }
    if (language === "grapth") {
        const parsed = parseGraphSource(source);
        if (!source.trim()) parsed.errors.push({ line: 0, message: "graph is empty" });
        return {
            blocks: [
                { type: "graph", source, graph: parsed.model, ...(caption ? { caption } : {}) },
            ] as Block[],
            errors: parsed.errors,
        };
    }
    if (language === "termth") {
        const parsed = parseTermSource(id, source);
        return {
            blocks: parsed.entries.map((entry): Block => ({ type: "term", entry })),
            errors: parsed.errors,
        };
    }
    return undefined;
};

/** Fenced and file-backed definitions share their parsers and rendered blocks. */
export const parseContentCode = (node: Code, raw: string, file = "inline") => {
    if (!node.lang || !Object.hasOwn(CODE_TEMPLATES, node.lang)) return undefined;
    const errors: { line: number; message: string }[] = [];
    const slice = raw.slice(node.position?.start.offset, node.position?.end.offset);
    const opening = /^(`{3,}|~{3,})/.exec(slice)?.[1];
    const closing = /\n {0,3}(`{3,}|~{3,})[ \t]*$/.exec(slice)?.[1];
    if (!opening || !closing || closing[0] !== opening[0] || closing.length < opening.length)
        errors.push({ line: -1, message: "close the code fence" });
    if (node.lang === "termth" && node.meta)
        errors.push({ line: -1, message: "termth takes no ID; write name and definition as YAML" });
    const parsed = parseContentSource(
        node.lang,
        node.value,
        `${file}#L${node.position?.start.line ?? 1}`,
        node.meta?.trim(),
    );
    return { blocks: parsed?.blocks ?? [], errors: [...errors, ...(parsed?.errors ?? [])] };
};
