import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { compileDraft, compileSite, createCompiler } from "../../engine/src/compiler/compile.js";
import { exportEntries } from "../../engine/src/compiler/export.js";
import { rewriteFileLinks } from "../../engine/src/compiler/files.js";
import { walkBlocks } from "../../engine/src/core/blocks.js";
import { parseFileEmbed } from "../../engine/src/core/file-embed.js";
import { blocksHtml } from "../../engine/src/core/html.js";
import { parseMdast } from "../../engine/src/core/markdown.js";
import { subformatReferences } from "../../engine/src/core/subformat-references.js";
import { buildBundle } from "./build.js";
import { bundleClient } from "./serve.js";

vi.mock("./serve.js", async (original) => ({
    ...(await original<typeof import("./serve.js")>()),
    bundleClient: vi.fn().mockResolvedValue("/* subformat embed runtime */"),
}));

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.mocked(bundleClient).mockClear();
});

const fixture = (body: string, format = "json") => {
    const root = mkdtempSync(join(tmpdir(), "dooc-subformat-embed-"));
    roots.push(root);
    mkdirSync(join(root, "content"));
    const write = (file: string, content: string) => writeFileSync(join(root, file), content);
    write(
        "dooc.yaml",
        JSON.stringify({
            docs: ["guide"],
            subformats: [
                {
                    ext: "issue",
                    format,
                    schema: "issue.schema.json",
                    layouts: { view: "list", card_title: "title", group_by: "status" },
                },
            ],
        }),
    );
    write(
        "issue.schema.json",
        JSON.stringify({
            type: "object",
            properties: {
                title: { type: "string", title: "Subject" },
                status: { enum: ["Todo", "Done"] },
                ready: { type: "boolean" },
                points: { type: "number" },
                metadata: { type: "object" },
            },
            required: ["title", "status"],
        }),
    );
    const content =
        format === "yaml"
            ? "title: First\nstatus: Todo\n"
            : format === "toml"
              ? 'title = "First"\nstatus = "Todo"\n'
              : JSON.stringify({
                    title: "First",
                    status: "Todo",
                    ready: false,
                    points: 0,
                    metadata: { owner: "Example" },
                });
    write("first.issue", content);
    write("content/guide.md", body);
    return { root, write, content };
};

it.each([
    "json",
    "yaml",
    "toml",
])("embeds %s records as cards, preserving source fences and ranges", (format) => {
    const { root, content } = fixture(
        "![](first.issue)\n\n![](first.issue#L1)\n\n``` .issue\n" +
            (format === "json"
                ? '{"title":"Inline","status":"Todo"}'
                : format === "yaml"
                  ? "title: Inline\nstatus: Todo"
                  : 'title = "Inline"\nstatus = "Todo"') +
            "\n```\n",
        format,
    );
    const compiled = compileSite(root);
    expect(compiled.errors).toEqual([]);
    const blocks = compiled.docs[0]?.blocks ?? [];
    expect(blocks[0]).toMatchObject({
        type: "code",
        embed: { view: "card" },
        subformat: {
            format,
            records: [{ file: "first.issue", content, data: { title: "First" } }],
        },
    });
    expect(blocks[1]).not.toHaveProperty("subformat");
    expect(blocks[2]).not.toHaveProperty("subformat");
    expect(blocksHtml(blocks)).toContain('data-subformat-embed="issue"');
});

it("embeds schema records as a table and applies decoded titles, modes and exact filters", () => {
    const body =
        "![](issue.schema.json?view=list&title=%3Cscript%3E%26%20Issues&filter.status=Todo&filter.ready=false&filter.points=0)\n\n![](issue.schema.json)\n\n![](issue.schema.json?filter.status=Missing)\n";
    const { root, write } = fixture(body);
    write("second.issue", '{"title":"Second","status":"Done","ready":true,"points":1}');
    const compiled = compileSite(root);
    expect(compiled.errors).toEqual([]);
    const blocks = compiled.docs[0]?.blocks ?? [];
    expect(blocks[0]).toMatchObject({
        embed: { view: "list", title: "<script>& Issues" },
        subformat: { records: [{ file: "first.issue" }] },
    });
    expect(blocks[1]).toMatchObject({
        embed: { view: "table" },
        subformat: { records: [{ file: "first.issue" }, { file: "second.issue" }] },
    });
    expect(blocks[2]).toMatchObject({ subformat: { records: [] } });
    const html = blocksHtml(blocks);
    expect(html).toContain("&lt;script&gt;&amp; Issues</h2>");
    expect(html).not.toContain("<script>");
    expect(html).toContain('<th scope="col">Subject</th>');
    expect(html).toContain('data-i18n="No results"');
    expect(compiled.sources.get("content/guide.md")?.referencedFiles).toEqual([
        "issue.schema.json",
        "first.issue",
        "second.issue",
    ]);
});

