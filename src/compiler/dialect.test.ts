import { describe, expect, it } from "vitest";
import { collectRefs, parseDoc } from "./dialect.js";

const fm = (body: string): string => `---\ntitle: "t"\n---\n\n${body}\n`;

describe("parseDoc", () => {
    it("accepts an in-dialect doc and returns body / front-matter", () => {
        const doc = parseDoc(
            `---\ntitle: "Sample"\n---\n\n:::figure(sample_model.png)[Sample model]\n\n## Details\n\nBody \`code\` and [link](https://example.com).\n\n:::callout[Key points]\n- Item\n  - Child\n:::\n`,
        );
        expect(doc.errors).toEqual([]);
        expect(doc.frontmatter?.title).toBe("Sample");
        // body is the original text (leaf rewriting only applies to the source used for parsing).
        expect(doc.body.startsWith(":::figure(sample_model.png)[Sample model]")).toBe(true);
        expect(collectRefs(doc.root).figures).toEqual(["sample_model.png"]);
    });

    it("rejects removed document tags", () => {
        expect(parseDoc("---\ntitle: Example\ntags: [old]\n---\n").errors.join()).toContain(
            'unknown key "tags"',
        );
    });

    it.each(["description", "desc"])("rejects document %s metadata", (key) => {
        expect(parseDoc(`---\ntitle: Example\n${key}: Removed\n---\n`).errors.join()).toContain(
            `unknown key "${key}"`,
        );
    });

    it("requires title", () => {
        expect(
            parseDoc(`---\ntags: [x]\n---\ny\n`).errors.some((e) =>
                e.includes('"title" (string) is required'),
            ),
        ).toBe(true);
    });

    it("rejects missing front-matter / unknown keys", () => {
        expect(parseDoc("Body only\n").errors).toContain(
            "front-matter (---) is required at the top",
        );
        const unknown = parseDoc(`---\ntitle: "t"\nfoo: 1\n---\nx\n`);
        expect(unknown.errors.some((e) => e.includes('unknown key "foo"'))).toBe(true);
    });

    it("accepts a BCP 47 front-matter lang and rejects anything else", () => {
        const withLang = (lang: string): string[] =>
            parseDoc(`---\ntitle: "t"\nlang: ${lang}\n---\nx\n`).errors;
        expect(withLang('"ja"')).toEqual([]);
        expect(withLang('"pt-BR"')).toEqual([]);
        for (const bad of ['"日本語"', '"en_US"', "1"]) {
            expect(withLang(bad).some((e) => e.includes('"lang" must be a BCP 47'))).toBe(true);
        }
    });

    it("rejects out-of-dialect nodes (textDirective / html / strong / h4)", () => {
        expect(
            parseDoc(fm("The env:dev environment")).errors.some((e) => e.includes("textDirective")),
        ).toBe(true);
        expect(parseDoc(fm("A raw <div> tag")).errors.some((e) => e.includes("html"))).toBe(true);
        expect(parseDoc(fm("**bold**")).errors.some((e) => e.includes("strong"))).toBe(true);
        expect(
            parseDoc(fm("#### h4 heading")).errors.some((e) =>
                e.includes("only # / ## / ### headings"),
            ),
        ).toBe(true);
        // Passes once escaped
        expect(parseDoc(fm("The env\\:dev environment")).errors).toEqual([]);
        expect(parseDoc(fm("A raw \\<div> tag")).errors).toEqual([]);
    });

    it("allows # (h1) in the body as a heading independent of the front-matter title h1", () => {
        expect(parseDoc(fm("# h1 heading")).errors).toEqual([]);
    });

    it("validates directive shapes", () => {
        expect(parseDoc(fm(":::html(a.html)")).errors).toEqual([]);
        expect(parseDoc(fm(":::figure(a.drawio.svg)")).errors).toEqual([]);
        // Extensions are a closed set per directive
        expect(
            parseDoc(fm(":::figure(a.html)")).errors.some((e) =>
                e.includes("unsupported extension"),
            ),
        ).toBe(true);
        expect(
            parseDoc(fm(":::html(a.svg)")).errors.some((e) => e.includes("unsupported extension")),
        ).toBe(true);
        // html takes no caption
        expect(
            parseDoc(fm(":::html(a.html)[x]")).errors.some((e) =>
                e.includes("does not take a [caption]"),
            ),
        ).toBe(true);
        // Malformed one-line syntax (path with spaces / no closing paren) is rejected with a
        // line number
        expect(parseDoc(fm(":::figure(a b.png)")).errors[0]).toContain(
            "L5: leaf directives must be written as",
        );
        expect(parseDoc(fm(":::figure(a.png")).errors[0]).toContain(
            "L5: leaf directives must be written as",
        );
        // Syntax inside code fences is neither rewritten nor validated
        expect(parseDoc(fm("```bash\n:::figure(a b.png)\n```")).errors).toEqual([]);
        // Attribute form / unknown directives are errors
        expect(
            parseDoc(fm('::figure{name="x"}')).errors.some((e) =>
                e.includes(":::figure must be written as"),
            ),
        ).toBe(true);
        expect(
            parseDoc(fm(':::callout{title="t"}\nBody\n:::')).errors.some((e) =>
                e.includes("attributes are not allowed"),
            ),
        ).toBe(true);
        expect(
            parseDoc(fm(":::figure\nx\n:::")).errors.some((e) => e.includes("unknown container")),
        ).toBe(true);
        for (const src of ["::figures", "::dictionary", '::presentation{name="x"}']) {
            expect(parseDoc(fm(src)).errors.some((e) => e.includes("unknown leaf"))).toBe(true);
        }
        expect(
            parseDoc(fm(":::table\n| a |\n| --- |\n| 1 |\n:::")).errors.some((e) =>
                e.includes("unknown container"),
            ),
        ).toBe(true);
        // callout accepts paragraphs only, lists only, or a mix
        expect(parseDoc(fm(":::callout\nBody only\n:::")).errors).toEqual([]);
        expect(parseDoc(fm(":::callout[t]\nBody\n\n- Item\n:::")).errors).toEqual([]);
        // Anything other than list/paragraph (table, etc.) is rejected
        expect(
            parseDoc(fm(":::callout\n| a | b |\n| --- | --- |\n| 1 | 2 |\n:::")).errors.some((e) =>
                e.includes("paragraphs / lists"),
            ),
        ).toBe(true);
    });

    it("validates :::schema content as raw table DSL text (not as markdown)", () => {
        const dsl =
            "### catalog\ncategories:\n  id: pk\n\nitems:\n  id: pk\n  category: fk(categories)";
        // ### inside is a group, not a heading, and indented lines aren't code blocks = no
        // out-of-dialect errors
        expect(parseDoc(fm(`:::schema[sample schema]\n${dsl}\n:::`)).errors).toEqual([]);
        // Also accepted with a common indent (2 spaces)
        expect(parseDoc(fm(":::schema\n  a:\n    id: pk\n:::")).errors).toEqual([]);
        // No fences
        const fence = parseDoc(fm(":::schema\n```\na:\n  id: pk\n```\n:::"));
        expect(fence.errors.some((e) => e.includes("``` is not allowed"))).toBe(true);
        // Empty content
        const empty = parseDoc(fm(":::schema\n:::"));
        expect(empty.errors.some((e) => e.includes("is empty"))).toBe(true);
        // Attributes aren't allowed (caption goes in [caption])
        const attr = parseDoc(fm(':::schema{caption="x"}\na:\n  id: pk\n:::'));
        expect(attr.errors.some((e) => e.includes("attributes are not allowed"))).toBe(true);
    });

    it(":::schema DSL errors are reported at the doc line number (= not publishable)", () => {
        // 1:--- 2:title 3:--- 4:empty 5=:::schema 6=a: 7=  id: pk 8=  x: nope 9=  y: fk(none)
        const doc = parseDoc(fm(":::schema\na:\n  id: pk\n  x: nope\n  y: fk(none)\n:::"));
        expect(doc.errors).toEqual([
            'L8: :::schema unknown type "nope" ("x") — allowed: pk / fk(<table>) / fk[](<table>) / enum("a"|"b") / string / number / bool / json / timestamp',
            'L9: :::schema "a.y" references table "none", which is not declared',
        ]);
    });

    it("validates schema comments and reports unclosed blocks at the document line", () => {
        expect(
            parseDoc(fm(":::schema\n// description: ignored\na:\n  id: pk /* key */\n:::")).errors,
        ).toEqual([]);
        expect(parseDoc(fm(":::schema\na:\n  id: pk\n/* unfinished\ncomment\n:::")).errors).toEqual(
            ["L8: :::schema /* comment is not closed — */ is required"],
        );
    });

    it("validates :::graph content as raw node / edge DSL text (not as markdown)", () => {
        // `[id]: ...` has the same shape as a markdown link definition, so check it's read as raw
        // text
        const dsl = "[input]: Input @edge\n[worker]: Worker @compute\n\n[input] -> [worker]";
        expect(parseDoc(fm(`:::graph[Route]\n${dsl}\n:::`)).errors).toEqual([]);
        // A leading # is a note (not taken as a heading); also accepted with a common indent
        expect(
            parseDoc(fm(":::graph\n  # Note\n  [a]: A\n  [b]: B\n  [a] -> [b]\n:::")).errors,
        ).toEqual([]);
        const empty = parseDoc(fm(":::graph\n:::"));
        expect(empty.errors.some((e) => e.includes("is empty"))).toBe(true);
        const attr = parseDoc(fm(':::graph{caption="x"}\n[a]: A\n:::'));
        expect(attr.errors.some((e) => e.includes("attributes are not allowed"))).toBe(true);
    });

    it(":::graph DSL errors are reported at the doc line number (= not publishable)", () => {
        // 1:--- 2:title 3:--- 4:empty 5=:::graph 6=[a]: A 7=[a] -> [nope]
        const doc = parseDoc(fm(":::graph\n[a]: A\n[a] -> [nope]\n:::"));
        expect(doc.errors).toEqual(['L7: :::graph edge node "nope" is not declared']);
    });

    it("code fences accept standard and custom language labels", () => {
        for (const language of ["python", "javascript", "rust", "custom-dsl", "mermaid"]) {
            expect(parseDoc(fm(`\`\`\`${language}\nx\n\`\`\``)).errors).toEqual([]);
        }
        expect(parseDoc(fm("```toml\nx=1\n```")).errors).toEqual([]);
        expect(parseDoc(fm("```sql\nSELECT * FROM users;\n```")).errors).toEqual([]);
    });
});
