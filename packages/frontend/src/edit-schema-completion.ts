// biome-ignore-all lint/suspicious/noTemplateCurlyInString: CodeMirror snippet field syntax
// Edit-only. Collects candidates from declaration lines rather than the validating parser, so
// incomplete DSL can still be completed.
import {
    type CompletionContext,
    type CompletionResult,
    snippetCompletion,
} from "@codemirror/autocomplete";
import { scanSchemaComments } from "../../engine/src/core/schema-comments.js";
import { SCHEMA_SCALAR_TYPES } from "../../engine/src/core/schema-graph.js";

/** undefined = outside a schema; null = inside a schema but at a position with no completion. */
export const schemaCompletion = (ctx: CompletionContext): CompletionResult | null | undefined => {
    const { doc } = ctx.state;
    const line = doc.lineAt(ctx.pos);
    let start = 0;
    let fence: { char: string; length: number; language: string } | undefined;
    for (let n = 1; n < line.number; n++) {
        const code = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(doc.line(n).text);
        if (!code) continue;
        const marker = code[1] ?? "";
        if (!fence) {
            fence = {
                char: marker[0] ?? "",
                length: marker.length,
                language: code[2]?.trim().split(/\s/)[0] ?? "",
            };
            start = n + 1;
        } else if (marker[0] === fence.char && marker.length >= fence.length && !code[2]?.trim()) {
            fence = undefined;
        }
    }
    if (fence?.language !== "schemath") return undefined;
    let end = doc.length;
    for (let n = start; n <= doc.lines; n++) {
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(doc.line(n).text)?.[1];
        if (close && close[0] === fence.char && close.length >= fence.length) {
            end = doc.line(n).from;
            break;
        }
    }
    const offset = doc.line(start).from;
    const scanned = scanSchemaComments(doc.sliceString(offset, end));
    const pos = ctx.pos - offset;
    if (
        scanned.comments.some(
            (comment) =>
                pos >= comment.from &&
                (pos < comment.to ||
                    (pos === comment.to && (comment.kind === "line" || !comment.closed))),
        )
    )
        return null;
    const before = scanned.source.slice(line.from - offset, pos);
    const target =
        /^\s+[A-Za-z_]\w*:\s*fk(?:\[\])?\((?:\s*[A-Za-z_]\w*\s*\|)*\s*([A-Za-z_]\w*|)$/.exec(
            before,
        );
    if (target) {
        const declarations: { name: string; indent: number }[] = [];
        for (const text of scanned.source.split("\n")) {
            const declaration = /^(\s*)([A-Za-z_]\w*):\s*$/.exec(text);
            if (declaration)
                declarations.push({
                    name: declaration[2] ?? "",
                    indent: declaration[1]?.length ?? 0,
                });
        }
        const indent = Math.min(...declarations.map((d) => d.indent));
        const names = [
            ...new Set(declarations.filter((d) => d.indent === indent).map((d) => d.name)),
        ];
        return {
            from: ctx.pos - (target[1]?.length ?? 0),
            to: ctx.pos + (/^\w*/.exec(line.text.slice(ctx.pos - line.from))?.[0].length ?? 0),
            options: names.map((label) => ({ label, type: "class", detail: "table" })),
            validFor: /^\w*$/,
        };
    }
    const type = /^\s+[A-Za-z_]\w*:\s*(\w*)$/.exec(before);
    if (type) {
        return {
            from: ctx.pos - (type[1]?.length ?? 0),
            options: [
                { label: "pk", type: "type", detail: "primary key" },
                ...SCHEMA_SCALAR_TYPES.map((label) => ({ label, type: "type" })),
                snippetCompletion("fk(${table})", { label: "fk", detail: "ref", type: "type" }),
                snippetCompletion("fk[](${table})", {
                    label: "fk[]",
                    detail: "array of refs",
                    type: "type",
                }),
                snippetCompletion('enum("${value}")', {
                    label: "enum",
                    detail: "enumeration",
                    type: "type",
                }),
            ],
            validFor: /^\w*$/,
        };
    }
    return null;
};
