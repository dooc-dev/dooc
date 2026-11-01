import { describe, expect, it } from "vitest";
import type { DictEntry } from "./artifact-types.js";
import { slugify } from "./blocks.js";
import { inlineSegmenter } from "./inline.js";
import {
    type LanguageAdapter,
    resolveLanguage,
    termComparator,
    unicodeTermBoundary,
} from "./language.js";
import { ja } from "./languages/ja.js";

const dict = (...terms: string[]): DictEntry[] => terms.map((term) => ({ term, definition: "d" }));
const terms = (text: string, dictionary: DictEntry[], language?: LanguageAdapter): string[] =>
    inlineSegmenter({ dictionary, ...(language ? { language } : {}) })(text).flatMap((s) =>
        s.kind === "term" ? [s.text] : [],
    );

describe("resolveLanguage", () => {
    const adapters: LanguageAdapter[] = [ja, { code: "pt-BR" }];

    it("matches the exact tag, then the primary subtag (case-insensitive)", () => {
        expect(resolveLanguage("pt-BR", adapters).code).toBe("pt-BR");
        expect(resolveLanguage("ja-JP", adapters)).toBe(ja);
        expect(resolveLanguage("JA", adapters)).toBe(ja);
    });

    it("falls back to a generic adapter carrying the tag (and to DEFAULT_LANG when unset)", () => {
        expect(resolveLanguage("de", adapters)).toEqual({ code: "de" });
        expect(resolveLanguage(undefined, adapters)).toEqual({ code: "en" });
    });
});

describe("generic term boundaries (unicodeTermBoundary)", () => {
    it("rejects terms that continue a word in any script, and -word hyphenation", () => {
        expect(terms("api apis api-v2 (api)", dict("api"))).toEqual(["api", "api"]);
        expect(terms("café cafés", dict("café"))).toEqual(["café"]);
        expect(terms("ключ ключи", dict("ключ"))).toEqual(["ключ"]);
    });

    it("reads a surrogate pair next to the match as one character", () => {
        expect(unicodeTermBoundary("𝐀api", 2, 5)).toBe(false);
        expect(unicodeTermBoundary("😀api", 2, 5)).toBe(true);
    });

    it("lets a shorter term match where the longest candidate is rejected", () => {
        expect(terms("docs rooted", dict("docs root", "docs"))).toEqual(["docs"]);
        expect(terms("docs root.", dict("docs root", "docs"))).toEqual(["docs root"]);
    });

    it("a Japanese term inside Japanese text is not a whole word under the generic rule", () => {
        expect(terms("用語辞書を見る", dict("辞書"))).toEqual([]);
    });
});

describe("ja adapter", () => {
    it("matches terms as substrings next to Japanese text, but not inside Latin words", () => {
        expect(terms("用語辞書を見る", dict("辞書"), ja)).toEqual(["辞書"]);
        expect(terms("APIを呼ぶ、APIsは別", dict("API"), ja)).toEqual(["API"]);
    });

    it("sorts by reading (kana) when present, else by the term", () => {
        const entries: DictEntry[] = [
            { term: "辞書", reading: "じしょ", definition: "d" },
            { term: "安全", reading: "あんぜん", definition: "d" },
            { term: "かな", definition: "d" },
        ];
        expect([...entries].sort(termComparator(ja)).map((e) => e.term)).toEqual([
            "安全",
            "かな",
            "辞書",
        ]);
    });
});

describe("termComparator", () => {
    it("defaults to the language's collation by term", () => {
        const sorted = (code: string): string[] =>
            [...dict("z", "ä", "b")].sort(termComparator({ code })).map((e) => e.term);
        expect(sorted("de")).toEqual(["ä", "b", "z"]);
        // Swedish sorts ä after z.
        expect(sorted("sv")).toEqual(["b", "z", "ä"]);
    });

    it("uses the adapter's compareTerms when given", () => {
        const reverse: LanguageAdapter = {
            code: "x-rev",
            compareTerms: (a, b) => b.term.localeCompare(a.term),
        };
        expect([...dict("a", "b")].sort(termComparator(reverse)).map((e) => e.term)).toEqual([
            "b",
            "a",
        ]);
    });
});

describe("slugify (always ASCII, language-independent)", () => {
    it("lowercases, folds accents, drops other non-ASCII text and edge hyphens", () => {
        expect(slugify("Hello World")).toBe("hello-world");
        expect(slugify("Café au lait")).toBe("cafe-au-lait");
        expect(slugify("API 設計")).toBe("api");
        expect(slugify("概要")).toBe("");
        expect(slugify("snake_case & more!")).toBe("snake_case-more");
    });
});
