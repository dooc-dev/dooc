import type { Code } from "mdast";
import { visit } from "unist-util-visit";
import type { Block, CalloutItem } from "../core/blocks.js";
import { parseFigureLink } from "../core/file-embed.js";
import { parseGraphSource } from "../core/graph.js";
import { inlineToText, listItems, parseMdast } from "../core/markdown.js";
import { isReferenceUrl, parseDocLink } from "../core/routing.js";
import { parseSchemaSource } from "../core/schema-graph.js";
import { CODE_TEMPLATES } from "../core/taxonomy.js";
import { parseTermReference } from "../core/term-reference.js";
import { parseTermSource } from "./terms.js";

const delimitedRows = (source: string, separator: string): string[][] => {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    let closed = false;
    let rowStart = 0;
    const text = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    for (let i = 0; i <= text.length; i++) {
        const char = text[i];
        if (quoted) {
            if (char === undefined) throw new Error("Unclosed quoted field");
            if (char === '"' && text[i + 1] === '"') {
                cell += '"';
                i++;
            } else if (char === '"') {
                quoted = false;
                closed = true;
            } else cell += char;
        } else if (char === '"' && !cell && !closed) quoted = true;
        else if (char === separator || char === "\n" || char === undefined) {
            row.push(cell);
            cell = "";
            closed = false;
            if (char !== separator) {
                if (i > rowStart) rows.push(row);
                row = [];
                rowStart = i + 1;
            }
        } else {
            if (closed || char === '"') throw new Error("Unexpected text after a quoted field");
            cell += char;
        }
    }
    if (!rows.length || rows.some((row) => row.length !== rows[0]?.length))
        throw new Error("Expected equally sized rows");
    return rows;
};

export const parseContentSource = (
    language: string,
    source: string,
    id: string,
    caption?: string,
) => {
    if (language === "csv" || language === "tsv") {
        try {
            const [headers, ...rows] = delimitedRows(source, language === "csv" ? "," : "\t");
            return {
                blocks: [
                    {
                        type: "table",
                        dataSource: id,
                        headers: headers ?? [],
                        rows,
                        ...(caption ? { caption } : {}),
                    },
                ] as Block[],
                errors: [],
            };
        } catch (error) {
            return {
                blocks: [] as Block[],
                errors: [
                    { line: 0, message: error instanceof Error ? error.message : String(error) },
                ],
            };
        }
    }
    if (language === "mermaid")
        return {
            blocks: [{ type: "code", lang: language, lines: source.split("\n") }] as Block[],
            errors: [],
        };
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
                    if (!isReferenceUrl(node.url))
                        throw new Error(
                            "links require a local reference, HTTP(S) URL or email address",
                        );
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
    if (language === "graphth") {
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
