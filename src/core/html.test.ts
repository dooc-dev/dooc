import { describe, expect, it } from "vitest";
import { parseDoc } from "../compiler/dialect.js";
import { toBlocks } from "../compiler/from-mdast.js";
import type { Block } from "./blocks.js";
import type { FigureEntry } from "./content-types.js";
import { blocksHtml, docHtml, type RenderCtx, termsHtml } from "./html.js";
import type { SchemaGraphClientData } from "./schema-graph.js";

const fm = (body: string): string => `---\ntitle: "t"\n---\n\n${body}\n`;

const MODEL_FIG: FigureEntry = {
    name: "data_model",
    file: "figures/data_model.svg",
    kind: "svg",
    markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><title>Fig.data_model</title></svg>',
    title: "Fig.data_model",
    desc: "Description text",
};
const CTX: RenderCtx = {
    figures: new Map([[MODEL_FIG.name, MODEL_FIG]]),
    terms: [
        { id: "sla.termth", name: "SLA", definition: "Service Level Agreement" },
        { id: "api", name: "api", definition: "External-facing interface" },
    ],
};

// Pipeline shared by build / preview: dialect md → mdast → Block AST → rendering.
const html = (body: string, ctx?: RenderCtx): string =>
    blocksHtml(toBlocks(parseDoc(fm(body)).root, parseDoc(fm(body)).source).blocks, ctx);

