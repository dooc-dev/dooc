import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileSite } from "../compiler/compile.js";
import { parseDoc } from "../compiler/dialect.js";
import { contentLanguages } from "../compiler/language-codes.js";
import { writeCatalog } from "../compiler/locales.js";
import { docPath } from "../core/routing.js";
import { CODE_LANGS } from "../core/taxonomy.js";
import { BUILTIN_LANGUAGES } from "./languages.js";
import {
    assembleDoc,
    createBundleCache,
    docQueryResponse,
    type Entry,
    editorBoot,
    isExternallyModified,
    languageFieldHtml,
    navGroupsHtml,
    pageDataResponse,
    publishHtml,
    renderDocFile,
    resolveContentFile,
    resourcesMain,
    type Site,
    sanitizeFrontmatter,
    siteFrom,
} from "./serve.js";

const emptySite = (): Site => ({
    entries: [],
    ctx: { figures: new Map(), terms: [] },
    errors: [],
    languages: BUILTIN_LANGUAGES,
    defaultLang: "en",
});

describe("assembleDoc", () => {
    it("serializes only title / lang, dropping legacy description metadata", () => {
        const legacy = { lang: "ja", title: "Overview", description: "Description" };
        expect(assembleDoc(legacy, "Body.")).toBe(
            '---\ntitle: "Overview"\nlang: "ja"\n---\n\nBody.\n',
        );
    });

    it("round-trip preserves frontmatter / body (parseDoc reads it back without errors)", () => {
        const fm = { title: "x" };
        const raw = assembleDoc(fm, "## Heading\n\nBody");
        const parsed = parseDoc(raw);
        expect(parsed.errors).toEqual([]);
        expect(parsed.frontmatter).toEqual(fm);
        expect(parsed.body).toBe("## Heading\n\nBody\n");
    });

    it("an empty body yields front-matter only (trailing extra newlines are collapsed too)", () => {
        expect(assembleDoc({ title: "x" }, "\n\n")).toBe('---\ntitle: "x"\n---\n');
    });
});

describe("sanitizeFrontmatter", () => {
    it("keeps only known keys, drops empty optionals and trims", () => {
        expect(
            sanitizeFrontmatter({
                title: " t ",
                extra: "ignored",
                tags: [" ", ""],
                description: "Removed document description",
                lang: "",
            }),
        ).toEqual({ title: "t" });
        expect(sanitizeFrontmatter({ title: "t", lang: " ja " })).toEqual({
            title: "t",
            lang: "ja",
        });
    });
});

describe("isExternallyModified", () => {
    it("false when base matches the current disk value (own save = normal overwrite)", () => {
        expect(isExternallyModified('---\ntitle: "x"\n---\n', '---\ntitle: "x"\n---\n')).toBe(
            false,
        );
    });

    it("true when base differs from the current disk value (rewritten externally first)", () => {
        expect(isExternallyModified('---\ntitle: "x"\n---\n', '---\ntitle: "y"\n---\n')).toBe(true);
    });

    it("false (undecidable) when the client does not send base", () => {
        expect(isExternallyModified(undefined, '---\ntitle: "y"\n---\n')).toBe(false);
    });
});

describe("resolveContentFile", () => {
    it("allows only `<id>.md` directly under content/ (rejects traversal / folders / names outside the convention)", () => {
        expect(resolveContentFile("setup.md")?.id).toBe("setup");
        expect(resolveContentFile("guide/setup.md")).toBeUndefined();
        expect(resolveContentFile("../etc/passwd")).toBeUndefined();
        // Non-ASCII (Japanese) name: outside the id convention
        expect(resolveContentFile("自由.md")).toBeUndefined();
        expect(resolveContentFile("evil.txt")).toBeUndefined();
        expect(resolveContentFile(42)).toBeUndefined();
    });
});

