import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { blocksHtml } from "../core/html.js";
import { compileDraft, compileSite, createCompiler } from "./compile.js";
import { collectRefs, parseDoc } from "./dialect.js";
import { exportEntries } from "./export.js";
import { formatMarkdown } from "./format.js";
import { toBlocks } from "./from-mdast.js";
import { parseTermSource } from "./terms.js";

const source = (body: string): string => `---\ntitle: Test\n---\n\n${body}\n`;
const yaml = "name: API\ndefinition: |\n  First line.\n  Second line.\ndescription: Brief\n";
const declaration = `~~~termth\n${yaml}~~~`;

describe("termth definitions and file links", () => {
    it("renders YAML code blocks without IDs and preserves them through formatting", () => {
        const parsed = parseDoc(source(declaration));
        expect(parsed.errors).toEqual([]);
        expect(parsed.terms).toEqual([
            {
                id: "inline#L5",
                name: "API",
                definition: "First line.\nSecond line.\n",
                description: "Brief",
            },
        ]);
        expect(toBlocks(parsed.root, parsed.source).blocks).toEqual([
            { type: "term", entry: parsed.terms[0] },
        ]);
        const formatted = formatMarkdown(`${declaration}\n\n[](terms/api.termth)\n`);
        expect(formatted).toContain(declaration);
        expect(formatMarkdown(formatted)).toBe(formatted);
        expect(collectRefs(parseDoc(source(formatted)).root).terms).toEqual(["terms/api.termth"]);
    });

    it.each([
        "name: API",
        "definition: Interface",
        "name: API\ndefinition: 42",
        "name: API\ndefinition: Interface\ndescription: 42",
        "name: API\ndefinition: Interface\nid: api",
        "- name: API\n  definition: Interface",
        "name: API\nname: Duplicate\ndefinition: Interface",
        "name: &value API\ndefinition: *value",
    ])("rejects malformed term definitions: %s", (body) => {
        const result = parseTermSource("terms/api.termth", body);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.entries).toEqual([]);
    });

    it("rejects removed directives, fence IDs, nesting and missing closing fences", () => {
        for (const body of [
            ":::term(api)",
            ":::term(api)\nname: API\ndefinition: Interface\n:::",
            ":::graph\n[a]: A\n:::",
            declaration.replace(/~~~$/, ""),
            declaration.replace("~~~termth", "~~~termth api"),
            `:::callout\n${declaration}\n:::`,
        ])
            expect(parseDoc(source(body)).errors.length).toBeGreaterThan(0);
        expect(
            parseDoc(source("```md\n:::term(api)\n:::graph\n```\n\n`:::term(api)`")).errors,
        ).toEqual([]);
    });

    it("finds term links in prose, lists and tables, but ignores examples and ordinary links", () => {
        const parsed = parseDoc(
            source(
                "[](./terms/api.termth)\n\n- [API](terms/api.termth)\n\n| Term |\n| --- |\n| [](terms/api.termth) |\n\n`[](missing.termth)`\n\n\\[](missing.termth)\n\n```md\n[](missing.termth)\n```\n\n[site](https://example.com)",
            ),
        );
        expect(parsed.errors).toEqual([]);
        expect(collectRefs(parsed.root).terms).toEqual(["terms/api.termth"]);
        const entry = parseTermSource("terms/api.termth", yaml).entries[0];
        if (!entry) throw new Error("Missing term");
        const literal = parseDoc(source("[](terms/api.termth) \\[](terms/api.termth)"));
        const html = blocksHtml(toBlocks(literal.root, literal.source).blocks, {
            figures: new Map(),
            terms: [entry],
        });
        expect(html.match(/class="dictref"/g)).toHaveLength(1);
        expect(html).toContain("[](terms/api.termth)");
    });

    it("loads shared files, updates cached documents and drafts, and exports term sources", () => {
        const root = mkdtempSync(join(tmpdir(), "docs-terms-"));
        try {
            mkdirSync(join(root, "content"));
            mkdirSync(join(root, "terms"));
            writeFileSync(join(root, "dooc.yaml"), "- a\n- b\n");
            writeFileSync(join(root, "terms/api.termth"), yaml);
            const body = source("[](terms/api.termth)\n\n[Interface](./terms/api.termth)");
            for (const id of ["a", "b"]) writeFileSync(join(root, "content", `${id}.md`), body);
            const compiler = createCompiler(root);
            const built = compiler.compile();
            expect(built.errors).toEqual([]);
            expect(built.terms).toHaveLength(1);
            expect(built.docs[0]?.refs.terms).toEqual(["terms/api.termth"]);
            expect(
                exportEntries(root)
                    .find((entry) => entry.name === "terms/api.termth")
                    ?.data.toString(),
            ).toBe(yaml);
            writeFileSync(join(root, "terms/api.termth"), "name: Updated\ndefinition: Changed\n");
            expect(compiler.compile().terms[0]?.name).toBe("Updated");
            const draft = compileDraft(
                {
                    root,
                    docs: built.docs,
                    figures: new Map(),
                    textfiles: new Map([
                        ["terms/api.termth", "name: Draft\ndefinition: Unsaved\n"],
                    ]),
                },
                "content/a.md",
                body,
            );
            expect(draft.source.errors).toEqual([]);
            expect(draft.source.terms[0]?.name).toBe("Draft");
            expect(compiler.compile().terms[0]?.name).toBe("Updated");
            rmSync(join(root, "terms/api.termth"));
            expect(compiler.compile().errors.join()).toContain("terms/api.termth:");
            expect(compiler.compile().terms).toEqual([]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("handles encoded filenames and rejects unsafe local or external references", () => {
        for (const url of [
            "../api.termth",
            "%2e%2e/api.termth",
            "/api.termth",
            "https://example.com/api.termth",
            "terms/api.termth?x=1",
            "terms/api.termth#L1",
        ])
            expect(parseDoc(source(`[](${url})`)).errors.length).toBeGreaterThan(0);
        const root = mkdtempSync(join(tmpdir(), "docs-terms-paths-"));
        const outside = mkdtempSync(join(tmpdir(), "docs-private-term-"));
        try {
            mkdirSync(join(root, "content"));
            writeFileSync(join(root, "dooc.yaml"), "- a\n");
            const file = "日本語 (#1).termth";
            writeFileSync(join(root, file), yaml);
            writeFileSync(
                join(root, "content/a.md"),
                source(
                    `[](<${encodeURIComponent(file).replaceAll("(", "%28").replaceAll(")", "%29")}>)`,
                ),
            );
            const built = compileSite(root);
            expect(built.errors).toEqual([]);
            expect(built.terms[0]?.id).toBe(file);
            expect(
                blocksHtml(built.docs[0]?.blocks ?? [], {
                    figures: new Map(),
                    terms: built.terms,
                }),
            ).toContain('class="dictref"');
            writeFileSync(join(outside, "secret.termth"), yaml);
            symlinkSync(join(outside, "secret.termth"), join(root, "secret.termth"));
            writeFileSync(join(root, "content/a.md"), source("[](secret.termth)"));
            expect(compileSite(root).errors.join()).toContain("outside the docs root");
        } finally {
            rmSync(root, { recursive: true, force: true });
            rmSync(outside, { recursive: true, force: true });
        }
    });
});
