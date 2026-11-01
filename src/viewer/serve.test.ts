import { describe, expect, it } from "vitest";
import { compileSite } from "../compiler/compile.js";
import { parseDoc } from "../compiler/dialect.js";
import { docPath } from "../core/routing.js";
import { BUILTIN_LANGUAGES } from "./languages.js";
import {
    assembleDoc,
    createBundleCache,
    docQueryResponse,
    type Entry,
    editorBoot,
    fmFieldsHtml,
    isExternallyModified,
    navGroupsHtml,
    pageDataResponse,
    publishHtml,
    renderDocFile,
    resolveContentFile,
    type Site,
    sanitizeFrontmatter,
    siteFrom,
} from "./serve.js";

const emptySite = (): Site => ({
    entries: [],
    ctx: { figures: new Map(), dictionary: [] },
    errors: [],
    languages: BUILTIN_LANGUAGES,
    defaultLang: "en",
});

describe("assembleDoc", () => {
    it("serializes front-matter in hand-written style (key order = title / tags / description / lang)", () => {
        const raw = assembleDoc(
            { lang: "ja", title: "Overview", tags: ["intro"], description: "Description" },
            "Body.",
        );
        expect(raw).toBe(
            '---\ntitle: "Overview"\ntags: ["intro"]\ndescription: "Description"\nlang: "ja"\n---\n\nBody.\n',
        );
    });

    it("round-trip preserves frontmatter / body (parseDoc reads it back without errors)", () => {
        const fm = { title: "x", tags: ["a", "b"] };
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
                description: "",
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
        ctx: { figures: new Map(), dictionary: [] },
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
        expect(html).toContain(
            '<a class="nav-tree-link cur" href="/a/b/c" title="C"><span class="nav-label">C</span></a>',
        );
        // Only docs with children get an open/close toggle; only the branch containing the
        // current doc is open by default
        expect(html.match(/nav-tree-toggle/g)).toHaveLength(2);
        expect(html).toContain('<div class="nav-item" data-doc-id="d">');
    });

    it("edit mode adds draggable rows and add-child buttons without drag handles", () => {
        const edit = navGroupsHtml("edit", fixtureSite(), undefined);
        expect(edit).toContain('draggable="true"');
        expect(edit).not.toContain("drag-handle");
        expect(edit).toContain('class="new" type="button" data-parent="b"');
        const preview = navGroupsHtml("preview", fixtureSite(), undefined);
        expect(preview).not.toContain("draggable");
        expect(preview).not.toContain("drag-handle");
        expect(preview).not.toContain('class="new"');
    });

    it("keeps child pages directly after their parent row in edit mode", () => {
        const html = navGroupsHtml("edit", fixtureSite(), "a");
        expect(html).toContain('</button></div><div class="nav-list nav-tree" data-parent="a"');
        expect(html).not.toContain("nav-toc");
        expect(html).not.toContain("Heading");
    });

    it("with no docs, only an empty root list", () => {
        expect(navGroupsHtml("preview", emptySite(), undefined)).toBe(
            '<div class="nav-list nav-root" data-parent=""></div>',
        );
    });

    it("the Resources section is edit-only (index › kind › individual file), with the current branch open", () => {
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
                dictionary: [],
            },
        };
        expect(navGroupsHtml("preview", site)).not.toContain("nav-resources");
        const html = navGroupsHtml("edit", site, undefined, "figures/x.svg");
        expect(html).toContain('<div class="nav-item open" data-node-id="_res">');
        expect(html).toContain('<div class="nav-item open" data-node-id="_res:figures">');
        expect(html).toContain('<a class="nav-tree-link cur" href="/_resources/figures/x.svg"');
        expect(html).toContain('href="/_resources/icons"');
        expect(html).not.toContain("/_resources/presentations");
        expect(html).toContain('href="/_resources/html/widget.html"');
        expect(html).not.toContain('href="/_resources/figures/widget.html"');
        const selected = navGroupsHtml("edit", site, undefined, "html/widget.html");
        expect(selected).toContain('<div class="nav-item open" data-node-id="_res:html">');
        expect(selected).toContain(
            '<a class="nav-tree-link cur" href="/_resources/html/widget.html"',
        );
        expect(selected).not.toContain('<div class="nav-item open" data-node-id="_res:figures">');
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
        expect(html).toContain('title="B"><img class="doc-icon"');
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
describe("fmFieldsHtml / editorBoot / pageDataResponse (backing `GET /api/page`)", () => {
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
            dictionary: [{ term: "Term", reading: "term", definition: "Definition" }],
        },
        errors: [],
        languages: BUILTIN_LANGUAGES,
        defaultLang: "en",
    });

    it("fmFieldsHtml: fills the title / tags / description / lang fields with the current values", () => {
        const html = fmFieldsHtml({ title: "A", tags: ["t1", "t2"] }, "en");
        expect(html).toContain('id="fm-title"');
        expect(html).toContain('value="A"');
        expect(html).toContain('value="t1, t2"');
        // An empty lang field shows the site default as its placeholder.
        expect(html).toContain('id="fm-lang" value="" placeholder="en"');
        expect(fmFieldsHtml({ title: "A", lang: "ja" })).toContain('id="fm-lang" value="ja"');
    });

    it("editorBoot: carries the save key / doc id and completion candidates (figures, docs, terms)", () => {
        const site = docSite();
        const entry = site.entries[0] as Entry;
        expect(editorBoot(entry, site)).toEqual({
            file: "a.md",
            docId: "a",
            path: "/a",
            body: "Body\n",
            figures: ["fig-x.svg"],
            docs: [{ ref: "a", title: "A" }],
            terms: ["Term"],
            blockLines: [0],
            baseRaw: '---\ntitle: "A"\n---\nBody\n',
            icon: null,
            defaultLang: "en",
            spellcheckLang: "en",
        });
    });

    it("editorBoot: spellcheck language comes from the doc language's adapter, else the tag", () => {
        const site = docSite();
        const entry = site.entries[0] as Entry;
        // ja: browsers don't spellcheck Japanese, so the adapter checks the English words.
        expect(editorBoot({ ...entry, lang: "ja-JP" }, site).spellcheckLang).toBe("en");
        expect(editorBoot({ ...entry, lang: "de" }, site).spellcheckLang).toBe("de");
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
        expect(guide).toContain(
            '<ul class="idx"><li><a href="#/guide/getting-started">はじめに</a>',
        );
    });

    it("has no server-provided scripts (graph bundle is inlined, </script> is escaped)", () => {
        expect(html).not.toContain("/assets/");
        expect(html).not.toContain("EventSource");
        expect(html).toContain("window.graph = '<\\/script>';");
    });
});
