import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { pageDataResponse, siteFrom } from "../../../server/src/serve.js";
import { siteIconResponse } from "../../../server/src/site-icon.js";
import { siteTitleResponse } from "../../../server/src/site-title.js";
import { flattenTree, parseManifest, serializeManifest } from "../core/content-metadata.js";
import { fileDocumentId } from "../core/files.js";
import { docPath, resolveDocPath } from "../core/routing.js";
import { compileSite } from "./compile.js";
import { filesSnapshot, updateFiles } from "./files.js";
import { readManifest } from "./manifest.js";
import { createDocOps } from "./ops.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const config = () => ({
    system: { languages: ["eng", "jpn"], default_lang: "eng", themes: ["light", "dark"] },
    document: {
        sidebar: {
            title: { eng: "Guide", jpn: "ガイド" },
            icon: { light: "icons/light.svg", dark: "icons/dark.svg" },
        },
        children: [
            {
                document: {
                    url: "one/guide.md",
                    children: [{ document: { url: "two/guide.md" } }],
                },
            },
        ],
    },
});
const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-nested-"));
    roots.push(root);
    const write = (file: string, text: string) => {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), text);
    };
    write("dooc.yaml", stringify(config()));
    write("one/guide.md", "[Two](two/guide.md)\n");
    write("two/guide.md", "Body\n");
    write("locales/jpn/one/guide.md", "本文\n");
    for (const theme of ["light", "dark"])
        write(`icons/${theme}.svg`, `<svg viewBox="0 0 10 10"><title>${theme}</title></svg>`);
    return { root, write };
};

it("uses complete paths for identity, preserves ordered children and localizes the site title", () => {
    const { root } = fixture();
    const manifest = readManifest(root);
    expect(manifest.errors).toEqual([]);
    expect(new Set(flattenTree(manifest.tree).map((doc) => doc.id)).size).toBe(3);
    expect(parseManifest(parse(serializeManifest(manifest.tree, manifest)))).toEqual(manifest);
    const compiled = compileSite(root, { locale: "jpn" });
    expect(compiled.errors).toEqual([]);
    expect(compiled.title).toBe("ガイド");
    expect(Object.keys(compiled.iconVariants ?? {})).toEqual(["light", "dark"]);
    const site = siteFrom(compiled);
    expect(docPath(site.entries, fileDocumentId("two/guide.md"))).toBe("/guide/guide");
    expect(resolveDocPath(site.entries, "/guide/guide")).toBe(fileDocumentId("two/guide.md"));
    expect(pageDataResponse(site, "/guide/guide").status).toBe(200);
    expect(pageDataResponse(site, "/_docs/two/guide.md").status).toBe(404);
});

it("preserves nested configuration through document edits and file renames", () => {
    const { root } = fixture();
    const ops = createDocOps(root);
    const added = ops.add("third", "Third", fileDocumentId("one/guide.md"));
    expect(added).toEqual({ id: fileDocumentId("files/md/third.md") });
    expect(ops.remove(fileDocumentId("files/md/third.md"))).not.toHaveProperty("error");
    updateFiles(root, {
        action: "rename",
        file: "two/guide.md",
        name: "renamed.md",
        revision: filesSnapshot(root).revision,
    });
    expect(ops.move(fileDocumentId("two/renamed.md"))).not.toHaveProperty("error");
    expect(readFileSync(join(root, "one/guide.md"), "utf8")).toContain("two/renamed.md");
    expect(readManifest(root).titles).toEqual({ eng: "Guide", jpn: "ガイド" });
    expect(readManifest(root).tree[0]?.children.map((node) => node.file)).toEqual([
        "one/guide.md",
        "two/renamed.md",
    ]);
    expect(compileSite(root).errors).toEqual([]);
    const saved = parse(readFileSync(join(root, "dooc.yaml"), "utf8"));
    expect(saved).not.toHaveProperty("docs");
    expect(JSON.stringify(saved.document.children)).not.toContain('"id"');
});

it("routes Unicode and reserved folder names without collisions or double decoding", () => {
    const { root, write } = fixture();
    const files = ["api/日本語 %.md", "_files/guide.md", "docs/a b.md", "docs/a%20b.md"];
    write(
        "dooc.yaml",
        stringify({
            ...config(),
            document: {
                ...config().document,
                children: files.map((url) => ({ document: { url } })),
            },
        }),
    );
    for (const file of files) write(file, "Body\n");
    const compiled = compileSite(root);
    expect(compiled.errors).toEqual([]);
    const site = siteFrom(compiled);
    for (const file of files) {
        const path = docPath(site.entries, fileDocumentId(file));
        expect(path).toBe(`/${encodeURIComponent(file.slice(file.lastIndexOf("/") + 1, -3))}`);
        expect(pageDataResponse(site, path).status).toBe(200);
        expect(resolveDocPath(site.entries, path)).toBe(fileDocumentId(file));
    }
});

