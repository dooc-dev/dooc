// Shared inline syntax: local .termth links display terms, ordinary links remain links.
import type { TermEntry } from "./artifact-types.js";
import { parseTermReference } from "./term-reference.js";

export type InlineSegment =
    | { kind: "text"; text: string }
    | { kind: "code"; text: string }
    | { kind: "link"; text: string; url: string }
    | { kind: "figref"; name: string; text: string }
    | { kind: "term"; id: string; text: string };

export const FIG_REF_SOURCE = "Fig\\.\\s?[a-z0-9_-]+";
const FIG_REF_RE = /^Fig\.\s?([a-z0-9_-]+)$/;
const MINI_RE = new RegExp(`(\`+[^\`]*\`+|\\\\?\\[[^\\]]*\\]\\([^)]*\\)|${FIG_REF_SOURCE})`, "g");
const LINK_RE = /^\[([^\]]*)\]\(([^)]*)\)$/;

export const termMap = (terms: readonly TermEntry[]): Map<string, TermEntry> =>
    new Map(terms.map((entry) => [entry.id, entry]));

export interface InlineContext {
    figureNames?: readonly string[];
    terms?: readonly TermEntry[];
}

export const inlineSegmenter = (ctx: InlineContext = {}): ((text: string) => InlineSegment[]) => {
    const figures = new Set(ctx.figureNames ?? []);
    const terms = termMap(ctx.terms ?? []);
    return (text) => {
        const out: InlineSegment[] = [];
        let last = 0;
        for (const match of text.matchAll(MINI_RE)) {
            if (match.index > last) out.push({ kind: "text", text: text.slice(last, match.index) });
            const token = match[0];
            const link = LINK_RE.exec(token);
            const fig = FIG_REF_RE.exec(token)?.[1];
            if (token.startsWith("\\[")) out.push({ kind: "text", text: token.slice(1) });
            else if (token.startsWith("`"))
                out.push({ kind: "code", text: token.replace(/^`+|`+$/g, "") });
            else if (link) {
                const url = link[2] ?? "";
                let id: string | undefined;
                try {
                    id = parseTermReference(url);
                } catch {
                    /* The compiler reports invalid paths. */
                }
                out.push(
                    id
                        ? { kind: "term", id, text: link[1] || terms.get(id)?.name || url }
                        : { kind: "link", text: link[1] ?? "", url },
                );
            } else if (fig && figures.has(fig))
                out.push({ kind: "figref", name: fig, text: token });
            else out.push({ kind: "text", text: token });
            last = match.index + token.length;
        }
        if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
        return out;
    };
};
