import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { blocksHtml } from "../core/html.js";
import { publishHtml, siteFrom } from "../viewer/serve.js";
import { compileDraft, compileSite, createCompiler, writeArtifact } from "./compile.js";
import { collectRefs, parseDoc } from "./dialect.js";
import { exportEntries } from "./export.js";
import { formatMarkdown } from "./format.js";
import { readTextfile, selectTextfileRange } from "./textfile.js";

const roots: string[] = [];
const source = (body: string): string => `---\ntitle: Sample\n---\n\n${body}\n`;
const embed = (file: string, range = ""): string =>
    `![](${encodeURI(file).replaceAll("#", "%23").replaceAll("?", "%3F").replaceAll("(", "%28").replaceAll(")", "%29")}${range})`;
const fixture = (body: string): string => {
    const root = mkdtempSync(join(tmpdir(), "docs-textfile-"));
    roots.push(root);
    mkdirSync(join(root, "content"));
    mkdirSync(join(root, "examples"));
    writeFileSync(join(root, "manifest.yaml"), "- sample\n");
    writeFileSync(join(root, "content/sample.md"), source(body));
    return root;
};
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("previews unsaved file contents and ranges without changing disk or later builds", () => {
    const body = "![](./examples/hello.rs#L2)";
    const root = fixture(body);
    writeFileSync(join(root, "examples/hello.rs"), "disk\nold\n");
    const context = {
        root,
        docs: [],
        figures: new Map(),
        textfiles: new Map([["examples/hello.rs", "draft\nnew\n"]]),
    };
    const { doc, source: result } = compileDraft(context, "content/sample.md", source(body));
    expect(result.errors).toEqual([]);
    expect(doc.blocks[0]).toMatchObject({ lines: ["new"] });
    expect(readFileSync(join(root, "examples/hello.rs"), "utf8")).toBe("disk\nold\n");
    expect(compileSite(root).artifact.docs[0]?.blocks[0]).toMatchObject({ lines: ["old"] });
    context.textfiles.set("examples/hello.rs", "short");
    expect(compileDraft(context, "content/sample.md", source(body)).source.errors.join()).toContain(
        "range line 2 does not exist",
    );
});

it("parses and formats Markdown file embeds without interpreting fenced examples", () => {
    const body = `${embed("examples/日本語 & sample.tdl")}\n\nAfter\n\n\`\`\`md\n${embed("missing.txt")}\n\`\`\``;
    for (const input of [source(body), source(body).replaceAll("\n", "\r\n")]) {
        const parsed = parseDoc(input);
        expect(parsed.errors).toEqual([]);
        expect(collectRefs(parsed.root)).toEqual({
            figures: [],
            terms: [],
            textfiles: ["examples/日本語 & sample.tdl"],
        });
        const formatted = formatMarkdown(input);
        expect(formatted.replaceAll("\r\n", "\n")).toContain(embed("examples/日本語 & sample.tdl"));
        expect(formatMarkdown(formatted)).toBe(formatted);
    }
    for (const body of [
        ":::textfile(a.txt)",
        ":::textfile()\n:::",
        ":::textfile\n:::",
        ':::textfile{src=""}\n:::',
        ":::textfile(a.txt",
        ":::textfile(a.txt)[caption]",
    ])
        expect(parseDoc(source(body)).errors.length, body).toBeGreaterThan(0);
    expect(
        parseDoc(source("```md\n:::textfile(a.txt)\n```\n\n`:::textfile(a.txt)`")).errors,
    ).toEqual([]);
});

it("decodes local URLs once and applies the filesystem boundary after decoding", () => {
    const file = "examples/a #?(draft)%.txt";
    const root = fixture(embed(file, "#L2"));
    writeFileSync(join(root, file), "one\ntwo\n");
    const compiled = compileSite(root);
    expect(compiled.errors).toEqual([]);
    expect(compiled.artifact.docs[0]?.blocks[0]).toMatchObject({ filename: file, lines: ["two"] });
    expect(exportEntries(root).some((entry) => entry.name === file)).toBe(true);
    for (const url of ["%2e%2e/secret.txt", "%2Fetc/passwd", "..%5Csecret.txt"]) {
        writeFileSync(join(root, "content/sample.md"), source(`![](${url})`));
        expect(compileSite(root).errors.join()).toContain(
            "relative file path inside the docs root",
        );
    }
});

