import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
    navGroupsHtml,
    pageDataResponse,
    publishHtml,
    siteFrom,
} from "../../../server/src/serve.js";
import { parseManifest, serializeManifest } from "../core/content-metadata.js";
import { fileDocumentId } from "../core/files.js";
import { docHref, docPath } from "../core/routing.js";
import { compileDraft, compileSite, createCompiler } from "./compile.js";
import { exportEntries } from "./export.js";
import { filesSnapshot, updateFiles } from "./files.js";
import { translationFiles } from "./locales.js";
import { readManifest } from "./manifest.js";
import { createDocOps } from "./ops.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = (document: object = {}) => {
    const root = mkdtempSync(join(tmpdir(), "dooc-document-"));
    roots.push(root);
    const write = (file: string, content: string) => {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), content);
    };
    write("dooc.yaml", stringify({ document }));
    return { root, write };
};

it("always renders a root, with an index when its URL is empty or missing", () => {
    for (const url of [undefined, "", null]) {
        const { root, write } = fixture({
            title: "Handbook",
            url,
            children: [{ document: { url: "guide.md" } }],
        });
        write("guide.md", "Guide body\n");
        const compiled = compileSite(root);
        expect(compiled.errors).toEqual([]);
        const site = siteFrom(compiled);
        expect(site.entries.map((entry) => docPath(site.entries, entry.id))).toEqual([
            "/",
            "/guide",
        ]);
        const page = pageDataResponse(site, "/");
        expect(page).toMatchObject({ status: 200, body: { resource: true, path: "/" } });
        expect((page.body as { html: string }).html).toContain('href="/guide"');
        expect(publishHtml(site, "")).toContain('<template data-route=""');
        expect(navGroupsHtml("edit", site)).toContain('href="/"');
    }
    const { root } = fixture();
    expect(compileSite(root).errors).toEqual([]);
    expect(pageDataResponse(siteFrom(compileSite(root)), "/").status).toBe(200);
});

it("keeps root content editable without adding its file name to descendants", () => {
    const { root, write } = fixture({
        title: "Home",
        url: "cover.md",
        children: [{ document: { url: "guide.md" } }],
    });
    write("cover.md", "Cover\n");
    write("guide.md", "Guide\n");
    const ops = createDocOps(root);
    expect(ops.remove(fileDocumentId("cover.md"))).toMatchObject({ status: 409 });
    expect(ops.move(fileDocumentId("cover.md"), fileDocumentId("guide.md"))).toMatchObject({
        status: 409,
    });
    expect(ops.addFile("more.md", "More")).toHaveProperty("id");
    expect(ops.setTitle(fileDocumentId("guide.md"), "User guide")).toHaveProperty("id");
    const before = readManifest(root);
    expect(parseManifest(parse(serializeManifest(before.tree, before)))).toEqual(before);
    updateFiles(root, {
        action: "rename",
        file: "cover.md",
        name: "home.md",
        revision: filesSnapshot(root).revision,
    });
    const site = siteFrom(compileSite(root));
    expect(docPath(site.entries, fileDocumentId("home.md"))).toBe("/");
    expect(pageDataResponse(site, "/")).toMatchObject({
        status: 200,
        body: { boot: { sourceFile: "home.md" } },
    });
    expect(parse(readFileSync(join(root, "dooc.yaml"), "utf8")).document.url).toBe("home.md");
});

it("shares direct links and explicit first-child redirects with standalone HTML", () => {
    const { root, write } = fixture({
        url: "redirect:first",
        children: [
            { document: { title: "Shortcut", url: "/guide" } },
            { document: { url: "guide.md" } },
            { document: { title: "Website", url: "https://example.com/?a=1&b=2" } },
        ],
    });
    write("guide.md", "Guide\n");
    const compiled = compileSite(root);
    expect(compiled.errors).toEqual([]);
    const site = siteFrom(compiled);
    expect(docHref(site.entries, site.entries[0]?.id ?? "")).toBe("/guide");
    expect(pageDataResponse(site, "/")).toMatchObject({
        status: 200,
        body: { redirect: "/guide" },
    });
    const html = publishHtml(site, "");
    expect(html).toContain('data-redirect="/guide"');
    expect(html).toContain('href="https://example.com/?a=1&amp;b=2"');
    site.contentLanguage = "jpn";
    expect(navGroupsHtml("preview", site)).toContain('href="https://example.com/?a=1&amp;b=2"');
});

