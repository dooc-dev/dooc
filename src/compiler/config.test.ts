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
    it("defaults to en and no extra adapters when the file is absent", async () => {
        expect(await loadDocsConfig(rootWith())).toEqual({ defaultLang: "en", languages: [] });
    });

    it("reads defaultLang and adapters (functions included)", async () => {
        const config = await loadDocsConfig(
            rootWith(
                'export default { defaultLang: "ko", languages: [{ code: "ko", spellcheckLang: "ko", compareTerms: (a, b) => a.term.localeCompare(b.term) }] };\n',
            ),
        );
        expect(config.defaultLang).toBe("ko");
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
        expect(await bad('export default { defaultLang: "日本語" };\n')).toContain(
            "defaultLang must be a BCP 47",
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
