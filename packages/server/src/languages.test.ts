import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLanguage } from "../../engine/src/core/language.js";
import { BUILTIN_LANGUAGES, loadSiteLanguages } from "./languages.js";

afterEach(() => vi.unstubAllEnvs());

describe("built-in language adapters (Node side)", () => {
    it("keeps downloaded configuration intact without executing it in remote sessions", async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-remote-languages-"));
        const marker = join(root, "executed");
        const source = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran'); export default { languages: [{ code: 'en' }] };`;
        writeFileSync(join(root, "docs.config.mjs"), source);
        vi.stubEnv("DOOC_REMOTE_WORKSPACE", "1");
        try {
            const site = await loadSiteLanguages(root);
            expect(site.languages).toEqual(BUILTIN_LANGUAGES);
            expect(site.codeLanguages).toContain("json");
            expect(existsSync(marker)).toBe(false);
            expect(readFileSync(join(root, "docs.config.mjs"), "utf8")).toBe(source);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
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
