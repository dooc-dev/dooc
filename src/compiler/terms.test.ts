import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileDraft, compileSite } from "./compile.js";
import { collectRefs, parseDoc } from "./dialect.js";
import { formatMarkdown } from "./format.js";
import { parseTermSource } from "./terms.js";

const source = (body: string): string => `---\ntitle: Test\n---\n\n${body}\n`;
const declaration =
    ":::term( api-client )\nname: API\ndefinition: |\n  First line.\n  Second line.\n:::";

describe("term declarations and references", () => {
    it("parses the ID, required fields and optional description without treating YAML as Markdown", () => {
        const parsed = parseDoc(source(declaration));
        expect(parsed.errors).toEqual([]);
        expect(parsed.terms).toEqual([
            { id: "api-client", name: "API", definition: "First line.\nSecond line.\n" },
        ]);
        expect(
            parseTermSource("api", "name: API\ndefinition: Interface\ndescription: Brief")
                .entries[0],
        ).toEqual({ id: "api", name: "API", definition: "Interface", description: "Brief" });
        expect(
            parseTermSource("api", 'name: API\ndefinition: Interface\ndescription: ""').errors,
        ).toEqual([]);
    });

    it.each([
        ["Bad ID", "name: API\ndefinition: Interface"],
        ["api", "name: API"],
        ["api", "definition: Interface"],
        ["api", "name: API\ndefinition: 42"],
        ["api", "name: API\ndefinition: Interface\ndescription: 42"],
        ["api", "name: API\ndefinition: Interface\nunknown: field"],
        ["api", "- name: API\n  definition: Interface"],
        ["api", "name: API\nname: Duplicate\ndefinition: Interface"],
    ])("rejects malformed term %s / %s", (id, body) => {
        const result = parseTermSource(id, body);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.entries).toEqual([]);
    });

    it("requires a closing delimiter, while a standalone reference stays a paragraph", () => {
        expect(parseDoc(source(declaration.replace(/\n:::$/, ""))).errors.join()).toContain(
            "must close",
        );
        const parsed = parseDoc(source(":::term(api-client)\n\nText"));
        expect(parsed.errors).toEqual([]);
        expect(parsed.terms).toEqual([]);
        expect(collectRefs(parsed.root).terms).toEqual(["api-client"]);
        const callout = parseDoc(source(":::callout[Note]\n:::term(api-client)\n:::"));
        expect(callout.errors).toEqual([]);
        expect(collectRefs(callout.root).terms).toEqual(["api-client"]);
    });

    it("preserves references and definitions when formatting, including at the start of a line", () => {
        const body = `${declaration}\n\n:::term(api-client)\n\nText :::term(api-client).\n\n- :::term(api-client)\n\n\`:::term(unknown)\`\n`;
        const formatted = formatMarkdown(body);
        expect(formatted).toContain("\n:::term(api-client)\n");
        expect(formatted).toContain(declaration);
        expect(formatMarkdown(formatted)).toBe(formatted);
        expect(collectRefs(parseDoc(source(formatted)).root).terms).toEqual(["api-client"]);
    });

    it("validates cross-page IDs and unsaved definitions, ignoring ordinary text, links and code", () => {
        const root = mkdtempSync(join(tmpdir(), "docs-terms-"));
        try {
            mkdirSync(join(root, "content"));
            writeFileSync(join(root, "manifest.yaml"), "- definitions\n- usage\n");
            writeFileSync(join(root, "content/definitions.md"), source(declaration));
            writeFileSync(
                join(root, "content/usage.md"),
                source(
                    "API :::term(api-client)\n\n`:::term(missing)`\n\n[:::term(missing)](https://example.com)\n\n```\n:::term(missing)\n```",
                ),
            );
            const built = compileSite(root);
            expect(built.errors).toEqual([]);
            expect(built.artifact.docs[1]?.refs.terms).toEqual(["api-client"]);
            writeFileSync(join(root, "content/usage.md"), source(":::term(missing)"));
            expect(compileSite(root).errors.join()).toContain(":::term(missing) is unresolved");
            const context = {
                docs: [{ id: "definitions", file: "content/definitions.md" }],
                figures: new Map(),
                termSources: [{ file: "content/definitions.md", entries: built.artifact.terms }],
            };
            expect(
                compileDraft(
                    context,
                    "content/definitions.md",
                    source(":::term(api-client)"),
                ).source.errors.join(),
            ).toContain("unresolved");
            expect(
                compileDraft(
                    context,
                    "content/definitions.md",
                    source(`${declaration}\n\n:::term(api-client)`),
                ).source.errors,
            ).toEqual([]);
            expect(
                compileDraft(context, "content/other.md", source(declaration)).source.errors.join(),
            ).toContain("duplicate term ID");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
