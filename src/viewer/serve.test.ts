import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileSite } from "../compiler/compile.js";
import { parseDoc } from "../compiler/dialect.js";
import { contentLanguages } from "../compiler/language-codes.js";
import { writeTextfile } from "../compiler/textfile.js";
import { docPath } from "../core/routing.js";
import { CODE_LANGS } from "../core/taxonomy.js";
import { BUILTIN_LANGUAGES } from "./languages.js";
import {
    assembleDoc,
    createBundleCache,
    docQueryResponse,
    type Entry,
    editorBoot,
    filePreviewResults,
    isExternallyModified,
    languageFieldHtml,
    navGroupsHtml,
    pageDataResponse,
    publishHtml,
    renderDocFile,
    renderEntryHtml,
    resolveContentFile,
    resourcesMain,
    type Site,
    sanitizeFrontmatter,
    siteFrom,
    textfilePreviewErrors,
    textfilePreviewHtml,
} from "./serve.js";

const emptySite = (): Site => ({
    entries: [],
    ctx: { figures: new Map(), terms: [] },
    errors: [],
    languages: BUILTIN_LANGUAGES,
    defaultLang: "en",
});

it("starts each resource library view with tabs without repeating the Git branch heading", () => {
    const site: Site = {
        ...emptySite(),
        workspace: { protocol: "git", branch: "main" },
        filePaths: [],
    };
    expect(resourcesMain(site, "")?.main).not.toContain("resource-tabs");
    for (const view of ["dictionary", "code", "urls"]) {
        const html = resourcesMain(site, view)?.main ?? "";
        expect(html).toMatch(/^<article[^>]+><nav class="resource-tabs"/);
        expect(html).not.toContain("<h1");
    }
    expect(navGroupsHtml("edit", site)).toContain('data-workspace-protocol="git"');
});

it("checks the same table and semantic parsers used to generate file previews", () => {
    const site = emptySite();
    expect(textfilePreviewErrors(site, "ok.csv", "Name,Value\nA,1\n")).toEqual([]);
    expect(textfilePreviewErrors(site, "bad.csv", 'Name,Value\n"broken')).toEqual([
        "Unclosed quoted field",
    ]);
    expect(textfilePreviewErrors(site, "bad.termth", "name: Incomplete\n").join()).toContain(
        "definition",
    );
    expect(textfilePreviewErrors(site, "source.ts", "const x = 1;\n")).toEqual([]);
});

it("previews CSV as literal sortable data without assuming a header", () => {
    const html = textfilePreviewHtml(
        emptySite(),
        "data.csv",
        '\uFEFFName,Value\n"**raw**",2\n"<script>bad</script>",10\n',
    );
    expect(html).toContain('data-table-source="data.csv"');
    expect(html).toContain('data-table-mode="data"');
    expect(html).toContain('<th scope="row">1</th><td>Name</td><td>Value</td>');
    expect(html).not.toContain("data-table-header");
    expect(html).not.toContain("data-table-toolbar");
    expect(html).toContain("<template data-table-rows>[[&quot;Name&quot;,&quot;Value&quot;]");
    expect(html).toContain("[&quot;**raw**&quot;,&quot;2&quot;]");
    expect(html).not.toContain("<strong>raw</strong>");
    expect(html).not.toContain("<script>bad</script>");
    expect(textfilePreviewHtml(emptySite(), "bad.csv", 'a,b\n"broken')).toContain('role="status"');
    expect(textfilePreviewHtml(emptySite(), "code.ts", 'const value = "<tag>";')).toContain(
        "&lt;tag&gt;",
    );
});

