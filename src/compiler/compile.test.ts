import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { blocksHtml } from "../core/html.js";
import { defaultPreviewSettings } from "../core/previewers.js";
import { docDisplayName } from "../core/taxonomy.js";
import {
    compileDraft,
    compileSite,
    createCompiler,
    rewriteDocLinks,
    writeArtifact,
} from "./compile.js";
import { exportEntries } from "./export.js";
import { writeCatalog } from "./locales.js";

const writeDoc = (path: string, title: string): void => {
    writeFileSync(path, `---\ntitle: "${title}"\n---\n\nBody.\n`);
};

// content/ = flat <id>.md files; manifest.yaml sits at the docs root.
const makeRoot = (manifest: string, docs: Record<string, string> = {}): string => {
    const root = mkdtempSync(join(tmpdir(), "docs-build-"));
    const content = join(root, "content");
    mkdirSync(content, { recursive: true });
    writeFileSync(join(root, "manifest.yaml"), manifest);
    for (const [id, title] of Object.entries(docs)) {
        writeDoc(join(content, `${id}.md`), title);
    }
    return root;
};

describe("compileSite manifest", () => {
    it("orders the manifest.yaml tree in pre-order and sets parent (unlimited depth)", () => {
        const root = makeRoot("- b:\n    - c:\n        - d\n- a\n", {
            a: "A",
            b: "B",
            c: "C",
            d: "D",
        });
        const { artifact, errors } = compileSite(root);
        expect(errors).toEqual([]);
        expect(artifact.docs.map((d) => [d.id, d.parent, d.file])).toEqual([
            ["b", undefined, "content/b.md"],
            ["c", "b", "content/c.md"],
            ["d", "c", "content/d.md"],
            ["a", undefined, "content/a.md"],
        ]);
    });

    it("errors on md files missing from the manifest / ids without an md / files outside the convention", () => {
        const root = makeRoot("- a\n- ghost\n", { a: "A", orphan: "O" });
        mkdirSync(join(root, "content", "old-folder"));
        const { errors } = compileSite(root);
        expect(errors).toContain("content/orphan.md: not registered in manifest.yaml");
        expect(errors).toContain(
            "content/ghost.md: listed in manifest.yaml but the file is missing",
        );
        expect(errors.some((e) => e.startsWith("content/old-folder: "))).toBe(true);
    });

    it("errors on a missing / broken manifest.yaml / duplicate ids", () => {
        const none = makeRoot("", { a: "A" });
        rmSync(join(none, "manifest.yaml"));
        expect(compileSite(none).errors).toContain("manifest.yaml is required");
        const broken = makeRoot("- a:\n  - [", { a: "A" });
        expect(compileSite(broken).errors.some((e) => e.includes("invalid YAML"))).toBe(true);
        const dup = makeRoot("- a\n- b:\n    - a\n", { a: "A", b: "B" });
        expect(compileSite(dup).errors.some((e) => e.includes('duplicate id "a"'))).toBe(true);
    });
});

describe("rewriteDocLinks", () => {
    it("rewrites only doc: links whose docId matches exactly (no id prefix collisions)", () => {
        const body = "[a](doc:api) [b](doc:api-v2) [c](doc:other)";

        expect(rewriteDocLinks(body, "api", "api-renamed")).toBe(
            "[a](doc:api-renamed) [b](doc:api-v2) [c](doc:other)",
        );
    });

    it("returns the body unchanged when no doc: link matches", () => {
        const body = "This body has no doc: links.";

        expect(rewriteDocLinks(body, "api", "api-renamed")).toBe(body);
    });
});

describe("term code blocks", () => {
    it("collects inline definitions with document-based identities", () => {
        const root = makeRoot("- a\n- b\n");
        const dir = join(root, "content");
        const declaration = (term: string) =>
            `---\ntitle: terms\n---\n\n~~~termth\nname: ${term}\ndefinition: Definition\n~~~\n`;
        writeFileSync(join(dir, "a.md"), declaration("alpha"));
        writeFileSync(join(dir, "b.md"), declaration("beta"));
        const built = compileSite(root);
        expect(built.errors).toEqual([]);
        expect(built.artifact?.terms.map((e) => e.id)).toEqual([
            "content/a.md#L5",
            "content/b.md#L5",
        ]);
        expect(built.artifact?.docs[0]?.blocks).toEqual([
            {
                type: "term",
                entry: { id: "content/a.md#L5", name: "alpha", definition: "Definition" },
            },
        ]);
        writeFileSync(join(dir, "b.md"), declaration("alpha"));
        const conflict = compileSite(root);
        expect(conflict.errors).toEqual([]);
    });
});