it("refreshes cached schema embeds and previews unsaved records without writing them", () => {
    const { root, write, content } = fixture("![](issue.schema.json?filter.status=Todo)\n");
    const compiler = createCompiler(root);
    compiler.compile();
    write("second.issue", '{"title":"Second","status":"Todo"}');
    expect(compiler.compile().docs[0]?.blocks[0]).toMatchObject({
        subformat: { records: [{ file: "first.issue" }, { file: "second.issue" }] },
    });
    const draft = compileDraft(
        {
            root,
            docs: [],
            figures: new Map(),
            textfiles: new Map([["first.issue", '{"title":"Draft","status":"Done"}']]),
        },
        "content/guide.md",
        "![](issue.schema.json?filter.status=Todo)\n",
    );
    expect(draft.source.errors).toEqual([]);
    expect(draft.doc.blocks[0]).toMatchObject({
        subformat: { records: [{ file: "second.issue" }] },
    });
    expect(readFileSync(join(root, "first.issue"), "utf8")).toBe(content);
    write(
        "issue.schema.json",
        '{"type":"object","properties":{"title":{"type":"string","title":"Updated"},"status":{"type":"string"}}}',
    );
    expect(compiler.compile().docs[0]?.blocks[0]).toMatchObject({
        subformat: { fields: [{ title: "Updated" }, { title: "status" }] },
    });
});

it("applies rich query filters and sorting before publication while retaining complete record details", () => {
    const { root, write } = fixture(
        "![](issue.schema.json?view=list&fields=status,points&card_title=title&group_by=status&sort_by=points&sort_order=desc&filter.status[in]=Todo,Done&filter.points[gte]=0&filter.points[lt]=10&q=first)\n",
    );
    write("second.issue", '{"title":"First follow-up","status":"Done","points":3}');
    write("excluded.issue", '{"title":"First excluded","status":"Todo","points":20}');
    const compiled = compileSite(root);
    expect(compiled.errors).toEqual([]);
    const blocks = compiled.docs[0]?.blocks ?? [];
    expect(blocks[0]).toMatchObject({
        embed: {
            view: "list",
            fields: ["status", "points"],
            card_title: "title",
            group_by: "status",
            sort_by: "points",
            sort_order: "desc",
        },
        subformat: {
            records: [
                { file: "second.issue" },
                { file: "first.issue", data: { metadata: { owner: "Example" } } },
            ],
        },
    });
    const html = blocksHtml(blocks);
    expect(html).toContain("data-subformat-embed-options=");
    expect(html).toContain("data-resource-search");
    expect(html).toContain('<th scope="col">status</th><th scope="col">points</th>');
    expect(html).not.toContain('<th scope="col">Subject</th>');
    expect(html).not.toContain("First excluded");
    expect(compiled.sources.get("content/guide.md")?.referencedFiles).toContain("excluded.issue");
});

it.each([
    "fields=missing",
    "group_by=title",
    "sort_by=metadata",
    "filter.points[gte]=invalid",
    "filter.title[gt]=3",
])("reports invalid view parameters: %s", (query) => {
    const { root } = fixture(`![](issue.schema.json?${query})\n`);
    expect(compileSite(root).errors).not.toEqual([]);
});

it("keeps invalid records out of tables, retains invalid source, and rejects unknown filters", () => {
    const { root, write } = fixture("![](issue.schema.json)\n\n![](bad.issue)\n");
    write("bad.issue", '{"status":"Unknown"}');
    write(".gitignore", "private.issue\n");
    write("private.issue", '{"title":"Private","status":"Todo"}');
    const compiled = compileSite(root);
    expect(compiled.errors.join()).toContain("bad.issue");
    expect(compiled.docs[0]?.blocks[0]).toMatchObject({
        subformat: { records: [{ file: "first.issue" }] },
    });
    expect(compiled.docs[0]?.blocks[1]).toMatchObject({ lines: ['{"status":"Unknown"}'] });
    expect(compiled.docs[0]?.blocks[1]).not.toHaveProperty("subformat");
    write("content/guide.md", "![](issue.schema.json?filter.unknown=Todo)\n");
    expect(compileSite(root).errors.join()).toContain("Unknown subformat filter field: unknown");
    write("plain.json", "{}");
    write("content/guide.md", "![](plain.json?view=table)\n");
    expect(compileSite(root).errors.join()).toContain("require a registered subformat");
});

it("validates embed parameters and preserves queries when counting, moving and exporting files", () => {
    for (const url of [
        "?view=table",
        "first.issue?view=grid",
        "first.issue?title=A&title=B",
        "first.issue?other=x",
        "first.issue?filter.=x",
        "first.issue?view=card#L1",
    ])
        expect(() => parseFileEmbed(url)).toThrow();
    expect(parseFileEmbed("a%3Fb.issue?title=A%26B")).toMatchObject({
        file: "a?b.issue",
        embed: { title: "A&B" },
    });
    const body =
        "![](first.issue?view=card&title=First)\n\n![](issue.schema.json?filter.status=Todo)\n";
    expect(subformatReferences(parseMdast(body))).toContainEqual({ file: "first.issue", line: 1 });
    expect(rewriteFileLinks(body, new Map([["first.issue", "moved.issue"]]))).toContain(
        "moved.issue?view=card&title=First",
    );
    const { root } = fixture(body);
    expect(exportEntries(root).map((entry) => entry.name)).toContain("first.issue");
});

it("publishes the subformat runtime for embeds without a dedicated subformat page", async () => {
    const { root } = fixture("> ![](issue.schema.json?title=Issues)\n\n![](first.issue)\n");
    expect(
        walkBlocks(compileSite(root).docs[0]?.blocks ?? []).some(
            (block) => block.type === "code" && block.subformat,
        ),
    ).toBe(true);
    const bundle = await buildBundle(root, { format: "html", urlPreview: "network" });
    expect(bundleClient).toHaveBeenCalledWith("published-subformats.ts");
    expect(bundle.data).toContain("/* subformat embed runtime */");
    expect(bundle.data).toContain('data-subformat-embed-view="table"');
});
