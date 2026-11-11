import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resourceIndex, resourceLibraryHtml, resourceTabs } from "./resource-library.js";

const roots: string[] = [];
const fixture = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), "dooc-resource-library-"));
    roots.push(root);
    for (const [file, content] of Object.entries(files)) {
        mkdirSync(join(root, file, ".."), { recursive: true });
        writeFileSync(join(root, file), content);
    }
    return { root, files: Object.keys(files) };
};
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("counts authored links and embeds while keeping unreferenced records available", () => {
    const { root, files } = fixture({
        "dooc.yaml":
            "docs: []\ndefault_subformat_folder: records\nsubformats: [{ext: issue, format: json, schema: issue.schema.json}]\n",
        "issue.schema.json": '{"type":"object"}',
        "records/a.issue": '{"title":"Used"}',
        "records/unused.issue": '{"title":"Unused"}',
        "doc.md":
            "[Link](records/a.issue)\n![Embed](./records/a.issue#L1)\n[Named][record]\n![Named][record]\n\n[record]: records/%61.issue\n[unused]: records/a.issue\n\n```text\n![Example](records/a.issue)\n```\n\n```callouth\n[Callout](records/a.issue)\n```\n",
        "other.md": "`[inline](records/a.issue)`\n[Remote](https://example.com/records/a.issue)\n",
    });
    const index = resourceIndex(root, files);
    expect(index.errors).toEqual([]);
    expect(index.subformats[0]?.defaultFolder).toBe("records");
    expect(index.subformats[0]?.records.map(({ file, references }) => [file, references])).toEqual([
        ["records/a.issue", [1, 2, 3, 4, 14].map((line) => ({ file: "doc.md", line }))],
        ["records/unused.issue", []],
    ]);
});

it("unifies standalone terms and Markdown code blocks with exact source lines", () => {
    const source = [
        "---",
        "title: Example",
        "---",
        "",
        "```TS example",
        "const x = 1;",
        "",
        "x;",
        "```",
        "",
        "> ```python",
        "> print(1)",
        "> ```",
        "",
        "```termth",
        "name: Inline",
        "definition: Inside Markdown",
        "```",
    ].join("\n");
    const { root, files } = fixture({
        "unregistered.md": source,
        "terms/unused.termth":
            "name: Standalone\ndefinition: Not embedded anywhere\ndescription: More detail\n",
        "terms/broken.termth": "name: Broken\n",
        "missing.md": "Placeholder",
    });
    rmSync(join(root, "missing.md"));
    const index = resourceIndex(root, [...files, "unregistered.md"]);
    expect(
        index.codeblocks.map(({ language, content, source }) => [language, content, source.line]),
    ).toEqual([
        ["ts", "const x = 1;\n\nx;", 5],
        ["python", "print(1)", 11],
        ["termth", "name: Inline\ndefinition: Inside Markdown", 15],
        [
            "termth",
            "name: Standalone\ndefinition: Not embedded anywhere\ndescription: More detail\n",
            1,
        ],
        ["termth", "name: Broken\n", 1],
    ]);
    expect(index.codeblocks[3]?.source.file).toBe("terms/unused.termth");
    expect(index).not.toHaveProperty("terms");
    expect(index.errors).toHaveLength(2);
    expect(index.errors[0]).toContain("definition must be a non-empty string");
    expect(index.errors[1]).toContain("missing.md");
});

it("separates and deduplicates links and previews by Markdown syntax, including references and callouts", () => {
    const { root, files } = fixture({
        "links.md": [
            "[One](https://example.com/a)",
            "![Image](https://example.com/a)",
            "[ref][used]",
            "",
            "[used]: https://example.com/a",
            "[unused]: https://unused.example/",
            "",
            "```js",
            'const url = "https://code.example/";',
            "```",
            "",
            "```callouth",
            "[Callout](https://callout.example/)",
            "```",
            "",
            "<https://auto.example/>",
            "[Local](file.md)",
            "[Unsafe](javascript:alert)",
            "",
            "![ref][used]",
            "![Preview](https://preview.example/)",
            "![Local](file.md)",
            "![Unsafe](javascript:alert)",
            "[Mail](mailto:reader@example.com)",
            "",
            "```callouth",
            "![Nested preview](https://preview.example/)",
            "```",
        ].join("\n"),
    });
    const index = resourceIndex(root, files);
    expect(index.urls.map(({ url }) => url)).toEqual([
        "https://auto.example/",
        "https://callout.example/",
        "https://example.com/a",
        "mailto:reader@example.com",
    ]);
    expect(index.urls[2]?.sources.map(({ line }) => line)).toEqual([1, 3]);
    expect(index.urls[1]?.sources).toEqual([{ file: "links.md", line: 13 }]);
    expect(index.urlPreviews).toEqual([
        {
            url: "https://example.com/a",
            host: "example.com",
            sources: [
                { file: "links.md", line: 2 },
                { file: "links.md", line: 20 },
            ],
        },
        {
            url: "https://preview.example/",
            host: "preview.example",
            sources: [
                { file: "links.md", line: 21 },
                { file: "links.md", line: 27 },
            ],
        },
    ]);
});