describe("createCompiler (incremental compile for the viewer)", () => {
    const fixture = (): { root: string; all: string } => {
        const root = makeRoot("- a\n- b\n", { a: "A", b: "B" });
        return { root, all: join(root, "content") };
    };

    it("routes Markdown media embeds, preserves binary exports and applies changed registrations to cached docs and drafts", () => {
        const { root, all } = fixture();
        mkdirSync(join(root, "figures"));
        const svg =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Shape</title></svg>';
        const png = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT6sAAAAASUVORK5CYII=",
            "base64",
        );
        writeFileSync(join(root, "figures/shape.svg"), svg);
        writeFileSync(join(root, "figures/pixel.png"), png);
        writeFileSync(
            join(root, "figures/card.html"),
            "<!--fig\ntitle: Card\n-->\n<p>HTML content</p>",
        );
        const body =
            "---\ntitle: Media\n---\n\n![Shape label](figures/shape.svg)\n![Pixel & label](figures/pixel.png)\n![](figures/card.html)\n\n![](figures/shape.svg#L1)\n";
        writeFileSync(join(all, "a.md"), body);
        const compiler = createCompiler(root);
        const first = compiler.compile();
        expect(first.errors).toEqual([]);
        const doc = first.artifact.docs[0];
        if (!doc) throw new Error("Missing document");
        expect(doc.blocks).toEqual([
            { type: "figureRef", name: "shape", caption: "Shape label" },
            { type: "figureRef", name: "pixel", caption: "Pixel & label" },
            { type: "figureRef", name: "card" },
            {
                type: "code",
                filename: "figures/shape.svg",
                range: "#L1",
                lang: "svg",
                lines: [svg],
            },
        ]);
        expect(first.sources.get("content/a.md")?.lines).toEqual([1, 2, 3, 5]);
        expect(doc.refs.figures).toEqual(["shape", "pixel", "card"]);
        const figures = new Map(first.figures.map((figure) => [figure.name, figure]));
        const html = blocksHtml(doc.blocks, { figures, terms: [] });
        expect(html).toContain('title="Shape label"');
        expect(html).toContain('alt="Pixel &amp; label"');
        expect(html).toContain('data-doc-figure-frame="html" sandbox="allow-scripts"');
        expect(html).not.toContain("allow-same-origin");
        expect(
            exportEntries(root).find((entry) => entry.name === "figures/pixel.png")?.data,
        ).toEqual(png);

        const previews = defaultPreviewSettings();
        previews.formats.image = previews.formats.image.filter((ext) => ext !== "svg");
        previews.formats.code.push("svg");
        writeFileSync(join(root, "manifest.yaml"), JSON.stringify({ docs: ["a", "b"], previews }));
        const second = compiler.compile();
        expect(second.errors).toEqual([]);
        expect(second.artifact.docs[0]?.blocks[0]).toEqual({
            type: "code",
            filename: "figures/shape.svg",
            alt: "Shape label",
            lang: "svg",
            lines: [svg],
        });
        expect(second.artifact.docs[0]?.refs.figures).toEqual(["pixel", "card"]);
        const draft = compileDraft(
            { root, docs: second.artifact.docs, figures },
            "content/a.md",
            body,
        );
        expect(draft.source.errors).toEqual([]);
        expect(draft.doc.blocks).toEqual(second.artifact.docs[0]?.blocks);
    });

    it("does not re-parse docs when the disk is unchanged (same blocks reference) and rebuilds them when it changes", () => {
        const { root, all } = fixture();
        const compiler = createCompiler(root);
        const first = compiler.compile().artifact.docs;
        const second = compiler.compile().artifact.docs;
        expect(second[0]?.blocks).toBe(first[0]?.blocks);
        writeFileSync(join(all, "a.md"), '---\ntitle: "A2"\n---\n\nUpdated body\n');
        const third = compiler.compile().artifact.docs;
        expect(third[0]?.blocks).not.toBe(first[0]?.blocks);
        expect(docDisplayName(third[0], "")).toBe("A2");
        expect(third[1]?.blocks).toBe(first[1]?.blocks);
    });

    it("keeps docs with broken front-matter in the artifact (title = id) and returns errors per doc", () => {
        const { root, all } = fixture();
        writeFileSync(join(all, "a.md"), "---\ntags: [x]\n---\n\nBody\n");
        const compiled = compileSite(root);
        expect(docDisplayName(compiled.artifact.docs[0], "")).toBe("a");
        expect(compiled.sources.get("content/a.md")?.frontmatter).toBeUndefined();
        expect(compiled.sources.get("content/a.md")?.errors.length).toBeGreaterThan(0);
        expect(compiled.errors.some((e) => e.startsWith("content/a.md: "))).toBe(true);
        expect(writeArtifact(compiled, join(root, "artifact"))).toBe(false);
    });

    it("resolves each doc's lang: front-matter lang, else the site default (defaultLang option)", () => {
        const { root, all } = fixture();
        writeFileSync(join(all, "a.md"), '---\ntitle: "A"\nlang: "ja"\n---\n\nBody\n');
        const langs = (defaultLang?: string): string[] =>
            compileSite(root, defaultLang ? { defaultLang } : {}).artifact.docs.map((d) => d.lang);
        expect(langs()).toEqual(["ja", "en"]);
        expect(langs("de")).toEqual(["ja", "de"]);
    });

    it("reads manifest defaultLang on every compile, including source-language catalog selection", () => {
        const { root, all } = fixture();
        writeFileSync(join(all, "a.md"), "---\ntitle: A\nlang: ja\n---\nBody\n");
        writeFileSync(join(root, "manifest.yaml"), "defaultLang: jpn\ndocs: [a, b]\n");
        writeCatalog(root, "eng", { b: { title: "English B", body: "English body" } });
        const compiler = createCompiler(root);
        const english = createCompiler(root, { locale: "eng" });
        expect(compiler.compile().defaultLang).toBe("jpn");
        expect(compiler.compile().artifact.docs.map((doc) => doc.lang)).toEqual(["ja", "jpn"]);
        expect(english.compile().artifact.docs[1]?.title).toBe("English B");
        writeFileSync(join(root, "manifest.yaml"), "defaultLang: eng\ndocs: [a, b]\n");
        expect(compiler.compile().defaultLang).toBe("eng");
        expect(compiler.compile().artifact.docs.map((doc) => doc.lang)).toEqual(["ja", "eng"]);
        expect(english.compile().artifact.docs[1]?.title).toBe("B");
        writeFileSync(join(root, "manifest.yaml"), "defaultLang: invalid language\ndocs: [a, b]\n");
        expect(compiler.compile().errors.join()).toContain("manifest.yaml: defaultLang");
    });

    it("compileDraft: validates unsaved source in the site context (doc: links / figures)", () => {
        const { root } = fixture();
        const compiled = compileSite(root);
        const { doc, source } = compileDraft(
            {
                docs: compiled.artifact.docs,
                figures: new Map([["x", { file: "figures/x.svg" }]]),
            },
            "content/a.md",
            '---\ntitle: "A"\n---\n\n[ok](doc:b) [ng](doc:zzz)\n\n![](figures/nope.svg)\n\n![](figures/x.png)\n\n![ok](figures/x.svg)\n',
        );
        expect(doc.id).toBe("a");
        expect(doc.refs).toEqual({ figures: ["nope", "x", "x"], terms: [] });
        // Same name but a different extension (x.png ≠ x.svg) is unresolved
        expect(source.errors).toEqual([
            '"nope.svg" is not in figures/',
            '"x.png" is not in figures/',
            'doc: link "doc:zzz" is unresolved (check the docId)',
        ]);
    });

    it("writeArtifact: writes docs.json when there are no errors", () => {
        const { root } = fixture();
        const out = join(root, "artifact");
        expect(writeArtifact(compileSite(root), out)).toBe(true);
        const json = JSON.parse(readFileSync(join(out, "docs.json"), "utf8"));
        expect(json.docs.map((d: { id: string }) => d.id)).toEqual(["a", "b"]);
        expect(json).not.toHaveProperty("presentations");
        expect(existsSync(join(out, "presentations"))).toBe(false);
    });

    it("reports schema errors during compilation and preserves the previous export", () => {
        const { root } = fixture();
        const out = join(root, "artifact");
        const valid = compileSite(root);
        expect(writeArtifact(valid, out)).toBe(true);
        const previous = readFileSync(join(out, "docs.json"), "utf8");
        const invalid = compileSite(root, { defaultLang: "invalid language tag" });
        expect(invalid.siteErrors.join()).toContain("docs.json/docs/0/lang");
        expect(invalid.errors).toEqual(expect.arrayContaining(invalid.siteErrors));
        expect(writeArtifact(invalid, out)).toBe(false);
        valid.artifact.generation = 999;
        expect(writeArtifact(valid, out)).toBe(false);
        expect(readFileSync(join(out, "docs.json"), "utf8")).toBe(previous);
    });
});

