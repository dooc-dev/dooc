// Japanese adapter for the language socket (browser-safe part). The prose lint (textlint) is
// Node-only and is attached on the viewer side (src/viewer/languages.ts).
import type { LanguageAdapter } from "../language.js";

// Japanese doesn't separate words with spaces, so a term matches as a substring next to Japanese
// text. Only Latin letters / ASCII digits / `_` (and `-word` hyphenation) continue a word, as in
// an English word boundary.
const WORD_BEFORE = /[\p{Script=Latin}\d_-]$/u;
const WORD_AFTER = /^(?:[\p{Script=Latin}\d_]|-[\p{Script=Latin}\d_])/u;

const collator = new Intl.Collator("ja", { sensitivity: "base" });

export const ja: LanguageAdapter = {
    code: "ja",
    isTermBoundary: (text, start, end) =>
        !WORD_BEFORE.test(text.slice(Math.max(0, start - 2), start)) &&
        !WORD_AFTER.test(text.slice(end, end + 3)),
    // The reading (kana) gives the gojūon order; kanji terms without one sort by the term itself.
    compareTerms: (a, b) => collator.compare(a.reading ?? a.term, b.reading ?? b.term),
    // Browsers don't spellcheck Japanese; check the English words mixed into the text instead.
    spellcheckLang: "en",
};
