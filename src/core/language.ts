import { iso6393To1 } from "iso-639-3";
// Language socket (browser-safe). Every rule that depends on the document language lives behind
// LanguageAdapter, so the rest of the core stays language-neutral; languages without an adapter
// get the generic Unicode rules below. Slugs / anchors are deliberately NOT part of the socket:
// they are always ASCII (blocks.ts slugify), whatever the language.
//
// The doc language is a BCP 47 tag: front-matter `lang`, else the site default
// (docs.config.mjs `defaultLang`, else DEFAULT_LANG).
import type { DictEntry } from "./artifact-types.js";

export const DEFAULT_LANG = "en";

/** BCP 47-shaped tag (`en`, `ja`, `pt-BR`, `zh-Hant-TW`). Not checked against a registry. */
export const LANG_TAG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
export const isLangTag = (s: string): boolean => LANG_TAG_RE.test(s);

/** One prose-lint finding. range = 0-indexed [start, end) offsets into the linted body string. */
export interface LintFinding {
    ruleId: string;
    message: string;
    range: readonly [number, number];
}

export interface LanguageAdapter {
    /**
     * BCP 47 tag this adapter handles. A doc tag matches exactly, else by its primary subtag
     * (`ja-JP` → `ja`).
     */
    readonly code: string;
    /**
     * Whether a dictionary-term occurrence at text[start, end) stands as a whole term (word
     * boundaries). Default: unicodeTermBoundary.
     */
    isTermBoundary?: (text: string, start: number, end: number) => boolean;
    /** Order of the dictionary listing (A → Z). Default: Intl.Collator for `code`, by term. */
    compareTerms?: (a: DictEntry, b: DictEntry) => number;
    /** Language of the editor's browser spellcheck. Default: the doc's tag. */
    spellcheckLang?: string;
    /**
     * Prose lint shown in the editor (Node only; runs on the server, so it may load heavy
     * dependencies lazily). Offsets are relative to the body string. Absent = no lint.
     */
    lint?: (body: string) => Promise<LintFinding[]>;
}

/** Shape of `<docs root>/docs.config.mjs` (its default export). */
export interface DocsConfig {
    /** Language of docs without front-matter `lang`. Default: DEFAULT_LANG. */
    defaultLang?: string;
    /** Extra adapters. They take precedence over the built-in ones with the same code. */
    languages?: LanguageAdapter[];
}

// Generic rule for space-delimited scripts: a term must not continue a word on either side
// (letters / digits / marks / `_`, and `-word` hyphenation such as `api-v2`).
const WORD_BEFORE = /[\p{L}\p{N}\p{M}_-]$/u;
const WORD_AFTER = /^(?:[\p{L}\p{N}\p{M}_]|-[\p{L}\p{N}\p{M}_])/u;

export const unicodeTermBoundary = (text: string, start: number, end: number): boolean =>
    // Slices are 2–3 code units wide so a surrogate pair next to the match is read whole.
    !WORD_BEFORE.test(text.slice(Math.max(0, start - 2), start)) &&
    !WORD_AFTER.test(text.slice(end, end + 3));

/**
 * Adapter for a doc tag: exact code match, then the primary subtag, else a generic adapter
 * carrying the tag (so collation still follows the language via Intl).
 */
export const resolveLanguage = (
    lang: string | undefined,
    adapters: readonly LanguageAdapter[] = [],
): LanguageAdapter => {
    const tag = lang || DEFAULT_LANG;
    const lower = tag.toLowerCase();
    const code = lower.split("-")[0] ?? lower;
    const primary = iso6393To1[code] ?? code;
    return (
        adapters.find((a) => a.code.toLowerCase() === lower) ??
        adapters.find((a) => a.code.toLowerCase() === primary) ?? { code: tag }
    );
};

export const termBoundary = (
    language: LanguageAdapter | undefined,
): NonNullable<LanguageAdapter["isTermBoundary"]> =>
    language?.isTermBoundary ?? unicodeTermBoundary;

const collator = (code: string): Intl.Collator => {
    try {
        return new Intl.Collator(code, { sensitivity: "base" });
    } catch {
        // A tag Intl rejects falls back to the default language's order.
        return new Intl.Collator(DEFAULT_LANG, { sensitivity: "base" });
    }
};

export const termComparator = (
    language: LanguageAdapter | undefined,
): NonNullable<LanguageAdapter["compareTerms"]> => {
    if (language?.compareTerms) {
        return language.compareTerms;
    }
    const c = collator(language?.code ?? DEFAULT_LANG);
    return (a, b) => c.compare(a.term, b.term);
};