describe("sample-content (bundled docs root)", () => {
    it("compiles without validation errors", () => {
        const root = new URL("../../sample-content", import.meta.url).pathname;
        expect(compileSite(root).errors).toEqual([]);
    });
});

describe("HTML embeds", () => {
    it.each(["jpn", "eng", "zho"])("keeps external embeds in %s articles", (locale) => {
        const root = makeRoot("- media\n");
        try {
            const tags = ["iframe", "video", "audio"];
            const body = tags.map((tag) => `![](figures/${tag}.html)`).join("\n\n");
            writeFileSync(join(root, "content/media.md"), `---\ntitle: Media\n---\n\n${body}\n`);
            mkdirSync(join(root, "figures"));
            for (const tag of tags) {
                writeFileSync(
                    join(root, `figures/${tag}.html`),
                    `<!--fig\ntitle: Fig.${tag}\n-->\n<${tag} src="https://example.com/${tag}"></${tag}>`,
                );
            }
            if (locale !== "jpn") writeCatalog(root, locale, { media: { title: "Media", body } });
            const result = compileSite(root, { defaultLang: "jpn", locale });
            expect(result.errors).toEqual([]);
            const media = result.artifact.docs.find((doc) => doc.id === "media");
            expect(media?.lang).toBe(locale);
            for (const tag of tags) {
                expect(media?.refs.figures).toContain(tag);
                const figure = result.figures.find((fig) => fig.name === tag);
                expect(figure?.kind).toBe("html");
                expect(figure?.markup).toContain(`<${tag}`);
                expect(figure?.markup).toContain(`src="https://example.com/${tag}"`);
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
