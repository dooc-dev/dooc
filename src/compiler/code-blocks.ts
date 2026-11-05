import type { Code } from "mdast";
import type { Block } from "../core/blocks.js";
import { parseGraphSource } from "../core/graph.js";
import { parseTermSource } from "./terms.js";

export const parseContentSource = (
    language: string,
    source: string,
    id: string,
    caption?: string,
) => {
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
    if (node.lang !== "grapth" && node.lang !== "termth") return undefined;
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
