import { describe, expect, it } from "vitest";
import { inlineSegmenter } from "./inline.js";

const segment = inlineSegmenter({
    terms: [
        { id: "api-one.termth", name: "API", definition: "First" },
        { id: "api-two.termth", name: "API", definition: "Second" },
    ],
});

describe("term file links", () => {
    it("resolves paths, uses default names and preserves explicit labels", () => {
        expect(segment("API [](api-two.termth) / [Interface](./api-one.termth)")).toEqual([
            { kind: "text", text: "API " },
            { kind: "term", id: "api-two.termth", text: "API" },
            { kind: "text", text: " / " },
            { kind: "term", id: "api-one.termth", text: "Interface" },
        ]);
    });
    it("leaves code, escaped links, ordinary URLs and removed syntax alone", () => {
        expect(
            segment(
                "`[](api-one.termth)` \\[](api-one.termth) [API](https://example.com) :::term(api-one)",
            ).filter((item) => item.kind === "term"),
        ).toEqual([]);
    });
    it("keeps missing paths visible", () => {
        expect(segment("[](missing.termth)")).toEqual([
            { kind: "term", id: "missing.termth", text: "missing.termth" },
        ]);
    });
});
