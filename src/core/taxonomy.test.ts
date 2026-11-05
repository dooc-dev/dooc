import { describe, expect, it } from "vitest";
import { parseDoc } from "../compiler/dialect.js";
import {
    CODE_TEMPLATES,
    CONTAINER_DIRECTIVES,
    DIRECTIVES,
    findDirective,
    LEAF_DIRECTIVES,
} from "./taxonomy.js";

// Reduce the author-filled spots `<...>` to bare words (the editor makes the same spots snippet
// fields).
const fill = (sample: string): string => sample.replace(/<([^<>\n]+)>/g, "$1");

describe("DIRECTIVES (catalog of the custom syntax vocabulary)", () => {
    it("name lists are derived from the catalog (no double declaration)", () => {
        expect(LEAF_DIRECTIVES).toEqual([]);
        expect(CONTAINER_DIRECTIVES).toEqual(["callout", "schema"]);
        for (const d of DIRECTIVES) {
            expect(findDirective(d.kind, d.name)).toBe(d);
        }
        // Lookup with the wrong kind fails (`:::figure` / `::callout` are unknown directives).
        expect(findDirective("container", "figure")).toBeUndefined();
        expect(findDirective("leaf", "callout")).toBeUndefined();
    });

    it("samples start with ::: + name and containers close with ::: (= matches the completion label)", () => {
        for (const d of DIRECTIVES) {
            const lines = d.sample.split("\n");
            expect(lines[0]?.startsWith(`:::${d.name}`)).toBe(true);
            if (d.kind === "container") {
                expect(lines.length).toBeGreaterThanOrEqual(2);
                expect(lines.at(-1)).toBe(":::");
            } else {
                expect(lines).toHaveLength(1);
            }
            // Samples of directives that take no caption contain no [..]
            expect(d.caption || !lines[0]?.includes("[")).toBe(true);
        }
    });

    it("inserts valid named code blocks without IDs for terms", () => {
        for (const sample of Object.values(CODE_TEMPLATES))
            expect(parseDoc(`---\ntitle: Test\n---\n\n${fill(sample)}\n`).errors).toEqual([]);
    });

    it("filled-in samples pass the dialect as-is (= never inserts a broken template)", () => {
        for (const d of DIRECTIVES) {
            expect(parseDoc(`---\ntitle: "t"\n---\n\n${fill(d.sample)}\n`).errors).toEqual([]);
        }
    });

    it("`<...>` never nests (a precondition of the editor's snippet field conversion)", () => {
        for (const d of DIRECTIVES) {
            expect(/<[^<>\n]*</.test(d.sample)).toBe(false);
        }
    });
});