it("keeps child translations, embedded editors and exported assets relative to the child manifest", () => {
    const { root, write } = fixture({ children: [{ document: { url: "child/dooc.yaml" } }] });
    write(
        "dooc.yaml",
        stringify({
            system: { languages: ["eng", "jpn"] },
            document: { children: [{ document: { url: "child/dooc.yaml" } }] },
        }),
    );
    write(
        "child/dooc.yaml",
        stringify({ system: { licence: "LICENSE" }, document: { url: "guide.md" } }),
    );
    write("child/LICENSE", "Example licence\n");
    write("child/guide.md", "![](data/example.txt)\n");
    write("child/data/example.txt", "Example\n");
    write("child/locales/jpn/guide.md", "Translated\n\n![](data/example.txt)\n");
    const compiled = compileSite(root, { locale: "jpn" });
    expect(compiled.errors).toEqual([]);
    expect(translationFiles(root)).toEqual(["child/locales/jpn/guide.md"]);
    const response = pageDataResponse(siteFrom(compiled), "/child");
    expect(response.body).toMatchObject({
        boot: {
            origin: "child/dooc.yaml",
            docs: [{ ref: "guide.md" }],
            filePreviews: { "child/data/example.txt": [] },
        },
    });
    expect(exportEntries(root).map(({ name }) => name)).toEqual(
        expect.arrayContaining([
            "child/LICENSE",
            "child/locales/jpn/guide.md",
            "child/data/example.txt",
        ]),
    );
    updateFiles(root, {
        action: "rename",
        file: "child/guide.md",
        name: "start.md",
        revision: filesSnapshot(root).revision,
    });
    expect(translationFiles(root)).toEqual(["child/locales/jpn/start.md"]);
    expect(compileSite(root, { locale: "jpn" }).errors).toEqual([]);
});

it("mounts child manifests, rebases references, watches edits and preserves source files", () => {
    const { root, write } = fixture({
        children: [{ document: { title: "Reference", url: "reference/dooc.yaml" } }],
    });
    write(
        "reference/dooc.yaml",
        stringify({
            document: { url: "index.md", children: [{ document: { url: "install.md" } }] },
        }),
    );
    write("reference/index.md", "[Install](install.md)\n");
    write("reference/install.md", "Install\n");
    const compiler = createCompiler(root);
    const compiled = compiler.compile();
    expect(compiled.errors).toEqual([]);
    const site = siteFrom(compiled);
    expect(site.entries.map((entry) => docPath(site.entries, entry.id))).toEqual([
        "/",
        "/reference",
        "/reference/install",
    ]);
    const response = pageDataResponse(site, "/reference");
    expect((response.body as { html: string }).html).toContain('href="/reference/install"');
    const draft = compileDraft(
        { root, docs: compiled.docs, figures: new Map() },
        "reference/index.md",
        "[Install](install.md)\n",
    );
    expect(draft.source.errors).toEqual([]);
    expect(draft.doc.body).toBe("[Install](install.md)\n");
    const original = readFileSync(join(root, "reference/dooc.yaml"), "utf8");
    expect(createDocOps(root).addFile("local.md", "Local")).toHaveProperty("id");
    expect(readFileSync(join(root, "reference/dooc.yaml"), "utf8")).toBe(original);
    expect(
        parse(readFileSync(join(root, "dooc.yaml"), "utf8")).document.children[0].document,
    ).toEqual({ title: "Reference", url: "reference/dooc.yaml" });
    const exported = exportEntries(root);
    expect(exported.map((entry) => entry.name)).toEqual(
        expect.arrayContaining([
            "dooc.yaml",
            "reference/dooc.yaml",
            "reference/index.md",
            "reference/install.md",
        ]),
    );
    write("reference/dooc.yaml", original.replace("install.md", "another.md"));
    write("reference/index.md", "[Another](another.md)\n");
    write("reference/another.md", "Another\n");
    expect(compiler.compile().errors).toEqual([]);
    expect(compiler.compile().docs.map((doc) => doc.file)).toContain("reference/another.md");
    updateFiles(root, {
        action: "rename",
        file: "reference/another.md",
        name: "renamed.md",
        revision: filesSnapshot(root).revision,
    });
    expect(readFileSync(join(root, "reference/index.md"), "utf8")).toBe("[Another](renamed.md)\n");
    expect(
        parse(readFileSync(join(root, "reference/dooc.yaml"), "utf8")).document.children[0].document
            .url,
    ).toBe("renamed.md");
    expect(compiler.compile().errors).toEqual([]);
    updateFiles(root, {
        action: "move",
        paths: ["reference"],
        directory: "manual",
        revision: filesSnapshot(root).revision,
    });
    expect(compiler.compile().errors).toEqual([]);
    expect(
        parse(readFileSync(join(root, "dooc.yaml"), "utf8")).document.children[0].document.url,
    ).toBe("manual/reference/dooc.yaml");
});

