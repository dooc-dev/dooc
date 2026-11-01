import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { expect, it } from "vitest";
import { CODE_LANGS } from "../core/taxonomy.js";
import {
    addCodeLanguage,
    CODE_LANGUAGES_DIR,
    loadCodeGrammars,
    loadCodeLanguages,
} from "./code-languages.js";
import { exportEntries } from "./export.js";

it("registers built-in and custom grammars outside content, keeps them in source exports, and refuses overwrite", async () => {
    const root = mkdtempSync(join(tmpdir(), "docs-code-languages-"));
    try {
        const input = join(root, "tdl.tmLanguage.json");
        writeFileSync(
            input,
            JSON.stringify({
                name: "tdl",
                scopeName: "source.tdl",
                patterns: [{ match: "\\bimport\\b", name: "keyword.control.tdl" }],
            }),
        );
        expect(await addCodeLanguage(root, input)).toBe(`${CODE_LANGUAGES_DIR}/tdl.json`);
        expect(await addCodeLanguage(root, "lua")).toBe(`${CODE_LANGUAGES_DIR}/lua.json`);
        expect(existsSync(join(root, "content"))).toBe(false);
        const before = readFileSync(join(root, CODE_LANGUAGES_DIR, "tdl.json"), "utf8");
        await expect(addCodeLanguage(root, input)).rejects.toThrow();
        expect(readFileSync(join(root, CODE_LANGUAGES_DIR, "tdl.json"), "utf8")).toBe(before);
        const loaded = await loadCodeLanguages(root);
        expect(loaded.codeLanguages).toEqual(expect.arrayContaining(["python", "lua", "tdl"]));
        expect(loaded.codeGrammars.find((grammar) => grammar.name === "tdl")?.scopeName).toBe(
            "source.tdl",
        );
        expect(exportEntries(root).map((entry) => entry.name)).toEqual([
            `${CODE_LANGUAGES_DIR}/lua.json`,
            `${CODE_LANGUAGES_DIR}/tdl.json`,
        ]);
        writeFileSync(join(root, CODE_LANGUAGES_DIR, "broken.json"), '{"name":"../escape"}');
        await expect(loadCodeLanguages(root)).rejects.toThrow("broken.json");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it("loads defaults, additions and aliases with the browser's regex engine", async () => {
    const highlighter = await createHighlighterCore({
        langs: await loadCodeGrammars([...CODE_LANGS, "lua"]),
        themes: [import("@shikijs/themes/github-light")],
        engine: createJavaScriptRegexEngine(),
    });
    try {
        for (const lang of [...CODE_LANGS, "js", "ts", "py", "sh", "yml", "lua"]) {
            const source = 'function example() { return "hello"; }';
            const { tokens } = highlighter.codeToTokens(source, { lang, theme: "github-light" });
            expect(
                tokens
                    .flat()
                    .map((token) => token.content)
                    .join(""),
            ).toBe(source);
        }
        expect(
            highlighter
                .codeToTokens("def hello():\n    return True", {
                    lang: "python",
                    theme: "github-light",
                })
                .tokens.flat()
                .some((token) => token.color),
        ).toBe(true);
    } finally {
        highlighter.dispose();
    }
});