describe("navGroupsHtml", () => {
    const entry = (id: string, parent?: string): Entry => ({
        id,
        ...(parent ? { parent } : {}),
        file: `${id}.md`,
        frontmatter: { title: id.toUpperCase() },
        lang: "en",
        body: "",
        toc: id === "a" ? [{ depth: 2, text: "Heading", slug: "heading" }] : [],
        blockLines: [],
        raw: "",
        blocks: [],
        errors: [],
    });
    // a ─ b ─ c / d (roots and children in the same flat list)
    const fixtureSite = (): Site => ({
        entries: [entry("a"), entry("b", "a"), entry("c", "b"), entry("d")],
        ctx: { figures: new Map(), terms: [] },
        errors: [],
        languages: [],
        defaultLang: "en",
    });

    it("marks the current page without adding its heading TOC", () => {
        const html = navGroupsHtml("preview", fixtureSite(), "a");
        expect(html).toContain('class="nav-link cur" href="/a"');
        expect(html.match(/ cur"/g)).toHaveLength(1);
        expect(html).not.toContain('id="nav-toc"');
        expect(html).not.toContain("Heading");
        expect(html).not.toContain('href="#');
    });

    it("no current location when current is omitted (no cur class and no toc)", () => {
        const html = navGroupsHtml("preview", fixtureSite(), undefined);
        expect(html).not.toContain(' cur"');
        expect(html).not.toContain("nav-toc");
    });

    it("top level is an icon nav-link; children and below are nav-tree with --nav-depth", () => {
        const html = navGroupsHtml("preview", fixtureSite(), "c");
        expect(
            html.startsWith(
                '<div class="nav-list nav-root" data-parent=""><div class="nav-item open" data-doc-id="a">',
            ),
        ).toBe(true);
        expect(html).toContain('<a class="nav-link" href="/a" title="A">');
        expect(html).toContain(
            '<div class="nav-list nav-tree" data-parent="a" style="--nav-depth:2"><div class="nav-item open" data-doc-id="b">',
        );
        expect(html).toMatch(
            /<a class="nav-tree-link cur" href="\/a\/b\/c" title="C"><svg[^>]*class="nav-icon"/,
        );
        // Only docs with children get an open/close toggle; only the branch containing the
        // current doc is open by default
        expect(html.match(/nav-tree-toggle/g)).toHaveLength(2);
        expect(html).toContain('<div class="nav-item" data-doc-id="d">');
    });

    it("edit mode shows titles without filenames and keeps metadata editing actions", () => {
        const edit = navGroupsHtml("edit", fixtureSite(), undefined);
        expect(edit).toContain('draggable="true"');
        expect(edit).not.toContain("drag-handle");
        expect(edit.match(/class="new"/g)).toHaveLength(4);
        expect(edit).toContain('class="new" type="button" data-parent="b"');
        expect(edit.match(/class="nav-create"/g)).toHaveLength(1);
        expect(edit).toContain('class="nav-item nav-placeholder nav-add-hover"');
        expect(edit).toContain('class="nav-create" type="button" data-parent=""');
        expect(edit.match(/class="nav-tree-toggle"/g)).toHaveLength(4);
        expect(edit).not.toContain('class="nav-rename"');
        expect(edit.match(/aria-keyshortcuts="F2"/g)).toHaveLength(4);
        expect(edit.match(/data-doc-action="delete"/g)).toHaveLength(4);
        expect(edit.match(/class="nav-doc-icon"/g)).toHaveLength(4);
        expect(edit).not.toContain("nav-doc-id");
        const preview = navGroupsHtml("preview", fixtureSite(), undefined);
        expect(preview).not.toContain("draggable");
        expect(preview).not.toContain("drag-handle");
        expect(preview).not.toContain('class="new"');
        expect(preview).not.toContain("nav-placeholder");
        expect(preview).not.toContain("data-doc-action");
        expect(preview).not.toContain('type="file"');
        expect(preview).not.toContain("nav-doc-id");
    });

    it("keeps child pages directly after their parent row in edit mode", () => {
        const html = navGroupsHtml("edit", fixtureSite(), "a");
        expect(html).toContain('</button></div><div class="nav-list nav-tree" data-parent="a"');
        expect(html).not.toContain("nav-toc");
        expect(html).not.toContain("Heading");
    });

    it("with no docs, shows an empty root placeholder only in edit mode", () => {
        expect(navGroupsHtml("preview", emptySite(), undefined)).toBe(
            '<div class="nav-list nav-root" data-parent=""></div>',
        );
        const edit = navGroupsHtml("edit", emptySite());
        expect(edit.match(/class="nav-create"/g)).toHaveLength(1);
        expect(edit).toContain('class="nav-create" type="button" data-parent=""');
        expect(edit).toContain('<span class="nav-label">...</span>');
        expect(edit).not.toContain("nav-doc-id");
        expect(edit).not.toContain("nav-add-hover");
        expect(edit.indexOf('class="nav-create"')).toBeLessThan(edit.indexOf("nav-resources"));
    });

    it("Files navigation is edit-only and opens the folder manager", () => {
        const site: Site = {
            ...fixtureSite(),
            ctx: {
                figures: new Map([
                    [
                        "widget",
                        {
                            name: "widget",
                            file: "figures/widget.html",
                            kind: "html" as const,
                            markup: "<div>Widget</div>",
                        },
                    ],
                    [
                        "x",
                        {
                            name: "x",
                            file: "figures/x.svg",
                            kind: "svg" as const,
                            markup: "<svg/>",
                        },
                    ],
                ]),
                terms: [],
            },
        };
        expect(navGroupsHtml("preview", site)).not.toContain("nav-resources");
        const html = navGroupsHtml("edit", site, undefined, "figures/x.svg");
        expect(html).toContain('class="nav-tree-link cur" href="/_files/file/figures%2Fx.svg"');
        expect(html).toContain('data-i18n="Files">Files');
        expect(resourcesMain(site, "")?.main).toContain('id="files-manager"');
        expect(resourcesMain(site, "figures/x.svg")?.main).toContain("<iframe");
        expect(resourcesMain(site, "html/widget.html")?.main).toContain("Widget");
    });

    it("shows the physical file tree in saved order, including unreferenced files", () => {
        const site = fixtureSite();
        site.entries[1] = { ...entry("b", "a"), sourceFile: "files/md/b.md" };
        site.filePaths = [
            "files/ts/z.ts",
            "files/ts/a%20.ts",
            "files/md/b.md",
            'notes/<tag> & "name".txt',
            "files/ts/z.ts",
            "../outside.txt",
        ];
        const html = navGroupsHtml("edit", site, undefined, "file/files%2Fts%2Fa%2520.ts");
        expect(html).toContain('class="nav-item open" data-node-id="_files:files"');
        expect(html).toContain('class="nav-item open" data-node-id="_files:files/ts"');
        expect(html).toContain('class="nav-item" data-node-id="_files:files/md"');
        expect(html).toContain('data-file-folder aria-expanded="true" title="files/ts"');
        expect(html).toContain(
            'href="/_files/file/files%2Fts%2Fa%2520.ts" title="files/ts/a%20.ts" aria-current="page"',
        );
        expect(html.indexOf('title="files/ts/z.ts"')).toBeLessThan(
            html.indexOf('title="files/ts/a%20.ts"'),
        );
        expect(html.match(/title="files\/ts\/z.ts"/g)).toHaveLength(1);
        expect(html).toContain('href="/a/b" title="files/md/b.md"');
        expect(html).toContain("&lt;tag&gt; &amp; &quot;name&quot;.txt");
        expect(html).not.toContain("../outside.txt");
        expect(navGroupsHtml("preview", site)).not.toContain("_files:");
    });

    it("a doc icon replaces the book icon at top level and precedes the label below it (wrapped in an img)", () => {
        const site = fixtureSite();
        const icon = '<svg viewBox="0 0 1 1"/>';
        site.entries[0] = { ...(site.entries[0] as Entry), icon };
        site.entries[1] = { ...(site.entries[1] as Entry), icon };
        const html = navGroupsHtml("preview", site);
        expect(html).toContain(
            '<img class="nav-icon doc-icon" alt="" src="data:image/svg+xml;base64,',
        );
        expect(html).toContain('title="B"><span class="doc-icon-frame"');
        expect(html).toContain("--doc-icon:url('data:image/svg+xml;base64,");
    });

    it("lists Markdown filenames in Files with escaped source and a link to the document", () => {
        const site = fixtureSite();
        site.entries[1] = {
            ...entry("b", "a"),
            raw: '---\ntitle: B\n---\n<script>alert("x")</script>\n',
        };
        const nav = navGroupsHtml("edit", site, undefined, "markdown/b.md");
        expect(nav).toContain('href="/_files"');
        const list = resourcesMain(site, "markdown")?.main;
        for (const entry of site.entries) {
            expect(list).toContain(`href="/_files/markdown/${entry.file}"`);
        }
        const detail = resourcesMain(site, "markdown/b.md")?.main;
        expect(detail).toContain("content/b.md");
        expect(detail).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
        expect(detail).not.toContain("<script>");
        expect(detail).toContain('<a href="/b">B</a>');
        expect(resourcesMain(site, "markdown/missing.md")).toBeUndefined();
    });
});

describe("renderDocFile / docQueryResponse (backing `GET /api/doc`)", () => {
    it("renderDocFile: returns the current disk value parsed + rendered (same shape as renderDraft + raw/frontmatter/body)", () => {
        {
            const result = renderDocFile(
                emptySite(),
                "x.md",
                '---\ntitle: "X"\n---\nThis is the body.\n',
            );
            expect(result.raw).toBe('---\ntitle: "X"\n---\nThis is the body.\n');
            expect(result.frontmatter).toEqual({ title: "X" });
            expect(result.body).toBe("This is the body.\n");
            expect(result.html).toContain("This is the body.");
            expect(result.errors).toEqual([]);
            expect(result.toc).toEqual([]);
            expect(result.blockLines).toHaveLength(1);
        }
    });

    it("renderDocFile: marks the article with the doc language (front-matter lang, else the site default)", () => {
        const fm = (extra: string): string => `---\ntitle: "X"${extra}\n---\nBody.\n`;
        expect(renderDocFile(emptySite(), "x.md", fm("")).html).toContain('<article lang="en">');
        expect(renderDocFile(emptySite(), "x.md", fm('\nlang: "ja"')).html).toContain(
            '<article lang="ja">',
        );
    });

    it("docQueryResponse: 400 when the file shape is invalid", () => {
        expect(docQueryResponse(emptySite(), "../etc/passwd")).toEqual({
            status: 400,
            body: { error: "file must be <id>.md" },
        });
        expect(docQueryResponse(emptySite(), 42)).toEqual({
            status: 400,
            body: { error: "file must be <id>.md" },
        });
    });

    it("docQueryResponse: 404 for a well-formed file that is not on disk", () => {
        const res = docQueryResponse(emptySite(), "docs-test-missing-xyz.md");
        expect(res).toEqual({
            status: 404,
            body: { error: "docs-test-missing-xyz.md not found" },
        });
    });
});

// The diff used by edit's doc switching (client-side navigation) — the contract is to return
// only "the parts to replace" so the sidebar isn't rebuilt. The rendering itself
// (renderEntryHtml) reads from disk, so here we check the pure pieces (front-matter fields /
// boot) and the route resolution.
describe("editorBoot / pageDataResponse (backing `GET /api/page`)", () => {
    const docSite = (): Site => ({
        entries: [
            {
                id: "a",
                file: "a.md",
                frontmatter: { title: "A" },
                lang: "en",
                body: "Body\n",
                toc: [],
                blockLines: [0],
                raw: '---\ntitle: "A"\n---\nBody\n',
                blocks: [],
                errors: [],
            },
        ],
        ctx: {
            figures: new Map([
                ["fig-x", { name: "fig-x", file: "fig-x.svg", kind: "svg" as const, markup: "" }],
            ]),
            terms: [{ id: "term-id", name: "Term", definition: "Definition" }],
        },
        errors: [],
        languages: BUILTIN_LANGUAGES,
        defaultLang: "en",
    });

    it("editorBoot: carries the save key / doc id and completion candidates (figures, docs, terms)", () => {
        const site = docSite();
        const entry = site.entries[0] as Entry;
        expect(editorBoot(entry, site)).toEqual({
            file: "a.md",
            docId: "a",
            title: "A",
            path: "/a",
            body: "Body\n",
            figures: ["fig-x.svg"],
            codeLanguages: CODE_LANGS,
            docs: [{ ref: "a", title: "A" }],
            terms: [{ id: "term-id", name: "Term", definition: "Definition" }],
            blockLines: [0],
            baseRaw: '---\ntitle: "A"\n---\nBody\n',
            icon: null,
            defaultLang: "en",
            spellcheckLang: "en",
            filePreviews: {},
        });
    });

    it("lists every ISO language and marks translations for this document", () => {
        const html = languageFieldHtml("jpn", "deu", ["jpn", "eng"]);
        expect(html.match(/<option /g)).toHaveLength(contentLanguages.length);
        expect(html).toContain('value="eng" data-name="English" data-added="true">English (eng)');
        expect(html).toContain(
            'value="deu" data-name="German" data-added="false" selected>German (deu)',
        );
        expect(html).toContain('data-source="jpn"');
        const existing = languageFieldHtml("jpn", "eng", ["jpn", "eng"]);
        expect(existing).toContain(
            'value="eng" data-name="English" data-added="true" selected>English (eng)',
        );
    });

    it("editorBoot: spellcheck language comes from the doc language's adapter, else the tag", () => {
        const site = docSite();
        const entry = site.entries[0] as Entry;
        // ja: browsers don't spellcheck Japanese, so the adapter checks the English words.
        expect(editorBoot({ ...entry, lang: "ja-JP" }, site).spellcheckLang).toBe("en");
        expect(editorBoot({ ...entry, lang: "de" }, site).spellcheckLang).toBe("de");
    });

    it("carries the site title across navigation and escapes it in published HTML", () => {
        const site = { ...docSite(), title: '資料 & "API" <guide>' };
        expect(pageDataResponse(site, "/a")).toMatchObject({
            status: 200,
            body: { title: `A — ${site.title}`, boot: { siteTitle: site.title } },
        });
        const html = publishHtml(site, "");
        expect(html).toContain(
            '<div id="site-title" class="site-title" title="資料 &amp; &quot;API&quot; &lt;guide&gt;">資料 &amp; &quot;API&quot; &lt;guide&gt;</div>',
        );
        expect(html).toContain('data-title="A — 資料 &amp; &quot;API&quot; &lt;guide&gt;"');
        expect(html).not.toContain("crumb-");
        expect(publishHtml(docSite(), "")).toContain('class="site-title" title="dooc">dooc</div>');
    });

    it("pageDataResponse: 404 when not a doc route (the caller falls back to normal navigation)", () => {
        const site = docSite();
        expect(pageDataResponse(site, "/missing").status).toBe(404);
        expect(pageDataResponse(site, "/dev/a").status).toBe(404);
    });

    it("pageDataResponse: 400 when the route shape is invalid", () => {
        expect(pageDataResponse(docSite(), "a")).toEqual({
            status: 400,
            body: { error: "route must be /<docId>" },
        });
        expect(pageDataResponse(docSite(), null).status).toBe(400);
    });
});

describe("createBundleCache (client bundle + ETag)", () => {
    it("caches the same entry without re-running build", async () => {
        const cache = createBundleCache();
        let calls = 0;
        const build = async (): Promise<string> => {
            calls += 1;
            return `js-${calls}`;
        };
        const a = await cache.get("x", build);
        const b = await cache.get("x", build);
        expect(calls).toBe(1);
        expect(b).toBe(a);
        expect(a.etag).toMatch(/^"[0-9a-f]{64}"$/);
    });

    it("re-runs after clear() (equivalent to invalidating on a watchProject kind:client notification)", async () => {
        const cache = createBundleCache();
        let calls = 0;
        const build = async (): Promise<string> => {
            calls += 1;
            return `js-${calls}`;
        };
        await cache.get("x", build);
        cache.clear();
        const second = await cache.get("x", build);
        expect(calls).toBe(2);
        expect(second.js).toBe("js-2");
    });

    it("different entries get separate caches (graph.js / edit.js are independent)", async () => {
        const cache = createBundleCache();
        const a = await cache.get("a", async () => "js-a");
        const b = await cache.get("b", async () => "js-b");
        expect(a.js).toBe("js-a");
        expect(b.js).toBe("js-b");
        expect(a.etag).not.toBe(b.etag);
    });
});

describe("publishHtml (a single HTML file with everything embedded)", () => {
    const site = siteFrom(compileSite(new URL("../../sample-content", import.meta.url).pathname));
    const html = publishHtml(site, "window.graph = '</script>';");

    it("uses the compiled manifest title for the site header and browser tab", () => {
        expect(site.title).toBe("dooc");
        expect(html).toContain("<title>dooc</title>");
        expect(html).toContain('class="site-title" title="dooc">dooc</div>');
    });

    it("lists terms under Files, with sorting only on the list page", () => {
        const nav = navGroupsHtml("edit", site, undefined);
        expect(nav).toContain('href="/_files"');
        const list = resourcesMain(site, "terms")?.main ?? "";
        for (const term of site.ctx.terms)
            expect(list).toContain(`id="term-${encodeURIComponent(term.id)}"`);
        expect(list).toContain("data-dict-sort");
        const detail = resourcesMain(site, "terms/terms%2Fdocs-root.termth")?.main ?? "";
        expect(detail).toContain("[](terms/docs-root.termth)");
        expect(detail).toContain("資料の入力フォルダー。");
        expect(detail).not.toContain("data-dict-sort");
        expect(html.match(/<select data-dict-sort/g)).toHaveLength(1);
        expect(html).toContain('<template data-route="_files/terms"');
        expect(html).toContain('href="#/_files/terms#term-terms%252Fdocs-root.termth"');
        expect(list).toContain('href="/_files/terms#term-terms%252Fdocs-root.termth"');
        expect(resourcesMain(site, "terms/missing")).toBeUndefined();
    });

    it.each([
        ["jpn", "目次"],
        ["eng", "Contents"],
        ["zho", "目录"],
    ])("localizes Contents in %s articles, including exported HTML", (locale, title) => {
        const root = mkdtempSync(join(tmpdir(), "docs-contents-"));
        try {
            const body = "## First\n\nText.\n\n## Second\n\nText.\n";
            mkdirSync(join(root, "content"));
            writeFileSync(join(root, "manifest.yaml"), "- article\n");
            writeFileSync(
                join(root, "content/article.md"),
                assembleDoc({ title: "Article" }, body),
            );
            if (locale !== "jpn") {
                writeCatalog(root, locale, { article: { title: "Article", body } });
            }
            const compiled = compileSite(root, { defaultLang: "jpn", locale });
            expect(compiled.errors).toEqual([]);
            const localized = siteFrom(compiled);
            const entry = localized.entries[0];
            if (!entry) throw new Error("Missing article");
            expect(entry.lang).toBe(locale);
            const rendered = renderDocFile(localized, entry.file, entry.raw);
            expect(rendered.html).toContain(`data-section-url="/article?lang=${locale}#first"`);
            expect(publishHtml(localized, "")).toContain(
                `data-section-url="#/article?lang=${locale}#second"`,
            );
            for (const output of [rendered.html, publishHtml(localized, "")]) {
                expect(output).toContain(`class="in-toc-title">${title}</div>`);
                expect(output).toContain(`class="in-toc" aria-label="${title}"`);
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("holds every doc as a template, with links as hash routes", () => {
        for (const e of site.entries) {
            expect(html).toContain(
                `<template data-route="${docPath(site.entries, e.id).slice(1)}"`,
            );
        }
        expect(html).toContain('href="#/guide/writing"');
        expect(html).not.toMatch(/href="\/(?!\/)/);
    });

    it("a doc with an empty body and children shows the list of children instead of a body", () => {
        const emptyGuide = {
            ...site,
            entries: site.entries.map((entry) =>
                entry.id === "guide" ? { ...entry, body: "", blocks: [], toc: [] } : entry,
            ),
        };
        const output = publishHtml(emptyGuide, "");
        const guide =
            /<template data-route="guide"[^>]*>(.*?)<\/template>/s.exec(output)?.[1] ?? "";
        expect(guide).toContain('<ul class="idx"><li><a href="#/guide/writing">書き方</a>');
    });

    it("has no server-provided scripts (graph bundle is inlined, </script> is escaped)", () => {
        expect(html).not.toContain("/assets/");
        expect(html).not.toContain("EventSource");
        expect(html).toContain("window.graph = '<\\/script>';");
    });
});
