import { describe, expect, it } from "vitest";
import { inlineSegmenter } from "./inline.js";

const segment = inlineSegmenter({
    terms: [
        { id: "api-one", name: "API", definition: "First" },
        { id: "api-two", name: "API", definition: "Second" },
    ],
});

describe("explicit term references", () => {
    it("uses IDs rather than names and leaves ordinary words unchanged", () => {
        expect(segment("API :::term(api-two) / :::term( api-one )")).toEqual([
            { kind: "text", text: "API " },
            { kind: "term", id: "api-two", text: "API" },
            { kind: "text", text: " / " },
            { kind: "term", id: "api-one", text: "API" },
        ]);
    });
    it("does not resolve terms in code, links or escaped references", () => {
        expect(
            segment(
                "`:::term(api-one)` [API](https://example.com/:::term(api-two)) \\:::term(api-one)",
            ).filter((s) => s.kind === "term"),
        ).toEqual([]);
    });
    it("preserves unresolved references so validation can report their IDs", () => {
        expect(segment(":::term(missing)")).toEqual([
            { kind: "term", id: "missing", text: ":::term(missing)" },
        ]);
    });
});
