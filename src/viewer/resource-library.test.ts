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

it("indexes standalone and inline terms plus nested code blocks with exact source lines", () => {
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
        index.code.map(({ language, content, source }) => [language, content, source.line]),
    ).toEqual([
        ["ts", "const x = 1;\n\nx;", 5],
        ["python", "print(1)", 11],
        ["termth", "name: Inline\ndefinition: Inside Markdown", 15],
    ]);
    expect(index.terms.map(({ entry, source }) => [entry.name, source])).toEqual([
        ["Inline", { file: "unregistered.md", line: 16 }],
        ["Standalone", { file: "terms/unused.termth", line: 1 }],
    ]);
    expect(index.errors).toHaveLength(2);
    expect(index.errors[0]).toContain("definition must be a non-empty string");
    expect(index.errors[1]).toContain("missing.md");
});

it("deduplicates used URLs, resolves reference links and includes embeds and callouts", () => {
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
        ].join("\n"),
    });
    const index = resourceIndex(root, files);
    expect(index.urls.map(({ url }) => url)).toEqual([
        "https://auto.example/",
        "https://callout.example/",
        "https://example.com/a",
    ]);
    expect(index.urls[2]?.sources.map(({ line }) => line)).toEqual([1, 2, 3]);
    expect(index.urls[1]?.sources).toEqual([{ file: "links.md", line: 13 }]);
});

it("renders searchable resource views with escaped content and links to the source", () => {
    const { root, files } = fixture({
        "terms/a.termth": 'name: "<script>name</script>"\ndefinition: "<img onerror=bad>"',
        "code & notes.md":
            "```html caption\n<script>bad()</script>\n```\n[Link](https://example.com/)",
    });
    const index = resourceIndex(root, files);
    const dictionary = resourceLibraryHtml(index, "dictionary");
    expect(dictionary).toContain("&lt;script&gt;name&lt;/script&gt;");
    expect(dictionary).not.toContain("<script>");
    const code = resourceLibraryHtml(index, "code");
    expect(code).toContain('data-resource-group="html"');
    expect(code).toContain('data-resource-source="code &amp; notes.md" data-resource-line="1"');
    expect(code).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    expect(resourceLibraryHtml(index, "urls")).toContain('rel="noopener noreferrer"');
    for (const view of ["dictionary", "code", "urls"] as const) {
        const html = resourceLibraryHtml(index, view);
        expect(html).toContain('<details class="resource-item');
        expect(html).not.toMatch(/<details[^>]*\bopen\b/);
        expect(html).not.toContain("resource-intro");
        expect(html).toContain('class="resource-search"');
    }
    expect(resourceTabs("code")).toContain('href="/_statics/code" aria-current="page"');
    expect(resourceTabs("code")).not.toContain('href="/_files"');
    expect(resourceTabs("files")).toBe("");
    expect(resourceIndex(root, ["../outside.md"]).errors[0]).toContain("relative file path");
});

it("renders a useful empty state", () => {
    const { root } = fixture({});
    expect(resourceLibraryHtml(resourceIndex(root, []), "urls")).toContain(
        'data-resource-empty data-i18n="No matching resources"',
    );
});