it("rejects duplicate routes before adding, moving or renaming files", () => {
    const { root } = fixture();
    const ops = createDocOps(root);
    const parent = fileDocumentId("one/guide.md");
    const before = readFileSync(join(root, "dooc.yaml"), "utf8");
    expect(ops.move(fileDocumentId("two/guide.md"))).toMatchObject({
        status: 409,
        error: "Duplicate page path: /guide",
    });
    expect(ops.addFile("guide.md", "Another guide")).toMatchObject({
        status: 409,
        error: "Duplicate page path: /guide",
    });
    expect(ops.addLibrary("guide", "Guide library")).toMatchObject({ status: 409 });
    expect(readFileSync(join(root, "dooc.yaml"), "utf8")).toBe(before);
    expect(existsSync(join(root, "files/md/guide.md"))).toBe(false);

    const added = ops.addFile("third.md", "Third", parent);
    if (!("id" in added)) throw new Error("Document was not created");
    const addedManifest = readFileSync(join(root, "dooc.yaml"), "utf8");
    expect(ops.rename(added.id, "guide")).toMatchObject({ status: 409 });
    expect(readFileSync(join(root, "dooc.yaml"), "utf8")).toBe(addedManifest);
    expect(existsSync(join(root, "files/md/third.md"))).toBe(true);
    expect(existsSync(join(root, "files/md/guide.md"))).toBe(false);
});

it("reports duplicate and reserved routes in hand-written manifests", () => {
    const { root, write } = fixture();
    write(
        "dooc.yaml",
        stringify({
            document: {
                children: [
                    { document: { url: "one/guide.md" } },
                    { document: { url: "two/guide.md" } },
                ],
            },
        }),
    );
    expect(readManifest(root).errors.join("\n")).toContain("Duplicate page path: /guide");
    write(
        "dooc.yaml",
        stringify({ document: { children: [{ document: { url: "content/_git.md" } }] } }),
    );
    expect(readManifest(root).errors.join("\n")).toContain("Reserved page path: /_git");
});

it("updates only the selected title language and icon theme", () => {
    const { root } = fixture();
    expect(
        siteTitleResponse(root, { title: "資料", baseTitle: "ガイド", language: "jpn" }).status,
    ).toBe(200);
    expect(
        siteTitleResponse(root, { title: "stale", baseTitle: "ガイド", language: "jpn" }).status,
    ).toBe(409);
    const light = readFileSync(join(root, "icons/light.svg"), "utf8");
    expect(
        siteIconResponse(root, {
            theme: "dark",
            data: Buffer.from('<svg viewBox="0 0 1 1"><title>new</title></svg>').toString("base64"),
        }).status,
    ).toBe(200);
    expect(readFileSync(join(root, "icons/light.svg"), "utf8")).toBe(light);
    expect(readManifest(root).titles).toEqual({ eng: "Guide", jpn: "資料" });
    expect(compileSite(root).errors).toEqual([]);
});

it("updates normalized language tags without creating duplicate title languages", () => {
    const { root, write } = fixture();
    const value = config();
    write(
        "dooc.yaml",
        stringify({
            ...value,
            document: {
                ...value.document,
                sidebar: { ...value.document.sidebar, title: { en: "Guide", ja: "ガイド" } },
            },
        }),
    );
    expect(
        siteTitleResponse(root, { title: "資料", baseTitle: "ガイド", language: "jpn" }).status,
    ).toBe(200);
    expect(readManifest(root).errors).toEqual([]);
    expect(readManifest(root).titles?.jpn).toBe("資料");
});

it.each([
    { ...config(), extra: true },
    { ...config(), system: { languages: ["eng"], default_lang: "jpn" } },
    { ...config(), document: { sidebar: { title: { jpn: "日本語" } } } },
    { ...config(), document: { url: "../escape.md" } },
    {
        ...config(),
        document: {
            children: [{ document: { url: "same.md" } }, { document: { url: "same.md" } }],
        },
    },
    { ...config(), document: { url: "one.md", id: "one" } },
])("rejects malformed nested manifests: %j", (value) => {
    expect(parseManifest(value).errors.length).toBeGreaterThan(0);
});

it("takes document titles from the manifest, falling back to the file name", () => {
    const { root } = fixture();
    const one = fileDocumentId("one/guide.md");
    expect(
        compileSite(root)
            .docs.filter((doc) => !doc.root)
            .map((doc) => doc.title),
    ).toEqual(["guide", "guide"]);
    const ops = createDocOps(root);
    expect(ops.setTitle(one, " Getting started ")).toEqual({ id: one });
    expect(
        parse(readFileSync(join(root, "dooc.yaml"), "utf8")).document.children[0].document,
    ).toMatchObject({
        url: "one/guide.md",
        title: "Getting started",
    });
    const added = ops.addFile("new.md", "New page");
    if (!("id" in added)) throw new Error("Document was not created");
    const compiled = compileSite(root);
    expect(compiled.errors).toEqual([]);
    expect(compiled.docs.filter((doc) => !doc.root).map((doc) => doc.title)).toEqual([
        "Getting started",
        "guide",
        "New page",
    ]);
    // Titles survive unrelated manifest rewrites and never enter the Markdown file.
    ops.move(added.id, one);
    expect(compileSite(root).docs.find((doc) => doc.id === added.id)?.title).toBe("New page");
    expect(
        readFileSync(join(root, readManifest(root).files?.documents[added.id] ?? ""), "utf8"),
    ).toBe("");
});