it.each([
    "javascript:alert(1)",
    "data:text/html,bad",
    "//example.com",
    "../outside.md",
    "https://user:secret@example.com",
    "/a/../b",
])("rejects unsafe document URLs: %s", (url) => {
    expect(parseManifest({ document: { url } }).errors.length).toBeGreaterThan(0);
});

it("reports missing redirect targets and cycles without following them", () => {
    const { root, write } = fixture({ url: "redirect:first" });
    expect(readManifest(root).errors.join()).toContain("requires a child");
    write("dooc.yaml", stringify({ document: { url: "/" } }));
    expect(readManifest(root).errors.join()).toContain("Circular document redirect");
    write("dooc.yaml", stringify({ document: { url: "/?lang=eng#top" } }));
    expect(readManifest(root).errors.join()).toContain("Circular document redirect");
    write("dooc.yaml", stringify({ document: { url: "child/dooc.yaml" } }));
    symlinkSync(root, join(root, "child"), "dir");
    expect(readManifest(root).errors.join()).toContain("Circular manifest include");
});

it("refreshes relative references when an unchanged source moves into an included manifest", () => {
    const { root, write } = fixture({ url: "child/guide.md" });
    write("child/guide.md", "![](data.txt)\n");
    write("data.txt", "Root data\n");
    write("child/data.txt", "Child data\n");
    const compiler = createCompiler(root);
    expect(compiler.compile().sources.get("child/guide.md")?.referencedFiles).toEqual(["data.txt"]);
    write("child/dooc.yaml", stringify({ document: { url: "guide.md" } }));
    write("dooc.yaml", stringify({ document: { url: "child/dooc.yaml" } }));
    expect(compiler.compile().sources.get("child/guide.md")?.referencedFiles).toEqual([
        "child/data.txt",
    ]);
});

it("protects documents referenced from child manifests and retains their root-relative source", () => {
    const { root, write } = fixture({
        children: [
            { document: { url: "child/shared.md" } },
            { document: { url: "child/dooc.yaml" } },
        ],
    });
    write("child/dooc.yaml", stringify({ document: { url: "index.md" } }));
    write("child/index.md", "[Shared](shared.md)\n");
    write("child/shared.md", "[Index](child/index.md)\n");
    const ops = createDocOps(root);
    expect(ops.remove(fileDocumentId("child/shared.md"))).toMatchObject({
        status: 409,
        referencedBy: ["child/index.md"],
    });
    expect(ops.rename(fileDocumentId("child/shared.md"), "renamed.md")).toMatchObject({
        updatedRefs: 1,
    });
    expect(readFileSync(join(root, "child/index.md"), "utf8")).toBe("[Shared](renamed.md)\n");
    expect(readFileSync(join(root, "child/renamed.md"), "utf8")).toBe("[Index](child/index.md)\n");
    expect(compileSite(root).errors).toEqual([]);
    expect(ops.rename(fileDocumentId("child/dooc.yaml"), "cover.md")).toMatchObject({
        id: fileDocumentId("child/dooc.yaml"),
    });
    expect(compileSite(root).errors).toEqual([]);
});
