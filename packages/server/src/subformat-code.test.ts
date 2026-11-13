import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { afterEach, expect, it } from "vitest";
import { loadCodeGrammars } from "../../engine/src/compiler/code-languages.js";
import { compileSite } from "../../engine/src/compiler/compile.js";
import { codeFileName } from "../../engine/src/core/code-file.js";
import { codeFileResponse } from "./code-file.js";
import { resourceIndex } from "./resource-library.js";
import { editorBoot, publishHtml, siteFrom } from "./serve.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([
    ["json", '{\n  "title": "Example"\n}'],
    ["yaml", "title: Example"],
    ["toml", 'title = "Example"'],
])("uses the .issue fence for %s highlighting, completion, indexing and file creation", async (format, source) => {
    const root = mkdtempSync(join(tmpdir(), "dooc-subformat-code-"));
    roots.push(root);
    mkdirSync(join(root, "content"));
    writeFileSync(
        join(root, "dooc.yaml"),
        `docs: [a]\nsubformats: [{ext: issue, format: ${format}, schema: issue.schema.json}]\n`,
    );
    writeFileSync(
        join(root, "issue.schema.json"),
        JSON.stringify({
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
        }),
    );
    const body = `\`\`\`.issue\n${source}\n\`\`\``;
    writeFileSync(join(root, "content/a.md"), `${body}\n`);
    const compiled = compileSite(root);
    expect(compiled.errors).toEqual([]);
    const code = { codeLanguages: [format], codeGrammars: await loadCodeGrammars([format]) };
    const site = siteFrom(compiled, undefined, code);
    const entry = site.entries[0];
    if (!entry) throw new Error("Missing document");
    expect(entry.blocks[0]).toEqual({ type: "code", lang: ".issue", lines: source.split("\n") });
    expect(editorBoot(entry, site).codeLanguages).toContain(".issue");
    expect(publishHtml(site, "")).toContain('data-lang=".issue"');
    expect(code.codeGrammars[0]?.aliases ?? []).not.toContain(".issue");

    const highlighter = await createHighlighterCore({
        langs: site.codeGrammars,
        themes: [import("@shikijs/themes/github-light")],
        engine: createJavaScriptRegexEngine(),
    });
    try {
        const expected = highlighter.codeToTokens(source, { lang: format, theme: "github-light" });
        for (const lang of [".issue", "issue"])
            expect(
                highlighter.codeToTokens(source, { lang, theme: "github-light" }).tokens,
            ).toEqual(expected.tokens);
        expect(expected.tokens.flat().some((token) => token.color)).toBe(true);
    } finally {
        highlighter.dispose();
    }

    const index = resourceIndex(root, ["content/a.md", "issue.schema.json"]);
    expect(index.errors).toEqual([]);
    expect(index.codeblocks).toContainEqual({
        language: format,
        format: "issue",
        caption: "",
        content: source,
        source: { file: "content/a.md", line: 1 },
    });
    expect(index.subformats[0]?.records).toEqual([]);

    const result = codeFileResponse(root, { body, position: 2, documentId: "a" });
    expect(result).toMatchObject({ status: 200, body: { file: "files/issue/a-1.issue" } });
    const file = join(root, "files/issue/a-1.issue");
    expect(readFileSync(file, "utf8")).toBe(`${source}\n`);
    if (!("change" in result.body) || !result.body.change) throw new Error("Missing change");
    writeFileSync(join(root, "content/a.md"), `${result.body.change.insert}\n`);
    const extracted = compileSite(root);
    expect(extracted.errors).toEqual([]);
    expect(extracted.docs[0]?.blocks[0]).toMatchObject({ type: "code", lang: "issue" });
    const invalid = codeFileResponse(root, {
        body: `\`\`\`.issue\n${source.replaceAll("title", "missing")}\n\`\`\``,
        position: 2,
        documentId: "a",
    });
    expect(invalid).toMatchObject({ status: 400 });
    expect(existsSync(join(root, "files/issue/a-1-2.issue"))).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(`${source}\n`);
});

it("preserves registered languages and derives subformat aliases from the current configuration", async () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-subformat-code-"));
    roots.push(root);
    writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
    const compiled = compileSite(root);
    const code = {
        codeLanguages: ["json", "python"],
        codeGrammars: await loadCodeGrammars(["json", "python"]),
    };
    compiled.subformats = [{ ext: "python", format: "json", schema: "python.schema.json" }];
    const site = siteFrom(compiled, undefined, code);
    const json = site.codeGrammars?.find((grammar) => grammar.name === "json");
    expect(json?.aliases).toContain(".python");
    expect(json?.aliases).not.toContain("python");
    expect(codeFileName("```.python\n{}\n```", 2, "a")).toBe("examples/a-1.python");
    expect(codeFileName("```python\npass\n```", 2, "a")).toBe("examples/a-1.py");
    compiled.subformats = [];
    const updated = siteFrom(compiled, undefined, code);
    expect(updated.codeLanguages).not.toContain(".python");
    expect(updated.codeGrammars?.find((grammar) => grammar.name === "json")?.aliases).not.toContain(
        ".python",
    );
});