describe("blocksHtml", () => {
    it("renders Markdown emphasis, nested formatting, links and literal escapes", () => {
        const source =
            "**Bold** and _italic_ and ***both***.\n\n[**Linked** *label*](https://example.com)\n\n\\*literal\\* and \\_literal\\_ and a_b_c and ``a ` b``.";
        const output = html(source);
        expect(output).toContain(
            "<strong>Bold</strong> and <em>italic</em> and <em><strong>both</strong></em>",
        );
        expect(output).toContain(
            '<a href="https://example.com"><strong>Linked</strong> <em>label</em></a>',
        );
        expect(output).toContain("*literal* and _literal_ and a_b_c and <code>a ` b</code>");
        expect(html("**\\<script>**")).toContain("<strong>&lt;script&gt;</strong>");
    });

    it("renders emphasis in headings, tables, lists, and callouts without formatting markers in the TOC", () => {
        const source = fm(
            "## **Important** *details*\n\n- **Item**\n\n| *Header* |\n| --- |\n| **Cell** |\n\n~~~callouth Note\n**Bold** and *italic*\n~~~",
        );
        const parsed = parseDoc(source);
        expect(parsed.errors).toEqual([]);
        const converted = toBlocks(parsed.root, source);
        expect(converted.toc).toEqual([
            { depth: 2, text: "Important details", slug: "important-details" },
        ]);
        const output = blocksHtml(converted.blocks);
        expect(output).toContain(
            '<h2 id="important-details"><strong>Important</strong> <em>details</em></h2>',
        );
        expect(output).toContain("<li><strong>Item</strong></li>");
        expect(output).toContain("<th><em>Header</em></th>");
        expect(output).toContain("<td><strong>Cell</strong></td>");
        expect(output).toContain("<p><strong>Bold</strong> and <em>italic</em></p></aside>");
    });

    it("preserves nested quotes, paragraphs, lists and literal fenced code", () => {
        const source = fm(
            "> **Quoted** *text*\n>\n> - A **list**\n>\n> > Nested\n>\n> ```js\n> const text = '**literal**';\n> ```\n\nAfter",
        );
        const parsed = parseDoc(source);
        expect(parsed.errors).toEqual([]);
        const converted = toBlocks(parsed.root, source);
        expect(converted.blocks.map((block) => block.type)).toEqual(["quote", "p"]);
        expect(converted.lines).toHaveLength(2);
        const output = blocksHtml(converted.blocks);
        expect(output).toContain("<blockquote><p><strong>Quoted</strong> <em>text</em></p>");
        expect(output).toContain("<ul><li>A <strong>list</strong></li></ul>");
        expect(output).toContain("<blockquote><p>Nested</p></blockquote>");
        expect(output).toContain("const text = '**literal**';");
        expect(output).toContain("</blockquote>\n<p>After</p>");
        const listed = fm(
            "- Before\n\n  > **Quoted** item\n\n  After\n\n  - Nested\n    > *Nested quote*",
        );
        const parsedList = parseDoc(listed);
        expect(parsedList.errors).toEqual([]);
        const listOutput = blocksHtml(toBlocks(parsedList.root, listed).blocks);
        expect(listOutput).toContain(
            "<li><p>Before</p>\n<blockquote><p><strong>Quoted</strong> item</p></blockquote>\n<p>After</p>",
        );
        expect(listOutput).toContain("<blockquote><p><em>Nested quote</em></p></blockquote>");
    });

    it("ignores legacy document descriptions and keeps figure descriptions", () => {
        const legacy = { title: "Guide", description: "Removed document description" };
        const output = docHtml(legacy, [{ type: "figureRef", name: MODEL_FIG.name }], [], CTX);
        expect(output).not.toContain(legacy.description);
        expect(output).not.toContain('class="lead"');
        expect(output).toContain(MODEL_FIG.desc);
    });

    it("escapes a localized table of contents title in text and its accessible label", () => {
        const output = docHtml({ title: "Guide" }, [], [], { ...CTX, tocTitle: '<Contents "&">' }, [
            { depth: 2, text: "Section", slug: "section" },
        ]);
        expect(output).toContain('aria-label="&lt;Contents &quot;&amp;&quot;&gt;"');
        expect(output).toContain('class="in-toc-title">&lt;Contents &quot;&amp;&quot;&gt;</div>');
    });

    it("renders headings (ASCII slug ids) / paragraphs / inline (code, link, unescaping)", () => {
        const out = html(
            "## Café au lait\n\nBody `code` and [link](https://example.com) and 1\\:1.",
        );
        expect(out).toContain('<h2 id="cafe-au-lait">Café au lait</h2>');
        expect(out).toContain("<code>code</code>");
        expect(out).toContain('<a href="https://example.com">link</a>');
        expect(out).toContain("1:1.");
    });

    it("numbers headings with no ASCII slug as section-N (deduped like other slugs)", () => {
        const out = html("## 概要\n\n## Overview\n\n## 背景\n\n## Section 1");
        expect(out).toContain('<h2 id="section-1">概要</h2>');
        expect(out).toContain('<h2 id="overview">Overview</h2>');
        expect(out).toContain('<h2 id="section-2">背景</h2>');
        expect(out).toContain('<h2 id="section-1-1">Section 1</h2>');
    });

    it("adds copyable section URLs only when the viewer supplies the document URL", () => {
        const body = "## First\n\nText.\n\n## First";
        expect(html(body)).not.toContain("section-copy");
        const output = html(body, { ...CTX, sectionUrl: '/guide/api?lang=jpn&value="quoted"' });
        expect(output).toContain(
            'data-section-url="/guide/api?lang=jpn&amp;value=&quot;quoted&quot;#first"',
        );
        expect(output).toContain(
            'data-section-url="/guide/api?lang=jpn&amp;value=&quot;quoted&quot;#first-1"',
        );
        expect(output.match(/class="section-copy"/g)).toHaveLength(2);
    });

    it("resolves file links to the published route via routing", () => {
        expect(
            html("[For developers](content/dev.md)", {
                ...CTX,
                docLinks: new Map([["content/dev.md", "/dev"]]),
            }),
        ).toContain('<a href="/dev">For developers</a>');
    });

    it("renders nested lists as nested <ul>", () => {
        expect(html("- Parent\n  - Child")).toBe("<ul><li>Parent<ul><li>Child</li></ul></li></ul>");
    });

    it.each([
        ["```ts\nconst x = '<tag>';\n```", "ts"],
        ["```\nconst x = '<tag>';\n```", "text"],
        ["    const x = '<tag>';", "text"],
    ])("renders Markdown code with the shared border label (%s)", (source, lang) => {
        const out = html(source);
        expect(out).toContain(
            `<div class="codeblk" data-lang="${lang}"><span class="codeblk-head">`,
        );
        expect(out).toContain(`<span class="codeblk-lang">${lang}</span>`);
        expect(out).not.toContain("codeblk-filename");
        expect(out).toContain('class="codecopy"');
        expect(out).toContain('class="codefold" type="button" aria-expanded="true"');
        expect(out).toContain("<pre><code>const x = '&lt;tag&gt;';</code></pre>");
    });

    it("renders numbered lists (`1.` syntax) as <ol> (not <ul>)", () => {
        expect(html("1. One\n2. Two")).toBe("<ol><li>One</li><li>Two</li></ol>");
    });

    it("nested numbered lists pick <ol>/<ul> by each nested list's own syntax", () => {
        expect(html("1. Parent\n   1. Child")).toBe(
            "<ol><li>Parent<ol><li>Child</li></ol></li></ol>",
        );
        expect(html("- Parent\n  1. Child")).toBe(
            "<ul><li>Parent<ol><li>Child</li></ol></li></ul>",
        );
    });

    it("callout renders title + list; a figure with no file becomes a placeholder", () => {
        const out = html("~~~callouth Key points\n- Item\n~~~\n\n![](figures/unknown_fig.svg)");
        expect(out).toContain('<aside class="callout"><div class="cap">Key points</div><ul>');
        expect(out).toContain("Fig. unknown_fig");
        expect(out).toContain("not found in figures/");
    });

    it("renders numbered lists inside a callout as <ol> too", () => {
        const out = html("~~~callouth Steps\n1. One\n2. Two\n~~~");
        expect(out).toBe(
            '<aside class="callout"><div class="cap">Steps</div><ol><li>One</li><li>Two</li></ol></aside>',
        );
    });

    it("callout renders a mix of paragraphs / bullets in order", () => {
        const out = html("~~~callouth Terms\nAn explanatory paragraph.\n\n- Note 1\n- Note 2\n~~~");
        expect(out).toBe(
            '<aside class="callout"><div class="cap">Terms</div><p>An explanatory paragraph.</p><ul><li>Note 1</li><li>Note 2</li></ul></aside>',
        );
    });

    it("figure is isolated in a sandboxed iframe; caption = label + newline + desc", () => {
        const out = html("![](figures/data_model.svg)", CTX);
        // svg gets everything forbidden, scripts included (sandbox=""); markup goes into srcdoc
        // escaped
        expect(out).toContain(
            '<figure class="fig"><iframe class="fig-frame" data-doc-figure-frame="svg" sandbox=""',
        );
        expect(out).toContain(
            'srcdoc="&lt;!doctype html&gt;&lt;html data-doc-theme=&quot;auto&quot;&gt;',
        );
        expect(out).not.toContain("<svg xmlns=");
        expect(out).toContain(
            '<figcaption class="cap">Fig.data_model\nDescription text</figcaption>',
        );
        // [caption], if given, takes precedence over the figure's title
        expect(html("![Data model](figures/data_model.svg)", CTX)).toContain(
            '<figcaption class="cap">Data model\nDescription text</figcaption>',
        );
    });

    it("table block renders as <details> when collapsible, with a caption", () => {
        const t: Block = { type: "table", headers: ["a"], rows: [["1"]] };
        expect(blocksHtml([{ ...t, caption: "Table.x", collapsible: true }])).toContain(
            "<details><summary>Table.x</summary><table>",
        );
        expect(blocksHtml([{ ...t, caption: "Table.y" }])).toContain(
            '<div class="cap">Table.y</div>',
        );
    });

    it("~~~schemath draws the table DSL as a self-contained SVG (ER diagram)", () => {
        const dsl = [
            "/* source-only description */",
            "### catalog",
            "categories:",
            "  id: pk // source-only primary key comment",
            "  Category description",
            "",
            "### records",
            "items:",
            "  id: pk",
            "  categories: fk(categories)",
            "  deps: fk[](categories)",
        ].join("\n");
        const out = html(`~~~schemath sample schema\n${dsl}\n~~~`);
        expect(out).toContain('<figure class="fig"><svg xmlns=');
        expect(out).toContain('<figcaption class="cap">sample schema</figcaption>');
        // boxes (table name / field / type / note) and group frame labels
        expect(out).toContain(">categories<");
        expect(out).toContain(">items<");
        expect(out).toContain(">Category description<");
        expect(out).not.toContain(">source-only description<");
        expect(out).not.toContain(">source-only primary key comment<");
        expect(out).toContain('class="sg-glabel"');
        // 2 edges (one is fk[] = dashed); linked hover is done entirely with CSS :has()
        expect(out.match(/class="sg-e /g)).toHaveLength(2);
        expect(out).toContain("sg-list");
        expect(out).toContain(":has(.sg-h1:hover)");
        expect(out).not.toContain("<script");
        // classes / marker ids are namespaced by the model hash (multiple graphs on one page don't
        // collide)
        const uid = /class="(sg-[a-z0-9]+)"/.exec(out)?.[1];
        expect(uid).toBeDefined();
        expect(out).toContain(`url(#${uid}-arw)`);
        // colors always go through CSS variables (follow the theme)
        expect(out).toContain("var(--doc-panel, #ffffff)");
        // scaffolding for the interaction layer (zoom / drag): the pan/zoom target g, box and edge
        // keys, embedded data
        expect(out).toContain('<g class="sg-view">');
        expect(out).toContain('data-sg-t="1"');
        expect(out).toContain('data-sg-e="0"');
        const data = /data-sg-layout="([^"]*)"/.exec(out)?.[1];
        expect(data).toBeDefined();
        const parsed = JSON.parse(
            (data ?? "").replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
        ) as SchemaGraphClientData;
        expect(parsed.nodes.map((n) => n.name)).toEqual(["categories", "items"]);
        expect(parsed.edges).toHaveLength(2);
        // rows carry display text + a dy for handles (note rows have no fieldIndex = no handle)
        expect(parsed.nodes[1]?.rows.filter((r) => r.fieldIndex != null)).toHaveLength(3);
        expect(parsed.nodes[0]?.rows.filter((r) => r.fieldIndex == null)).toHaveLength(1);
        expect(parsed.groups.map((g) => g.label)).toEqual(["catalog", "records"]);
        // the DSL text as written is carried verbatim too (the interactive UI's source viewer shows
        // the "raw table"). It's the original text, not a reconstruction from the model, so blank
        // lines and note order are preserved character for character.
        expect(parsed.source).toBe(dsl);
        // a schema without tables degrades to a placeholder
        expect(html("~~~schemath\n~~~")).toContain('<div class="ph">schema graph');
        // same result with the content indented by 2 spaces (the common indent is stripped)
        const indented = html("~~~schemath c\n  ### g\n  a:\n    id: pk\n    b: fk(a)\n~~~");
        expect(indented).toContain(">a<");
        expect(indented).toContain('class="sg-e ');
    });

    it("~~~graph draws the node / edge DSL as a self-contained SVG (relationship diagram)", () => {
        const dsl = [
            "[input]: Input @Ingest",
            "[pre-process]: Preprocessor @Ingest",
            "[worker]: Worker @Processing",
            "[validator]: Validator",
            "",
            "[input] -> [pre-process] -> [worker]",
            "[worker] --> [validator]: input validation",
        ].join("\n");
        const out = html(`~~~grapth Output processing flow\n${dsl}\n~~~`);
        expect(out).toContain('<figure class="fig"><svg xmlns=');
        expect(out).toContain('<figcaption class="cap">Output processing flow</figcaption>');
        // node labels and region frame labels
        expect(out).toContain(">Input<");
        expect(out).toContain(">Ingest<");
        expect(out).toContain('class="gr-glabel"');
        // 3 edges (one dashed + label); no undirected ones, so all have arrows
        expect(out.match(/class="gr-e /g)).toHaveLength(3);
        expect(out).toContain("gr-dashed");
        expect(out).toContain(">input validation<");
        // linked hover is done entirely with CSS :has() (no script)
        expect(out).toContain(":has(.gr-h1:hover)");
        expect(out).not.toContain("<script");
        // classes / marker ids are namespaced by the model hash (multiple graphs on one page don't
        // collide)
        const uid = /class="(gr-[a-z0-9]+)"/.exec(out)?.[1];
        expect(uid).toBeDefined();
        expect(out).toContain(`url(#${uid}-arw)`);
        // colors always go through CSS variables (follow the theme)
        expect(out).toContain("var(--doc-panel, #ffffff)");
        // a graph without nodes degrades to a placeholder
        expect(html("~~~grapth\n~~~")).toContain('<div class="ph">graph');
        // same result with the content indented by 2 spaces (the common indent is stripped)
        expect(html("~~~grapth\n  [a]: A\n  [b]: B\n  [a] -- [b]\n~~~")).toContain('class="gr-e ');
    });

    it("~~~graph draws no arrowhead on undirected edges", () => {
        const out = html("~~~grapth\n[a]: A\n[b]: B\n[a] -- [b]\n~~~");
        expect(out).toContain('class="gr-e ');
        expect(out).not.toContain("marker-end");
    });

    it("composite pk (`pk(...)`) adds `pk` to the participating columns' type labels", () => {
        const dsl = [
            "item_tag_map:",
            "  item_id: fk(items)",
            "  tag_id: fk(tags)",
            "  pk(item_id, tag_id)",
            "items:",
            "  id: pk",
            "tags:",
            "  id: pk",
        ].join("\n");
        const out = html(`~~~schemath\n${dsl}\n~~~`);
        expect(out.match(/>pk fk</g)).toHaveLength(2);
        // the fk-derived class (sg-ref) is still applied (by design, the kind itself is unchanged).
        expect(out).toContain('class="sg-ftype sg-ref"');
        expect(out).toMatch(/class="sg-ftype sg-ref"[^<]*>pk fk</);
    });

    it("unique(...) adds `uq` to the participating columns' type labels (outer form, written alongside the table declaration)", () => {
        const dsl = [
            "categories:",
            "  id: pk",
            "  display_name: string",
            "unique(categories.display_name)",
        ].join("\n");
        const out = html(`~~~schemath\n${dsl}\n~~~`);
        expect(out).toContain(">uq string<");
    });

    it("enum(...) stays scalar and renders the values joined with | as its label", () => {
        const out = html('~~~schemath\na:\n  kind: enum("plain"|"draft"|"final")\n~~~');
        // kind isn't treated as fk (no sg-ref class) = stays scalar.
        expect(out).toContain(">kind<");
        expect(out).toContain(">&quot;plain&quot;|&quot;draft&quot;|&quot;final&quot;<");
        expect(out).not.toContain('sg-ftype sg-ref">&quot;plain');
    });

    it("unknown blocks degrade to a placeholder", () => {
        // block outside the type — no
        // "undefined" leaks into the output.
        const unknown = blocksHtml([{ type: "future-thing" } as never]);
        expect(unknown).toContain("Unknown block (future-thing)");
        expect(unknown).not.toContain("undefined");
    });
});

describe("inline references (figures / dictionary)", () => {
    it("ordinary SVG links open a file page and preview in a sandboxed iframe", () => {
        const out = html("See [Data model](./figures/data_model.svg).", CTX);
        expect(out).toContain(
            '<a class="figref" href="/_files/file/figures%2Fdata_model.svg">Data model',
        );
        expect(out).toContain('<span class="figpop"><iframe class="fig-frame figpop-frame"');
        expect(out).toContain('sandbox=""');
        expect(html("Fig.data_model / Fig. data_model / `Fig.data_model`", CTX)).not.toContain(
            "figref",
        );
        for (const url of [
            "https://example.com/data_model.svg",
            "other/data_model.svg",
            "figures/missing.svg",
        ])
            expect(html(`[Model](${url})`, CTX)).toBe(`<p><a href="${url}">Model</a></p>`);
    });

    it("matches encoded file paths and reserves hover previews for SVG", () => {
        for (const kind of ["svg", "html", "image"] as const) {
            const file = `files/My (model).${kind === "image" ? "png" : kind}`;
            const fig = { ...MODEL_FIG, file, kind };
            const out = html(`[Model](<${file}>)`, { ...CTX, figures: new Map([[fig.name, fig]]) });
            expect(out).toContain(`href="/_files/file/${encodeURIComponent(file)}"`);
            expect(out.includes('class="figpop"')).toBe(kind === "svg");
        }
    });

    it("links only explicit term file links, including when the same name is plain text", () => {
        const out = html("SLA and [](sla.termth).", {
            ...CTX,
            termLinks: new Map([["sla.termth", "/terms#term-sla"]]),
        });
        expect(out).toContain('SLA and <a class="dictref" href="/terms#term-sla">SLA');
        expect(out).toContain("Service Level Agreement");
        expect(html("SLA api api-v2", CTX)).not.toContain("dictref");
        expect(html("`[](sla.termth)`", CTX)).not.toContain("dictref");
    });

    it("term lists sort by name and escape optional descriptions and definitions", () => {
        const out = termsHtml(
            [
                { id: "z", name: "z", definition: "last" },
                { id: "a", name: "a", description: "<script>", definition: "<b>first</b>" },
            ],
            undefined,
            true,
        );
        expect(out.indexOf('data-term="a"')).toBeLessThan(out.indexOf('data-term="z"'));
        expect(out).toContain("data-dict-sort");
        expect(out).toContain('data-source-order="0" data-sort-order="1" data-term="z"');
        expect(out).toContain("&lt;script&gt;");
        expect(out).toContain("&lt;b&gt;first&lt;/b&gt;");
        expect(out).toContain('aria-describedby="term-description-a"');
        expect(out).toContain(
            'class="term-description" role="tooltip" id="term-description-a">&lt;script&gt;</span>',
        );
        expect(out).toContain('<p class="term-definition">&lt;b&gt;first&lt;/b&gt;</p>');
        expect(out).not.toContain("term-description-z");
        expect(out).not.toContain("<code>");
    });

    it("term definitions render stable anchors without list sorting controls", () => {
        const entry = { id: "api", name: "API", definition: "Interface" };
        const out = blocksHtml([{ type: "term", entry }], CTX);
        expect(out).toContain('<fieldset class="dict-card"');
        expect(out).toContain('<legend id="term-api">');
        expect(out).toContain('class="term-icon"');
        expect(out).toContain('href="/_files/terms#term-api">API</a>');
        expect(out).toContain("Interface");
        expect(out).not.toContain("data-dict-sort");
    });
});
