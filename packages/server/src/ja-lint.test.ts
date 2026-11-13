import { describe, expect, it } from "vitest";
import { lintJa } from "./ja-lint.js";

describe("lintJa", () => {
    it("detects doubled particles (joshi) with offsets", async () => {
        const typos = await lintJa("私は彼は好きな食べ物について話した。\n");
        const joshi = typos.find((t) => t.ruleId === "no-doubled-joshi");
        expect(joshi).toBeDefined();
        expect(joshi?.range[0]).toBeGreaterThanOrEqual(0);
        expect(joshi?.range[1]).toBeGreaterThan(joshi?.range[0] ?? -1);
    });

    it("detects unmatched brackets", async () => {
        const typos = await lintJa("- 箇条書きの中の(かっこが閉じていない\n");
        expect(typos.some((t) => t.ruleId === "no-unmatched-pair")).toBe(true);
    });

    it("returns an empty array for a sentence without problems", async () => {
        expect(await lintJa("これは普通の文です。\n")).toEqual([]);
    });

    it("excludes writing-style / sentence-length style rules (not typos)", async () => {
        // Deliberately mixing in the dearu style is not flagged, since no-mix-dearu-desumasu is
        // disabled.
        const typos = await lintJa("これはですます調の文である。\n");
        expect(typos.some((t) => t.ruleId === "no-mix-dearu-desumasu")).toBe(false);
    });
});
