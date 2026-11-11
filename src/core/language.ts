import { iso6393, iso6393To1 } from "iso-639-3";
// Language socket (browser-safe). Every rule that depends on the document language lives behind
// LanguageAdapter, so the rest of the core stays language-neutral; languages without an adapter
// get the generic Unicode rules below. Slugs / anchors are deliberately NOT part of the socket:
// they are always ASCII (blocks.ts slugify), whatever the language.
//
// The doc language is a BCP 47 tag: front-matter `lang`, else the site default
// (dooc.yaml `defaultLang`, else DEFAULT_LANG).
import type { TermEntry } from "./content-types.js";

export const DEFAULT_LANG = "en";

let contentCodes: Set<string> | undefined;
const from1 = new Map(Object.entries(iso6393To1).map(([three, two]) => [two, three]));
export const isContentLanguage = (code: string): boolean => {
    contentCodes ??= new Set(iso6393.map((language) => language.iso6393));
    return contentCodes.has(code);
};

/** Normalize site language declarations and translation directory names consistently. */
export const contentLanguageCode = (tag: string): string => {
    const primary = tag.toLowerCase().split("-")[0] ?? "";
    const code = from1.get(primary) ?? primary;
    if (!isContentLanguage(code)) throw new Error(`Unknown ISO 639-3 language: ${tag}`);
    return code;
};

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
    /** Order of term listings. Default: Intl.Collator for code, by name. */
    compareTerms?: (a: TermEntry, b: TermEntry) => number;
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
    /** Extra adapters. They take precedence over the built-in ones with the same code. */
    languages?: LanguageAdapter[];
}

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
    return (a, b) => c.compare(a.name, b.name);
};
