// Pins the layer dependency direction (viewer → compiler → core). Test files are exempt (they
// may use upper layers to build fixtures).
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FORBIDDEN: Record<string, string[]> = {
    core: ["../compiler/", "../viewer/"],
    compiler: ["../viewer/"],
};

describe("layers", () => {
    for (const [layer, forbidden] of Object.entries(FORBIDDEN)) {
        it(`${layer} does not import ${forbidden.join(" / ")}`, () => {
            const dir = new URL(`./${layer}/`, import.meta.url);
            const bad = readdirSync(dir)
                .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."))
                .filter((f) => {
                    const src = readFileSync(new URL(f, dir), "utf8");
                    return forbidden.some((p) => src.includes(`"${p}`));
                });
            expect(bad).toEqual([]);
        });
    }
});
