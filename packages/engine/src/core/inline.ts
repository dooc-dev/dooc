// Markdown inline content, with file-backed term labels resolved from source files.
import type { RootContent } from "mdast";
import type { TermEntry } from "./content-types.js";
import { parseMdast } from "./markdown.js";
import { parseTermReference } from "./term-reference.js";

export type InlineSegment =
    | { kind: "text"; text: string }
    | { kind: "code"; text: string }
    | { kind: "strong" | "emphasis"; text: string; children: InlineSegment[] }
    | { kind: "link"; text: string; url: string; children?: InlineSegment[] }
    | { kind: "term"; id: string; text: string; children?: InlineSegment[] };

export const termMap = (terms: readonly TermEntry[]): Map<string, TermEntry> =>
    new Map(terms.map((entry) => [entry.id, entry]));

export interface InlineContext {
    terms?: readonly TermEntry[];
}

export const inlineSegmenter = (ctx: InlineContext = {}): ((text: string) => InlineSegment[]) => {
    const terms = termMap(ctx.terms ?? []);
    const segments = (nodes: readonly RootContent[]): InlineSegment[] =>
        nodes.flatMap((node): InlineSegment[] => {
            if (node.type === "inlineCode") return [{ kind: "code", text: node.value }];
            if ("value" in node) return [{ kind: "text", text: node.value }];
            if (!("children" in node)) return [];
            const children = segments(node.children);
            const text = children.map((child) => child.text).join("");
            if (node.type === "strong" || node.type === "emphasis")
                return [{ kind: node.type, text, children }];
            if (node.type === "link") {
                let id: string | undefined;
                try {
                    id = parseTermReference(node.url);
                } catch {
                    /* The compiler reports invalid paths. */
                }
                const formatted = children.some((child) => child.kind !== "text")
                    ? { children }
                    : {};
                return [
                    id
                        ? {
                              kind: "term",
                              id,
                              text: text || terms.get(id)?.name || node.url,
                              ...formatted,
                          }
                        : { kind: "link", text, url: node.url, ...formatted },
                ];
            }
            return children;
        });
    return (text) => segments(parseMdast(text).children);
};
