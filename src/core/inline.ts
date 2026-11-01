// SoT for splitting body-text inline content (Block text / ListItem / table cell) (browser-safe).
// The mini syntax is only `code` / [text](url). In addition, figure references "Fig. <name>" and
// dictionary terms are detected in plain text. Consumers just map this segment list to their own
// rendering. The detection rules are declared only here (consumers don't reimplement them);
// where a term may stand (word boundaries) is the doc language's rule (language.ts).
import type { DictEntry } from "./artifact-types.js";
import { type LanguageAdapter, termBoundary } from "./language.js";

export type InlineSegment =
    | { kind: "text"; text: string }
    | { kind: "code"; text: string }
    // When url uses the doc: scheme, the consumer resolves it with routing.parseDocLink.
    | { kind: "link"; text: string; url: string }
    | { kind: "figref"; name: string; text: string }
    | { kind: "term"; term: string; text: string };

// Figure reference detection rule: "Fig. <name>" (space optional). The name is checked against
// the figures index; if it doesn't exist, it falls back to plain text.
export const FIG_REF_SOURCE = "Fig\\.\\s?[a-z0-9_-]+";
const FIG_REF_RE = /^Fig\.\s?([a-z0-9_-]+)$/;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const dictMap = (dictionary: readonly DictEntry[]): Map<string, DictEntry> =>
    new Map(dictionary.map((e) => [e.term, e]));

// First-pass split of the mini syntax: `code` and [text](url). The dialect validator rejects any
// other inline, so once these two are cut out the rest is plain text.
const MINI_RE = /(`[^`]*`|\[[^\]]*\]\([^)]*\))/g;
const LINK_RE = /^\[([^\]]*)\]\(([^)]*)\)$/;

export interface InlineContext {
    /** Names of existing figures (index). References to missing ones are treated as text. */
    figureNames?: readonly string[];
    /** Glossary (the artifact's dictionary). If unspecified, terms are not detected. */
    dictionary?: readonly DictEntry[];
    /** The doc language's adapter (term boundaries). Default: generic Unicode rules. */
    language?: LanguageAdapter;
}

/**
 * Create an inline segmenter (create once per doc / page, call it per text). The detection regex
 * and the dictionary map are fixed at creation time.
 */
export const inlineSegmenter = (ctx: InlineContext = {}): ((text: string) => InlineSegment[]) => {
    const figureNames = new Set(ctx.figureNames ?? []);
    const dict = dictMap(ctx.dictionary ?? []);
    const isBoundary = termBoundary(ctx.language);
    // Longer terms win; at each candidate position the longest term that passes the boundary
    // check is taken, so a rejected long term still lets a shorter one match there.
    const terms = [...dict.keys()].sort((a, b) => b.length - a.length);
    const candidateRe = new RegExp(
        terms.length > 0 ? `${FIG_REF_SOURCE}|${terms.map(escapeRe).join("|")}` : FIG_REF_SOURCE,
        "g",
    );

    const matchAt = (text: string, at: number, found: string): InlineSegment | undefined => {
        const figName = FIG_REF_RE.exec(found)?.[1];
        if (figName != null) {
            // A reference to a missing figure stays text (and isn't searched for terms).
            return figureNames.has(figName)
                ? { kind: "figref", name: figName, text: found }
                : { kind: "text", text: found };
        }
        const term = terms.find(
            (t) => text.startsWith(t, at) && isBoundary(text, at, at + t.length),
        );
        return term == null ? undefined : { kind: "term", term, text: term };
    };

    const splitPlain = (text: string): InlineSegment[] => {
        const out: InlineSegment[] = [];
        let last = 0;
        candidateRe.lastIndex = 0;
        for (let m = candidateRe.exec(text); m != null; m = candidateRe.exec(text)) {
            const hit = matchAt(text, m.index, m[0]);
            if (hit == null) {
                candidateRe.lastIndex = m.index + 1;
                continue;
            }
            if (m.index > last) {
                out.push({ kind: "text", text: text.slice(last, m.index) });
            }
            out.push(hit);
            last = m.index + hit.text.length;
            candidateRe.lastIndex = last;
        }
        if (last < text.length) {
            out.push({ kind: "text", text: text.slice(last) });
        }
        return out;
    };

    return (text) =>
        text
            .split(MINI_RE)
            .flatMap((seg, i): InlineSegment[] => {
                if (i % 2 === 1) {
                    if (seg.startsWith("`")) {
                        return [{ kind: "code", text: seg.slice(1, -1) }];
                    }
                    const m = LINK_RE.exec(seg);
                    if (m) {
                        return [{ kind: "link", text: m[1] ?? "", url: m[2] ?? "" }];
                    }
                }
                return splitPlain(seg);
            })
            .filter((s) => !(s.kind === "text" && s.text === ""));
};