it("renders searchable resource views with escaped content and links to the source", () => {
    const { root, files } = fixture({
        "terms/a.termth": 'name: "<script>name</script>"\ndefinition: "<img onerror=bad>"',
        "code & notes.md":
            "```html caption\n<script>bad()</script>\n```\n[Link](https://example.com/)\n\n![Preview](https://preview.example/)",
    });
    const index = resourceIndex(root, files);
    const code = resourceLibraryHtml(index, "codeblocks");
    expect(code).toContain("&lt;script&gt;name&lt;/script&gt;");
    expect(code).not.toContain("<script>");
    expect(code).toContain('data-resource-group="html"');
    expect(code).toContain('data-resource-source="code &amp; notes.md" data-resource-line="1"');
    expect(code).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    expect(resourceLibraryHtml(index, "urls")).toContain('rel="noopener noreferrer"');
    expect(resourceLibraryHtml(index, "urls")).not.toContain("https://preview.example/");
    const previews = resourceLibraryHtml(index, "url-previews");
    expect(previews).toContain('data-resource-group="preview.example"');
    expect(previews).toContain("https://preview.example/");
    expect(previews).not.toContain("https://example.com/");
    for (const view of ["codeblocks", "urls", "url-previews"] as const) {
        const html = resourceLibraryHtml(index, view);
        expect(html).toContain('<details class="resource-item');
        expect(html).not.toMatch(/<details[^>]*\bopen\b/);
        expect(html).not.toContain("resource-intro");
        expect(html).toContain('class="resource-search"');
        expect(resourceTabs(view)).toContain(`href="/_statics/${view}" aria-current="page"`);
    }
    expect(resourceTabs("codeblocks")).not.toContain("Dictionary");
    expect(resourceTabs("codeblocks")).not.toContain('href="/_files"');
    expect(resourceTabs("files")).toBe("");
    expect(resourceIndex(root, ["../outside.md"]).errors[0]).toContain("relative file path");
});

it("renders a useful empty state", () => {
    const { root } = fixture({});
    for (const view of ["codeblocks", "urls", "url-previews"] as const)
        expect(resourceLibraryHtml(resourceIndex(root, []), view)).toContain(
            'data-resource-empty data-i18n="No matching resources"',
        );
});

it("renders subformat controls without a resource search box", () => {
    const { root } = fixture({});
    const index = resourceIndex(root, []);
    index.subformats = ["zeta", "alpha"].map((ext) => ({
        ext,
        format: "json",
        schema: "record.schema.json",
        fields: [],
        records: [],
    }));
    const html = resourceLibraryHtml(index, "subformats");
    expect(html).toContain('class="resource-query"><div class="subformat-picker"');
    expect(html).not.toContain("data-resource-search");
    expect(resourceLibraryHtml(index, "subformats", "Issues")).not.toContain(
        "data-resource-search",
    );
    expect(html).toContain('data-subformat-options popover="auto"');
    expect(html).toContain(
        '<select data-resource-filter data-subformat-filter hidden aria-label="Subformats"',
    );
    expect(html.indexOf('<option value="zeta">')).toBeLessThan(
        html.indexOf('<option value="alpha">'),
    );
    expect(html).not.toContain('data-i18n="All"');
    expect(html).not.toContain('data-i18n="Name"');
    expect(html).not.toContain('role="tab');
    expect(html).not.toContain("subformat-tabs");
    expect(html).not.toContain("data-resource-count");
    expect(html).toContain('data-subformat-board role="region"');
    expect(resourceLibraryHtml(resourceIndex(root, []), "subformats")).toContain(
        "No subformats configured.",
    );
});

it("indexes local text embeds with ranges and groups file extensions with fence aliases", () => {
    const { root, files } = fixture({
        "refs.md": [
            "```typescript",
            "const inline = 1;",
            "```",
            "",
            "![App](./src/app%20code.TS#L2-L3)",
            "",
            "![Reference][app]",
            "",
            "[app]: src/app%20code.TS",
            "",
            "![Table](data.csv#H)",
            "",
            "![Image](image.png)",
            "[Link](src/app%20code.TS)",
            "",
            "```callouth",
            "![Nested](data.csv)",
            "```",
        ].join("\n"),
        "src/app code.TS": "first\r\nconst second = 2;\r\nconst third = 3;\r\n",
        "data.csv": "Name,Value\nA,1\n",
        "image.png": "not read as text",
    });
    const index = resourceIndex(root, files);
    expect(index.errors).toEqual([]);
    expect(index.codeblocks.filter((item) => item.format === "typescript")).toHaveLength(3);
    expect(index.codeblocks[1]).toMatchObject({
        format: "typescript",
        content: "const second = 2;\r\nconst third = 3;",
        source: { file: "refs.md", line: 5 },
        reference: { file: "src/app code.TS", line: 2, range: "#L2-L3" },
    });
    expect(index.codeblocks.filter((item) => item.format === "csv")).toHaveLength(2);
    expect(index.codeblocks.at(-1)?.source).toEqual({ file: "refs.md", line: 17 });
    const html = resourceLibraryHtml(index, "codeblocks");
    expect(html).toContain('aria-label="Format"');
    expect(html).toContain('data-resource-source="src/app code.TS" data-resource-line="2"');
    expect(html).toContain('data-resource-group="typescript"');
});

it("reports missing, private and invalid range references without hiding later blocks", () => {
    const { root, files } = fixture({
        "refs.md":
            "![](missing.ts)\n\n![](../outside.ts)\n\n![](.private.ts)\n\n![](code.ts#L9)\n\n```txt\nStill visible\n```",
        "code.ts": "one line\n",
        ".private.ts": "private content",
    });
    const index = resourceIndex(
        root,
        files.filter((file) => file !== ".private.ts"),
    );
    expect(index.errors).toHaveLength(4);
    expect(index.codeblocks).toMatchObject([{ format: "text", content: "Still visible" }]);
    expect(JSON.stringify(index)).not.toContain("private content");
});
