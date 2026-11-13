import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDocsConfig } from "./config.js";

const rootWith = (config?: string): string => {
    const root = mkdtempSync(join(tmpdir(), "docs-config-"));
    if (config != null) {
        writeFileSync(join(root, "docs.config.mjs"), config);
    }
    return root;
};

describe("loadDocsConfig (docs.config.mjs)", () => {
    it("uses no extra adapters when the file is absent", async () => {
        expect(await loadDocsConfig(rootWith())).toEqual({
            languages: [],
        });
    });

    it("reads adapters including functions", async () => {
        const config = await loadDocsConfig(
            rootWith(
                'export default { languages: [{ code: "ko", spellcheckLang: "ko", compareTerms: (a, b) => a.name.localeCompare(b.name) }] };\n',
            ),
        );
        expect(config.languages.map((l) => l.code)).toEqual(["ko"]);
        expect(typeof config.languages[0]?.compareTerms).toBe("function");
    });

    it("rejects an invalid shape with a message naming the file and field", async () => {
        const bad = async (config: string): Promise<string> =>
            loadDocsConfig(rootWith(config)).then(
                () => "no error",
                (e: Error) => e.message,
            );
        expect(await bad("export default 1;\n")).toContain("default export must be an object");
        expect(await bad('export default { defaultLang: "ja" };\n')).toContain(
            "move defaultLang to dooc.yaml",
        );
        expect(await bad("export default { languages: {} };\n")).toContain(
            "languages must be an array",
        );
        expect(await bad('export default { languages: [{ code: "x_y" }] };\n')).toContain(
            "languages[0].code",
        );
        expect(await bad('export default { languages: [{ code: "ko", lint: "x" }] };\n')).toContain(
            "languages[0].lint must be a function",
        );
    });
});
