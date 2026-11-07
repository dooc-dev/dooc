import { describe, expect, it } from "vitest";
import { parseDoc } from "../compiler/dialect.js";
import { CODE_TEMPLATES } from "./taxonomy.js";

const fill = (sample: string): string => sample.replace(/<([^<>\n]+)>/g, "$1");

describe("semantic code templates", () => {
    it("inserts valid, closed code fences with non-nested snippet fields", () => {
        expect(Object.keys(CODE_TEMPLATES)).toEqual([
            "csv",
            "tsv",
            "mermaid",
            "callouth",
            "schemath",
            "graphth",
            "termth",
        ]);
        for (const [name, sample] of Object.entries(CODE_TEMPLATES)) {
            expect(sample.startsWith(`\`\`\`${name}`)).toBe(true);
            expect(sample.endsWith("```")).toBe(true);
            expect(/<[^<>\n]*</.test(sample)).toBe(false);
            expect(parseDoc(`---\ntitle: Test\n---\n\n${fill(sample)}\n`).errors).toEqual([]);
        }
    });
});