it("keeps quoted source files, emphasis and references through compilation and publication", () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-quotes-"));
    try {
        mkdirSync(join(root, "content"));
        mkdirSync(join(root, "figures"));
        writeFileSync(join(root, "dooc.yaml"), "docs: [guide]\n");
        writeFileSync(join(root, "source.ts"), "const one = 1;\nconst two = 2;\n");
        writeFileSync(join(root, "api.termth"), "name: API\ndefinition: Interface\n");
        writeFileSync(
            join(root, "figures/chart.svg"),
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Chart</title></svg>',
        );
        const body =
            "> ## **Quoted** *heading*\n>\n> [**API**](api.termth) and [*chart*](figures/chart.svg)\n>\n> ![](source.ts#L2)\n>\n> ![](figures/chart.svg)\n\n- > ![](source.ts#L2)\n\n## Quoted heading\n";
        writeFileSync(join(root, "content/guide.md"), `---\ntitle: Guide\n---\n\n${body}`);
        const compiled = compileSite(root);
        expect(compiled.errors).toEqual([]);
        expect(compiled.docs[0]?.body).toBe(body);
        expect(compiled.docs[0]?.refs).toEqual({
            figures: ["chart"],
            terms: ["api.termth"],
        });
        expect(compiled.docs[0]?.toc.map((heading) => heading.slug)).toEqual([
            "quoted-heading",
            "quoted-heading-1",
        ]);
        const site = siteFrom(compiled);
        const entry = site.entries[0];
        if (!entry) throw new Error("Missing document");
        expect(filePreviewResults(entry, site)).toEqual({
            "source.ts": [],
            "figures/chart.svg": [],
            "api.termth": [],
        });
        const rendered = renderEntryHtml(site, entry).html;
        expect(rendered).toContain("<blockquote>");
        expect(rendered).toContain("<strong>API</strong>");
        expect(rendered).toContain("const two = 2;");
        expect(rendered.match(/const two = 2;/g)).toHaveLength(2);
        expect(rendered).not.toContain("const one = 1;");
        expect(publishHtml(site, "")).toContain(
            '<h2 id="quoted-heading"><strong>Quoted</strong> <em>heading</em>',
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it("resolves source-file links and heading fragments in the viewer, exported HTML, and completion data", () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-file-links-"));
    try {
        mkdirSync(join(root, "content"));
        mkdirSync(join(root, "files/md"), { recursive: true });
        const file = "files/md/A (guide).md";
        writeFileSync(
            join(root, "dooc.yaml"),
            `files:\n  documents:\n    child: ${file}\ndocs:\n  - guide:\n    - child\n`,
        );
        writeFileSync(
            join(root, "content/guide.md"),
            `---\ntitle: Guide\n---\n\n[Child](<${file}#details>)\n\n~~~callouth More\n[Child](<${file}#details>)\n~~~\n\n~~~md\n[Example](content/missing.md)\n~~~\n`,
        );
        writeFileSync(join(root, file), "---\ntitle: Child\n---\n\n## Details\n");
        const compiled = compileSite(root);
        expect(compiled.errors).toEqual([]);
        const site = siteFrom(compiled);
        const guide = site.entries[0];
        if (!guide) throw new Error("Missing guide");
        expect(
            renderEntryHtml(site, guide).html.match(/href="\/guide\/child#details"/g),
        ).toHaveLength(2);
        expect(publishHtml(site, "")).toContain('href="#/guide/child#details"');
        expect(editorBoot(guide, site).docs).toContainEqual({ ref: file, title: "Child" });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it("opens linked SVG files in the viewer and standalone HTML, including extracted callouts", () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-figure-links-"));
    try {
        mkdirSync(join(root, "content"));
        mkdirSync(join(root, "assets"));
        const file = "assets/My (chart).svg";
        writeFileSync(join(root, "dooc.yaml"), "docs: [guide]\n");
        writeFileSync(
            join(root, file),
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Chart</title></svg>',
        );
        writeFileSync(join(root, "note.callouth"), `[Chart](<${file}>)\n`);
        writeFileSync(
            join(root, "content/guide.md"),
            `---\ntitle: Guide\n---\n\n[Chart](<${file}>)\n\n![](note.callouth)\n\nFig.chart\n`,
        );
        const compiled = compileSite(root);
        expect(compiled.errors).toEqual([]);
        const site = siteFrom(compiled);
        const guide = site.entries[0];
        if (!guide) throw new Error("Missing guide");
        const route = `_files/file/${encodeURIComponent(file)}`;
        const rendered = renderEntryHtml(site, guide).html;
        expect(rendered.match(/class="figref"/g)).toHaveLength(2);
        expect(rendered).toContain(`href="/${route}"`);
        expect(rendered).toContain("<p>Fig.chart</p>");
        expect(resourcesMain(site, route.slice("_files/".length))?.main).toContain(
            '<iframe class="fig-frame',
        );
        const published = publishHtml(site, "");
        expect(published).toContain(`href="#/${route}"`);
        expect(published).toContain(`<template data-route="${route}"`);
        expect(published).toContain('sandbox=""');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
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
        expect(edit.match(/class="nav-tree-toggle"/g)).toHaveLength(2);
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
        expect(edit).not.toContain('<span class="nav-label">...</span>');
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
        expect(html).toContain('id="nav-docs"');
        expect(html).not.toContain('id="nav-docs-resize"');
        expect(html).not.toContain('id="files-resize"');
        expect(html).toContain('data-node-id="_files"');
        expect(html).not.toContain('class="nav-files-actions"');
        expect(html).not.toContain('class="files-upload"');
        expect(html).toContain('class="files-drop-hint"');
        expect(html).toContain('class="nav-link cur" href="/_files"');
        expect(html).toContain('data-i18n="Files">Files');
        expect(resourcesMain(site, "")?.main).toContain('id="files-manager"');
        expect(resourcesMain(site, "figures/x.svg")?.main).toContain("<iframe");
        expect(resourcesMain(site, "html/widget.html")?.main).toContain("Widget");
    });

    it("groups Files and Statics below the workspace location in one resizable area", () => {
        const site = fixtureSite();
        site.filePaths = ["files/ts/a.ts", "notes/draft.txt"];
        const html = navGroupsHtml("edit", site, undefined, "file/files%2Fts%2Fa.ts");
        const card = html.slice(html.indexOf('<section id="nav-tools"'));
        expect(card.match(/href="\/_files"/g)).toHaveLength(1);
        expect(card).toContain('class="nav-link cur"');
        expect(card).not.toContain('class="nav-list');
        expect(card).not.toContain("nav-tree-toggle");
        expect(card).not.toContain("files/ts");
        expect(card).not.toContain("notes/draft.txt");
        expect(card).toContain('class="files-drop-hint"');
        expect(html).not.toContain("nav-docs-resize");
        expect(card).toContain('id="tools-resize" role="separator"');
        expect(card).toContain('id="nav-storage"');
        expect(card).toContain('id="nav-statics"');
        expect(card.indexOf('id="nav-storage"')).toBeLessThan(card.indexOf('id="nav-files"'));
        expect(resourcesMain(site, "")?.main).toContain('id="files-manager"');
    });

    it("shows a passive repository address and Git controls below Files and Statics", () => {
        const site = fixtureSite();
        site.workspace = { protocol: "git", repo: "my<repo>", branch: 'docs/<topic>&"' };
        const label = "docs/&lt;topic&gt;&amp;&quot;";
        const nav = navGroupsHtml("edit", site);
        expect(nav).toContain('data-workspace-protocol="git"');
        expect(nav).toContain('<span class="git-repo-name">my&lt;repo&gt;</span>');
        expect(nav).toContain(`<span class="git-branch-caption">[${label}]</span>`);
        const address = nav.match(/<div class="workspace-location"[^>]*>.*?<\/div>/)?.[0];
        expect(address).toBeDefined();
        expect(address).not.toMatch(/<button|<a |tabindex|aria-haspopup/);
        expect(nav).not.toContain("data-git-branch");
        expect(nav.indexOf('id="nav-files"')).toBeLessThan(nav.indexOf('id="nav-statics"'));
        expect(nav.indexOf('id="nav-statics"')).toBeLessThan(nav.indexOf('id="nav-git"'));
        expect(nav).toContain('data-i18n="Files"');
        expect(resourcesMain(site, "")?.title).toBe("Files");
        expect(resourcesMain(site, "")?.main).not.toContain(label);
        expect(resourcesMain(site, "markdown/b.md")?.main).not.toContain(label);
        expect(resourcesMain(site, "_git")?.main).toContain('id="git-manager"');
        expect(pageDataResponse(site, "/_git").status).toBe(200);
        expect(navGroupsHtml("edit", site, undefined, "_git")).toContain(
            'class="nav-link cur" href="/_git"',
        );
        expect(navGroupsHtml("edit", site, undefined, "_git")).not.toContain(
            'class="nav-link cur" href="/_files"',
        );
        site.workspace.branch = "Files";
        expect(navGroupsHtml("edit", site)).toContain("[Files]</span>");
        site.workspace = { protocol: "storage", folder: "docs", service: "Local" };
        expect(resourcesMain(site, "_git")).toBeUndefined();
        expect(navGroupsHtml("edit", site)).not.toContain('id="nav-git"');
        expect(navGroupsHtml("edit", site)).not.toContain('href="/_git"');
    });

    it("uses the injected storage folder, service and an isolated SVG image", () => {
        const site = fixtureSite();
        const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
        site.workspace = {
            protocol: "storage",
            folder: "team/<docs>",
            service: "Object & store",
            icon: svg,
        };
        const nav = navGroupsHtml("edit", site);
        expect(nav).toContain('data-workspace-protocol="storage"');
        expect(nav).toContain("team/&lt;docs&gt; / Object &amp; store");
        expect(nav).toContain(
            'class="nav-icon workspace-icon" alt="" src="data:image/svg+xml;base64,',
        );
        expect(nav).toContain(Buffer.from(svg).toString("base64"));
        expect(nav).not.toContain("<script>alert(1)</script>");
        expect(resourcesMain(site, "")?.title).toBe("team/<docs> / Object & store");
    });

    it("keeps statics routes and navigation separate from the file manager", () => {
        const site = fixtureSite();
        site.filePaths = [];
        expect(resourcesMain(site, "")?.main).not.toContain("Dictionary");
        for (const path of ["/_statics", "/_statics/code", "/_statics/urls"]) {
            const page = pageDataResponse(site, path);
            expect(page.status).toBe(200);
            expect(page.body).toMatchObject({
                resource: true,
                path,
                html: expect.stringContaining("resource-tabs"),
            });
            expect(JSON.stringify(page.body)).not.toContain("files-manager");
        }
        const nav = navGroupsHtml("edit", site, undefined, "_statics/code");
        expect(nav).toContain('class="nav-link cur" href="/_statics"');
        expect(nav).not.toContain('class="nav-link cur" href="/_files"');
        expect(resourcesMain(site, "_statics/file/anything")).toBeUndefined();
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
            gitBase: null,
            file: "a.md",
            docId: "a",
            title: "A",
            path: "/a",
            body: "Body\n",
            figures: ["fig-x.svg"],
            codeLanguages: CODE_LANGS,
            docs: [{ ref: "content/a.md", title: "A" }],
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
        expect(html).toContain("data-language-open");
        expect(html).toContain('aria-controls="fm-lang-options"');
        const existing = languageFieldHtml("jpn", "eng", ["jpn", "eng"]);
        expect(existing).toContain(
            'value="eng" data-name="English" data-added="true" selected>English (eng)',
        );
    });

    it("offers only declared site languages while keeping missing translations available to create", () => {
        const html = languageFieldHtml("jpn", "jpn", ["jpn"], ["jpn", "eng"]);
        expect(html.match(/<option /g)).toHaveLength(2);
        expect(html).toContain('value="eng" data-name="English" data-added="false"');
        expect(html).not.toContain('value="fra"');
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

    it("returns file views without replacing the document editor's boot state", () => {
        const result = pageDataResponse(docSite(), "/_files");
        expect(result).toMatchObject({
            status: 200,
            body: { resource: true, path: "/_files" },
        });
        expect(result.body).not.toHaveProperty("boot");
        expect(result.body).toHaveProperty("html", expect.stringContaining('id="files-manager"'));
        expect(pageDataResponse(docSite(), "/_files/markdown/a.md")).toMatchObject({
            status: 200,
            body: { resource: true, path: "/_files/markdown/a.md", sourceFile: "content/a.md" },
        });
        expect(pageDataResponse(docSite(), "/_files/missing").status).toBe(404);
        expect(pageDataResponse(docSite(), "/_files/file/%ZZ").status).toBe(400);
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
    const site = siteFrom(compileSite(new URL("../../sample", import.meta.url).pathname));
    const html = publishHtml(site, "window.graph = '</script>';");

    it("includes font selection without font registration in standalone viewers", () => {
        expect(html).toContain('data-font-picker="viewer"');
        expect(html).not.toContain('data-font-picker="editor"');
        expect(html).not.toContain("indexedDB.open");
        expect(html).not.toContain("Add font file");
        expect(html).toContain("--viewer-font");
        expect(html).toContain('<button class="pbtn font-control"');
        expect(html).not.toContain('class="font-select"');
    });

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
        const detail =
            resourcesMain(site, "terms/contents%2Ftermth%2Fworkspace.termth")?.main ?? "";
        expect(detail).toContain("[](contents/termth/workspace.termth)");
        expect(detail).toContain(
            "A folder containing Markdown documents, supporting files, and a navigation manifest.",
        );
        expect(detail).not.toContain("data-dict-sort");
        expect(html.match(/<select data-dict-sort/g)).toHaveLength(1);
        expect(html).toContain('<template data-route="_files/terms"');
        expect(html).toContain(
            'href="#/_files/terms#term-contents%252Ftermth%252Fworkspace.termth"',
        );
        expect(list).toContain(
            'href="/_files/terms#term-contents%252Ftermth%252Fworkspace.termth"',
        );
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
            writeFileSync(join(root, "dooc.yaml"), "- article\n");
            writeFileSync(
                join(root, "content/article.md"),
                assembleDoc({ title: "Article" }, body),
            );
            if (locale !== "jpn") {
                writeTextfile(
                    root,
                    `locales/${locale}/content/article.md`,
                    assembleDoc({ title: "Article" }, body),
                    null,
                );
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
                expect(output).not.toContain('class="in-toc-title"');
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
        expect(html).toContain('href="#/guide/previews"');
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
            '<ul class="idx"><li><a href="#/guide/previews">File preview gallery</a>',
        );
    });

    it("has no server-provided scripts (graph bundle is inlined, </script> is escaped)", () => {
        expect(html).not.toContain("/assets/");
        expect(html).not.toContain("EventSource");
        expect(html).toContain("window.graph = '<\\/script>';");
    });
});

it("renders Mermaid sources safely in published HTML", () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-diagrams-"));
    try {
        mkdirSync(join(root, "content"));
        writeFileSync(join(root, "dooc.yaml"), "docs: [guide]\n");
        const source =
            '---\ntitle: Diagrams\n---\n\n```mermaid\nflowchart LR\n A["<script>alert(1)</script>"] --> B\n```\n\nVisible text\n';
        writeFileSync(join(root, "content/guide.md"), source);
        const compiled = compileSite(root);
        expect(compiled.errors).toEqual([]);
        const html = publishHtml(siteFrom(compiled), "/* diagrams */");
        expect(html).toContain('data-mermaid="pending"');
        expect(html).toContain("&lt;script&gt;");
        expect(html).not.toContain("<script>alert(1)</script>");
        expect(html).toContain("Visible text");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it("opens Plugins through full-page and client navigation and marks only its sidebar card", () => {
    const site = emptySite();
    expect(resourcesMain(site, "_extensions")?.title).toBe("Plugins");
    expect(resourcesMain(site, "_extensions")?.main).toContain('id="extensions-manager"');
    expect(pageDataResponse(site, "/_extensions")).toMatchObject({
        status: 200,
        body: { resource: true, path: "/_extensions" },
    });
    const nav = navGroupsHtml("edit", site, undefined, "_extensions");
    expect(nav).toContain('class="nav-link cur" href="/_extensions"');
    expect(nav).not.toContain('class="nav-link cur" href="/_files"');
    expect(nav).not.toMatch(/extensions-upload|extensions-status|nav-count|Add ZIP/);
    expect(nav).toContain('class="extensions-drop-hint"');
});