it("embeds files with extension languages, safe filename headers and standalone JSON/HTML exports", () => {
    const filenames = ["Sample.TS", "model.tdl", "notes.unknown", "Dockerfile", "a<b>.txt"];
    const body = filenames.map((file) => embed(`examples/${file}`)).join("\n\n");
    const root = fixture(`${body}\n\nAfter`);
    const text = '<script>alert("x")</script>\n  日本語 & code\n';
    for (const file of filenames) writeFileSync(join(root, "examples", file), text);
    const built = compileSite(root);
    expect(built.errors).toEqual([]);
    const doc = built.artifact.docs[0];
    expect(doc?.blocks.slice(0, 5)).toEqual(
        filenames.map((file, i) => ({
            type: "code",
            filename: `examples/${file}`,
            lines: text.split("\n"),
            lang: ["ts", "tdl", "unknown", "dockerfile", "txt"][i],
        })),
    );
    expect(doc?.blocks.at(-1)).toEqual({ type: "p", text: "After" });
    expect(built.sources.get("content/sample.md")?.lines).toEqual([1, 3, 5, 7, 9, 11]);
    const html = blocksHtml(doc?.blocks ?? []);
    expect(html).toContain('<div class="codeblk textfile"');
    expect(html).toContain('<span class="codeblk-head">');
    expect(html).toContain('<span class="codeblk-lang">.TS</span>');
    expect(html).toContain('data-lang="ts"');
    expect(html).toContain('class="codeblk-filename">Sample.TS</span>');
    expect(html).toContain('class="codeblk-filename">a&lt;b&gt;.txt</span>');
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(publishHtml(siteFrom(built), "")).toContain('class="codeblk-filename">model.tdl</span>');
    const out = join(root, "artifact");
    expect(writeArtifact(built, out)).toBe(true);
    expect(JSON.parse(readFileSync(join(out, "docs.json"), "utf8")).docs[0].blocks).toEqual(
        doc?.blocks,
    );
});

it("refreshes referenced content without reparsing Markdown and resolves unsaved drafts", () => {
    const root = fixture(embed("examples/model.tdl"));
    const path = join(root, "examples/model.tdl");
    writeFileSync(path, "first");
    const compiler = createCompiler(root);
    const first = compiler.compile();
    writeFileSync(path, "second\n");
    const second = compiler.compile();
    expect(first.artifact.docs[0]?.blocks[0]).toMatchObject({ lines: ["first"] });
    expect(second.artifact.docs[0]?.blocks[0]).toMatchObject({ lines: ["second", ""] });
    const ctx = { root, docs: second.artifact.docs, figures: new Map() };
    const draft = compileDraft(ctx, "content/sample.md", source(embed("examples/model.tdl")));
    expect(draft.source.errors).toEqual([]);
    expect(draft.doc.blocks).toEqual(second.artifact.docs[0]?.blocks);
    rmSync(path);
    expect(compiler.compile().errors).toEqual([]);
    expect(compiler.compile().artifact.docs[0]?.blocks[0]).toMatchObject({
        unavailable: "missing",
    });
    expect(
        compileDraft(ctx, "content/sample.md", source(embed("examples/model.tdl"))).source.errors,
    ).toEqual([]);
    writeFileSync(path, "");
    expect(compiler.compile().errors).toEqual([]);
    expect(compiler.compile().artifact.docs[0]?.blocks[0]).toMatchObject({ lines: [""] });
    expect(compiler.compile().artifact.docs[0]?.blocks[0]).not.toHaveProperty("unavailable");
});

it("renders missing files gracefully and keeps the document exportable", () => {
    const root = fixture("![](examples/missing.rs#L2-L4)\n\nAfter");
    const compiled = compileSite(root);
    expect(compiled.errors).toEqual([]);
    const html = blocksHtml(compiled.artifact.docs[0]?.blocks ?? []);
    expect(html).toContain('title="examples/missing.rs#L2-L4"');
    expect(html).toContain('data-i18n="File not found"');
    expect(html).toContain("<p>After</p>");
    expect(html).not.toContain('class="codecopy"');
    expect(writeArtifact(compiled, join(root, "artifact"))).toBe(true);
    expect(exportEntries(root).map((entry) => entry.name)).not.toContain("examples/missing.rs");
});

it("rejects traversal, outside symlinks, directories and invalid text without exporting", () => {
    const root = fixture(embed("examples/invalid.txt"));
    const outside = fixture("");
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(root, "examples/link.txt"));
    writeFileSync(join(root, "examples/invalid.txt"), Buffer.from([0xff]));
    writeFileSync(join(root, "examples/binary.txt"), "a\0b");
    for (const file of [
        "../secret.txt",
        join(outside, "secret.txt"),
        "examples/link.txt",
        "examples",
        "examples/invalid.txt",
        "examples/binary.txt",
        "examples/missing.txt",
        "..\\secret.txt",
    ])
        expect(() => readTextfile(root, file), file).toThrow();
    expect(compileSite(root).errors.join()).toContain("examples/invalid.txt:");
    expect(writeArtifact(compileSite(root), join(root, "artifact"))).toBe(false);
    expect(() => exportEntries(root)).toThrow();
});

