import { describe, expect, it } from "vitest";
import { slugify } from "./blocks.js";
import type { TermEntry } from "./content-types.js";
import { type LanguageAdapter, resolveLanguage, termComparator } from "./language.js";
import { ja } from "./languages/ja.js";

const dict = (...names: string[]): TermEntry[] =>
    names.map((name, i) => ({ id: `term-${i}`, name, definition: "d" }));

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

describe("termComparator", () => {
    it("defaults to the language's collation by term", () => {
        const sorted = (code: string): string[] =>
            [...dict("z", "ä", "b")].sort(termComparator({ code })).map((e) => e.name);
        expect(sorted("de")).toEqual(["ä", "b", "z"]);
        // Swedish sorts ä after z.
        expect(sorted("sv")).toEqual(["b", "z", "ä"]);
    });

    it("uses the adapter's compareTerms when given", () => {
        const reverse: LanguageAdapter = {
            code: "x-rev",
            compareTerms: (a, b) => b.name.localeCompare(a.name),
        };
        expect([...dict("a", "b")].sort(termComparator(reverse)).map((e) => e.name)).toEqual([
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
