import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLanguage } from "../core/language.js";
import { BUILTIN_LANGUAGES, loadSiteLanguages } from "./languages.js";

describe("built-in language adapters (Node side)", () => {
    it("ja carries the textlint prose lint; languages without an adapter have none", async () => {
        const { lint } = resolveLanguage("ja-JP", BUILTIN_LANGUAGES);
        expect(lint).toBeTypeOf("function");
        expect((await lint?.("- 箇条書きの中の(かっこが閉じていない\n"))?.length).toBeGreaterThan(
            0,
        );
        expect(resolveLanguage("en", BUILTIN_LANGUAGES).lint).toBeUndefined();
    });

    it("docs.config.mjs adapters come first, so they override a built-in code", async () => {
        const root = mkdtempSync(join(tmpdir(), "docs-langs-"));
        writeFileSync(
            join(root, "docs.config.mjs"),
            'export default { languages: [{ code: "ja", spellcheckLang: "ja" }] };\n',
        );
        const site = await loadSiteLanguages(root);
        expect(resolveLanguage("ja", site.languages).spellcheckLang).toBe("ja");
        expect(resolveLanguage("ja", site.languages).lint).toBeUndefined();
    });
});