it("keeps referenced source files and translated references in ZIP exports once each", () => {
    const root = fixture(`${embed("examples/model.tdl")}\n\n${embed("./examples/model.tdl")}`);
    writeFileSync(join(root, "examples/model.tdl"), "model\n");
    writeFileSync(join(root, "examples/translated.py"), "print('hello')\n");
    writeFileSync(join(root, "examples/unreferenced.txt"), "omit");
    mkdirSync(join(root, "locales"));
    writeFileSync(
        join(root, "locales/eng.json"),
        JSON.stringify({ sample: { title: "Sample", body: embed("examples/translated.py") } }),
    );
    const entries = exportEntries(root);
    expect(
        entries.filter((entry) => entry.name.startsWith("examples/")).map((entry) => entry.name),
    ).toEqual(["examples/model.tdl", "examples/translated.py"]);
    const restored = fixture("");
    mkdirSync(join(restored, "locales"));
    for (const entry of entries) writeFileSync(join(restored, entry.name), entry.data);
    expect(compileSite(restored).errors).toEqual([]);
    expect(
        compileSite(root, { defaultLang: "jpn", locale: "eng" }).artifact.docs[0]?.blocks[0],
    ).toMatchObject({ lang: "py", lines: ["print('hello')", ""] });
});

it("preserves GitHub selectors, embeds only excerpts, and exports the complete source", () => {
    const text = 'before\nAAAA start\nC:\\src, "quoted" &quot; [text]\nBBB end\nafter\n';
    const selectors = ["#L2-L4", "#L1", "#L2-L2", "#L3-L5"];
    const body = selectors.map((range) => embed("examples/source.txt", range)).join("\n\n");
    const root = fixture(body);
    writeFileSync(join(root, "examples/source.txt"), text);
    const parsed = parseDoc(source(body));
    expect(parsed.errors).toEqual([]);
    expect(collectRefs(parsed.root).textfiles).toEqual(["examples/source.txt"]);
    const formatted = formatMarkdown(source(body));
    for (const range of selectors) expect(formatted).toContain(embed("examples/source.txt", range));
    expect(formatMarkdown(formatted)).toBe(formatted);
    const compiled = compileSite(root);
    expect(compiled.errors).toEqual([]);
    expect(blocksHtml(compiled.artifact.docs[0]?.blocks ?? [])).toContain(
        'title="examples/source.txt#L2-L4"',
    );
    expect(compiled.artifact.docs[0]?.blocks).toEqual(
        selectors.map((range) => ({
            type: "code",
            filename: "examples/source.txt",
            lang: "txt",
            range,
            lines: selectTextfileRange(text, range).split("\n"),
        })),
    );
    expect(
        exportEntries(root)
            .find((entry) => entry.name === "examples/source.txt")
            ?.data.toString(),
    ).toBe(text);
    const out = join(root, "artifact");
    expect(writeArtifact(compiled, out)).toBe(true);
    const draft = compileDraft(
        { root, docs: compiled.artifact.docs, figures: new Map() },
        "content/sample.md",
        source(embed("examples/source.txt", "#L99")),
    );
    expect(draft.source.errors.join()).toContain("range line 99 does not exist");
    expect(draft.doc.blocks[0]).toMatchObject({ lines: [] });
    writeFileSync(
        join(root, "content/sample.md"),
        source(embed("examples/source.txt", "#L2-L999")),
    );
    expect(writeArtifact(compileSite(root), out)).toBe(false);
});

it("keeps Markdown links as links, supports multiple embeds, and preserves alternative text", () => {
    const body =
        "[Source](examples/a.txt#L2)\n\n![Example](examples/a.txt#L2)\n![](examples/a.txt#L1)";
    const root = fixture(body);
    writeFileSync(join(root, "examples/a.txt"), "one\ntwo\n");
    const compiled = compileSite(root);
    expect(compiled.errors).toEqual([]);
    expect(compiled.artifact.docs[0]?.blocks).toMatchObject([
        { type: "p", text: "[Source](examples/a.txt#L2)" },
        { type: "code", lines: ["two"], alt: "Example" },
        { type: "code", lines: ["one"] },
    ]);
    expect(blocksHtml(compiled.artifact.docs[0]?.blocks ?? [])).toContain('aria-label="Example"');
    expect(compiled.sources.get("content/sample.md")?.lines).toEqual([1, 3, 4]);
    for (const invalid of [
        "Text ![](examples/a.txt)",
        "- ![](examples/a.txt)",
        ":::callout\n![](examples/a.txt)\n:::",
    ])
        expect(parseDoc(source(invalid)).errors.join()).toContain("standalone paragraph");
});
