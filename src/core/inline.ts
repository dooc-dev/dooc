// Shared mini syntax for prose. Terms are resolved only by explicit :::term(id) references.
import type { TermEntry } from "./artifact-types.js";

export type InlineSegment =
    | { kind: "text"; text: string }
    | { kind: "code"; text: string }
    | { kind: "link"; text: string; url: string }
    | { kind: "figref"; name: string; text: string }
    | { kind: "term"; id: string; text: string };

export const TERM_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
export const TERM_REF_SOURCE = ":::term\\(([^()\\n]*)\\)";
export const FIG_REF_SOURCE = "Fig\\.\\s?[a-z0-9_-]+";
const FIG_REF_RE = /^Fig\.\s?([a-z0-9_-]+)$/;
const TERM_REF_RE = new RegExp(`^${TERM_REF_SOURCE}$`);
const MINI_RE = new RegExp(
    `(\`+[^\`]*\`+|\\[[^\\]]*\\]\\([^)]*\\)|\\\\?${TERM_REF_SOURCE}|${FIG_REF_SOURCE})`,
    "g",
);
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
            const term = TERM_REF_RE.exec(token);
            const link = LINK_RE.exec(token);
            const fig = FIG_REF_RE.exec(token)?.[1];
            if (token.startsWith("`"))
                out.push({ kind: "code", text: token.replace(/^`+|`+$/g, "") });
            else if (link) out.push({ kind: "link", text: link[1] ?? "", url: link[2] ?? "" });
            else if (term) {
                const id = (term[1] ?? "").trim();
                out.push({ kind: "term", id, text: terms.get(id)?.name ?? token });
            } else if (fig && figures.has(fig))
                out.push({ kind: "figref", name: fig, text: token });
            else out.push({ kind: "text", text: token.replace(/^\\(?=:::term\()/, "") });
            last = match.index + token.length;
        }
        if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
        return out;
    };
};
