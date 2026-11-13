import { describe, expect, it } from "vitest";
import { collectRefs, parseDoc } from "./dialect.js";
import { toBlocks } from "./from-mdast.js";

const fm = (body: string): string => `${body}\n`;

describe("parseDoc", () => {
    it("collects visual file links in prose and callouts, rejecting paths outside the docs root", () => {
        const parsed = parseDoc(
            fm(
                "[Model](./figures/model.svg)\n\n~~~callouth\n[Model](figures/model.svg) and [Chart](<assets/My (chart).png>)\n~~~\n\nFig.unused\n\n`[Example](figures/example.svg)`\n\n[Remote](https://example.com/remote.svg)",
            ),
        );
        expect(parsed.errors).toEqual([]);
        expect(collectRefs(parsed.root).figures).toEqual([
            "figures/model.svg",
            "assets/My (chart).png",
        ]);
        for (const url of [
            "../model.svg",
            "figures/%2e%2e/model.svg",
            "figures/model.svg?download=1",
            "figures/%FF.svg",
        ]) {
            for (const body of [`[Bad](${url})`, `~~~callouth\n[Bad](${url})\n~~~`]) {
                const invalid = parseDoc(fm(body));
                expect(invalid.errors.length).toBeGreaterThan(0);
                expect(collectRefs(invalid.root).figures).toEqual([]);
            }
        }
    });

    it("accepts an in-dialect doc and returns the body", () => {
        const doc = parseDoc(
            `![Sample model](figures/sample_model.png)\n\n## Details\n\nBody \`code\` and [link](https://example.com).\n\n~~~callouth Key points\n- Item\n  - Child\n~~~\n`,
        );
        expect(doc.errors).toEqual([]);
        // body is the original text (leaf rewriting only applies to the source used for parsing).
        expect(doc.body.startsWith("![Sample model](figures/sample_model.png)")).toBe(true);
        expect(collectRefs(doc.root).figures).toEqual(["figures/sample_model.png"]);
    });

    it("rejects front-matter: titles live in the manifest", () => {
        expect(parseDoc("Body only\n").errors).toEqual([]);
        expect(parseDoc(`---\ntitle: "t"\n---\nx\n`).errors).toEqual([
            "front-matter (---) is not supported; set the title in dooc.yaml",
        ]);
    });

    it("allows Markdown emphasis and quotes while rejecting unsupported HTML and h4", () => {
        expect(parseDoc(fm("The env:dev environment")).errors).toEqual([]);
        expect(parseDoc(fm("A raw <div> tag")).errors.some((e) => e.includes("html"))).toBe(true);
        expect(
            parseDoc(
                fm(
                    "**bold** and _italic_\n\n> Quoted **text**\n>\n> - *Item*\n>\n> > Nested quote",
                ),
            ).errors,
        ).toEqual([]);
        const deep = parseDoc(fm("#### h4\n\n###### h6"));
        expect(deep.errors).toEqual([]);
        expect(toBlocks(deep.root, "").toc.map((entry) => entry.depth)).toEqual([4, 6]);
        // Passes once escaped
        expect(parseDoc(fm("The env\\:dev environment")).errors).toEqual([]);
        expect(parseDoc(fm("A raw \\<div> tag")).errors).toEqual([]);
    });

    it("allows # (h1) in the body as a heading independent of the front-matter title h1", () => {
        expect(parseDoc(fm("# h1 heading")).errors).toEqual([]);
    });

    it("accepts Markdown visual embeds and rejects removed file directives", () => {
        for (const body of ["![](figures/a.html)", "![Caption](./figures/a.drawio.svg)"])
            expect(parseDoc(fm(body)).errors).toEqual([]);
        for (const name of ["figure", "html", "textfile", "term", "graph", "callout", "schema"]) {
            for (const body of [
                `:::${name}(a.svg)`,
                `:::${name}\nx\n:::`,
                `::${name}{src="a.svg"}`,
            ])
                expect(parseDoc(fm(body)).errors.length).toBeGreaterThan(0);
            expect(parseDoc(fm(`\`\`\`md\n:::${name}(a.svg)\n\`\`\``)).errors).toEqual([]);
        }
        expect(parseDoc(fm("![](../a.svg)")).errors.join()).toContain("inside the docs root");
        expect(parseDoc(fm(':::graph{caption="x"}\n[a]: A\n:::')).errors.join()).toContain(
            "removed directive",
        );
        expect(parseDoc(fm("::callout[x]")).errors.join()).toContain("removed directive");
    });

    it("validates ~~~schemath content as raw table DSL text (not as markdown)", () => {
        const dsl =
            "### catalog\ncategories:\n  id: pk\n\nitems:\n  id: pk\n  category: fk(categories)";
        // ### inside is a group, not a heading, and indented lines aren't code blocks = no
        // out-of-dialect errors
        expect(parseDoc(fm(`~~~schemath sample schema\n${dsl}\n~~~`)).errors).toEqual([]);
        // Also accepted with a common indent (2 spaces)
        expect(parseDoc(fm("~~~schemath\n  a:\n    id: pk\n~~~")).errors).toEqual([]);
        // No fences
        const fence = parseDoc(fm("~~~schemath\n```\na:\n  id: pk\n```\n~~~"));
        expect(fence.errors.some((e) => e.includes("``` is not allowed"))).toBe(true);
        // Empty content
        const empty = parseDoc(fm("~~~schemath\n~~~"));
        expect(empty.errors.some((e) => e.includes("is empty"))).toBe(true);
    });

    it("~~~schemath DSL errors are reported at the doc line number (= not publishable)", () => {
        // 1=~~~schemath 2=a: 3=  id: pk 4=  x: nope 5=  y: fk(none)
        const doc = parseDoc(fm("~~~schemath\na:\n  id: pk\n  x: nope\n  y: fk(none)\n~~~"));
        expect(doc.errors).toEqual([
            'L4: schemath unknown type "nope" ("x") — allowed: pk / fk(<table>) / fk[](<table>) / enum("a"|"b") / string / number / bool / json / timestamp',
            'L5: schemath "a.y" references table "none", which is not declared',
        ]);
    });

    it("validates schema comments and reports unclosed blocks at the document line", () => {
        expect(
            parseDoc(fm("~~~schemath\n// description: ignored\na:\n  id: pk /* key */\n~~~"))
                .errors,
        ).toEqual([]);
        expect(
            parseDoc(fm("~~~schemath\na:\n  id: pk\n/* unfinished\ncomment\n~~~")).errors,
        ).toEqual(["L4: schemath /* comment is not closed — */ is required"]);
    });

    it("validates :::graph content as raw node / edge DSL text (not as markdown)", () => {
        // `[id]: ...` has the same shape as a markdown link definition, so check it's read as raw
        // text
        const dsl = "[input]: Input @edge\n[worker]: Worker @compute\n\n[input] -> [worker]";
        expect(parseDoc(fm(`~~~graphth Route\n${dsl}\n~~~`)).errors).toEqual([]);
        // A leading # is a note (not taken as a heading); also accepted with a common indent
        expect(
            parseDoc(fm("~~~graphth\n  # Note\n  [a]: A\n  [b]: B\n  [a] -> [b]\n~~~")).errors,
        ).toEqual([]);
        const empty = parseDoc(fm("~~~graphth\n~~~"));
        expect(empty.errors.some((e) => e.includes("is empty"))).toBe(true);
        const attr = parseDoc(fm(':::graph{caption="x"}\n[a]: A\n:::'));
        expect(attr.errors.some((e) => e.includes("removed directive"))).toBe(true);
    });

    it(":::graph DSL errors are reported at the doc line number (= not publishable)", () => {
        // 1=:::graph 2=[a]: A 3=[a] -> [nope]
        const doc = parseDoc(fm("~~~graphth\n[a]: A\n[a] -> [nope]\n~~~"));
        expect(doc.errors).toEqual(['L3: graphth edge node "nope" is not declared']);
    });

    it("code fences accept standard and custom language labels", () => {
        for (const language of ["python", "javascript", "rust", "custom-dsl", "mermaid"]) {
            expect(parseDoc(fm(`\`\`\`${language}\nx\n\`\`\``)).errors).toEqual([]);
        }
        expect(parseDoc(fm("```toml\nx=1\n```")).errors).toEqual([]);
        expect(parseDoc(fm("```sql\nSELECT * FROM users;\n```")).errors).toEqual([]);
    });

    it("validates callout bodies, local links, and closing fences without accepting nested blocks", () => {
        const valid =
            "~~~callouth Notes\nRead [**more**](content/guide.md#details) and [](terms/a.termth).\n\n1. *First*\n   - Nested\n~~~";
        const parsed = parseDoc(fm(valid));
        expect(parsed.errors).toEqual([]);
        expect(collectRefs(parsed.root).terms).toEqual(["terms/a.termth"]);
        for (const body of [
            "",
            "## Heading",
            "![](image.svg)",
            "[Old](doc:guide)",
            "[Unsafe](../outside.md)",
            "- Item\n\n  ```js\n  x\n  ```",
        ])
            expect(parseDoc(fm(`~~~callouth\n${body}\n~~~`)).errors.length).toBeGreaterThan(0);
        expect(parseDoc(fm("~~~callouth\nText")).errors.join()).toContain("close the code fence");
        expect(parseDoc(fm("[Old](doc:guide)")).errors.join()).toContain("Markdown file link");
    });
});
