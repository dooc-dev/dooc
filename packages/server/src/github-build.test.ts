import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { unzipSync } from "fflate";
import { type DefaultTreeAdapterTypes as Html, parseFragment } from "parse5";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchPublicFile } from "../../engine/src/compiler/public-file.js";
import { buildBundle } from "./build.js";

vi.mock("../../engine/src/compiler/public-file.js", () => ({ fetchPublicFile: vi.fn() }));
let root: string;
const write = (file: string, data: string | Buffer) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), data);
};
const unpack = (data: string | Buffer): Record<string, string> =>
    Object.fromEntries(
        Object.entries(unzipSync(Buffer.from(data))).map(([file, bytes]) => [
            file,
            Buffer.from(bytes).toString("utf8"),
        ]),
    );
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dooc-github-test-"));
    write("dooc.yaml", "title: Bundle\ndefaultLang: eng\ndocs: [guide, more]\n");
    write("content/more.md", "## Next\n\n[Home](content/guide.md#intro)\n");
    vi.mocked(fetchPublicFile).mockReset();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const assertLinks = (files: Record<string, string>) => {
    for (const [file, content] of Object.entries(files)) {
        if (!file.endsWith(".md") || file.startsWith("resources/")) continue;
        const walk = (node: Html.ParentNode) => {
            for (const child of node.childNodes) {
                if (!("tagName" in child)) continue;
                for (const attribute of child.attrs) {
                    if (
                        !["href", "src", "srcset"].includes(attribute.name) ||
                        /^(https?:|mailto:|#)/.test(attribute.value)
                    )
                        continue;
                    const path = decodeURIComponent(attribute.value.split("#")[0] ?? "");
                    expect(files, `${file}: ${attribute.value}`).toHaveProperty(
                        posix.normalize(posix.join(posix.dirname(file), path)),
                    );
                }
                walk(child);
            }
        };
        walk(parseFragment(content));
    }
};

it("exports resolved content and valid relative links in a self-contained ZIP", async () => {
    write("README.md", "Existing README\n");
    write("files/code.ts", "// Before\nconst answer = 42;\n// After\n");
    write("files/data.csv", "name,value\nExample,42\n");
    write("files/term.termth", "name: Bundle\ndefinition: A collection of documents.\n");
    write("files/graph.graphth", "[a]: Source\n[b]: Output\n[a] -> [b]\n");
    write("files/schema.schemath", "users:\n  id: pk\nposts:\n  id: pk\n  author: fk(users)\n");
    write(
        "figures/chart.svg",
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Chart</title><image href="../files/pixel.png" width="10" height="10"/></svg>',
    );
    write(
        "files/pixel.png",
        Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aXcAAAAASUVORK5CYII=",
            "base64",
        ),
    );
    write(
        "themes/dark/figures/chart.svg",
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Dark</title><rect width="10" height="10" fill="black"/></svg>',
    );
    write("unrelated.txt", "PRIVATE-CONTENT");
    write(
        "content/guide.md",
        [
            "## Intro",
            "[Next](content/more.md#next)",
            "[Bundle](files/term.termth)",
            "![Excerpt](files/code.ts#L2)",
            "![](files/data.csv#H)",
            "![Flow](files/graph.graphth)",
            "![Schema](files/schema.schemath)",
            "![Chart](figures/chart.svg)",
            "![Pixel](files/pixel.png)",
        ].join("\n\n"),
    );
    const result = await buildBundle(root, { format: "github" });
    const files = unpack(result.data);
    expect(result.warnings).toEqual([]);
    expect(files["README.md"]).toContain('href="pages/content/more.md#next"');
    expect(files["pages/content/more.md"]).toContain('href="../../README.md#intro"');
    expect(files["README.md"]).toContain('name="intro"');
    expect(files["README.md"]).toContain("```ts\nconst answer = 42;\n```");
    expect(files["README.md"]).toContain('<source media="(prefers-color-scheme: dark)"');
    expect(files["README.md"]).toContain('href="terms.md#term-files%2Fterm.termth"');
    expect(files["terms.md"]).toContain("A collection of documents.");
    expect(files["resources/files/code.ts"]).toContain("// Before");
    const svg = Object.entries(files)
        .filter(([file]) => file.startsWith("assets/") && file.endsWith(".svg"))
        .map(([, data]) => data);
    expect(svg).toHaveLength(4);
    expect(svg.some((data) => data.includes("data:image/png;base64,"))).toBe(true);
    expect(svg.join("\n")).not.toContain("data-sg-layout");
    expect(svg.every((data) => data.includes("prefers-color-scheme: dark"))).toBe(true);
    expect(svg.join("\n")).not.toMatch(/<style data-doc-figure-theme>/);
    expect(files["README.md"]).not.toMatch(/<svg|<iframe|<script|data:image|```mermaid/);
    expect(files["README.md"]).toMatch(/alt="Flow" width="\d+"/);
    expect(JSON.stringify(files)).not.toContain("PRIVATE-CONTENT");
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("Existing README\n");
    expect(fetchPublicFile).not.toHaveBeenCalled();
    assertLinks(files);
});

it("keeps encoded filenames and inline diagram source positions intact", async () => {
    write("files/100% complete.ts", "const special = 1;\n");
    write(
        "content/guide.md",
        "## Intro\n\n![Source](files/100%25%20complete.ts)\n\n```graphth\n[a]: Start\n[b]: End\n[a] -> [b]\n```\n\n```csv\nname,value\nExample,1\n```\n",
    );
    const result = await buildBundle(root, { format: "github" });
    const files = unpack(result.data);
    expect(result.warnings).toEqual([]);
    expect(files["README.md"]).toContain('href="resources/files/100%25%20complete.ts"');
    expect(files["README.md"]).toMatch(/href="resources\/content\/guide.md#L\d+"/);
    expect(files["README.md"]).toContain("<summary>Diagram source</summary>");
    assertLinks(files);
});

it("keeps URL libraries after remote capture and lists local library sources", async () => {
    write(
        "dooc.yaml",
        "docs: [guide, more, {library: urls}, {library: url-previews}, {library: ts}]\n",
    );
    write(
        "content/guide.md",
        "## Intro\n\n[Website](https://example.com)\n\n![Remote](https://example.com/sample.txt)\n\n![](files/example.ts)\n",
    );
    write("files/example.ts", "const library = true;\n");
    vi.mocked(fetchPublicFile).mockResolvedValue(Buffer.from("Captured content"));
    const result = await buildBundle(root, { format: "github" });
    const files = unpack(result.data);
    const libraries = Object.entries(files)
        .filter(([name]) => name.startsWith("views/"))
        .map(([, body]) => body)
        .join("\n");
    expect(libraries).toContain('href="https://example.com"');
    expect(libraries).toContain('href="https://example.com/sample.txt"');
    expect(libraries).toContain('href="../resources/files/example.ts"');
    expect(result.warnings).toEqual([expect.stringContaining("source listing")]);
    assertLinks(files);
});

it("preserves HTML disclosures and SVG while reporting removed styles and controls", async () => {
    vi.mocked(fetchPublicFile).mockResolvedValue(Buffer.from("<p>Captured frame</p>"));
    write("content/guide.md", "## Intro\n\n![Note](figures/note.html)\n");
    write(
        "figures/note.html",
        '<!--fig\ntitle: Note\n-->\n<style>.panel{color:red}</style><details open><summary>More</summary><p>Visible</p><a href="https://example.com">Link</a><button>Run</button><iframe src="https://example.com"></iframe><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg></details>',
    );
    const result = await buildBundle(root, { format: "github" });
    const files = unpack(result.data);
    expect(result.warnings).toEqual([expect.stringContaining("HTML figure exported")]);
    expect(files["README.md"]).toContain('<details open=""><summary>More</summary>');
    expect(files["README.md"]).toContain("Visible");
    expect(files["README.md"]).not.toMatch(/<style|<iframe|<button|<svg|class=|style=/);
    assertLinks(files);
});

it("captures remote content in embed mode and emits links without fetching in network mode", async () => {
    write("content/guide.md", "## Intro\n\n![Remote](https://example.com/code.ts#L2)\n");
    vi.mocked(fetchPublicFile).mockResolvedValue(Buffer.from("// Header\nconst remote = true;\n"));
    const embedded = unpack((await buildBundle(root, { format: "github" })).data);
    expect(embedded["README.md"]).toContain("const remote = true;");
    assertLinks(embedded);
    expect(fetchPublicFile).toHaveBeenCalledOnce();
    vi.mocked(fetchPublicFile).mockClear();
    const network = await buildBundle(root, {
        format: "html",
        target: "github",
        urlPreview: "network",
    });
    expect(network.data).toContain('href="https://example.com/code.ts#L2"');
    expect(fetchPublicFile).not.toHaveBeenCalled();
    expect(network.warnings).toEqual([expect.stringContaining("exported as a link")]);
});

it("exports translations and grouped records without runtime controls", async () => {
    write(
        "dooc.yaml",
        "defaultLang: eng\nlanguages: [eng, jpn]\ndocs: [guide, more, {subformat: issue, title: Issues}]\nsubformats: [{ext: issue, format: json, schema: issue.schema.json, layouts: {card_title: title, group_by: status, sort_by: rank}}]\n",
    );
    write("content/guide.md", "## Intro\n\nEnglish\n");
    write(
        "locales/jpn/content/guide.md",
        "## Intro\n\nJapanese translation\n\n[Next](content/more.md#next)\n",
    );
    write(
        "issue.schema.json",
        '{"type":"object","properties":{"title":{"type":"string"},"status":{"type":"string"},"rank":{"type":"number"}}}',
    );
    write("records/a.issue", '{"title":"Second","status":"Open","rank":2}');
    write("records/b.issue", '{"title":"First","status":"Open","rank":1}');
    const files = unpack((await buildBundle(root, { format: "github" })).data);
    expect(files["locales/jpn/README.md"]).toContain("Japanese translation");
    const board =
        files["views/subformat-issue.md"] ??
        Object.entries(files).find(([name]) => name.startsWith("views/"))?.[1] ??
        "";
    expect(board).toContain("<h2>Open</h2>");
    expect(board).toContain("<summary>First</summary>");
    expect(board.indexOf("<summary>First")).toBeLessThan(board.indexOf("<summary>Second"));
    expect(board).not.toMatch(/<script|<input|<select/);
    assertLinks(files);
});
