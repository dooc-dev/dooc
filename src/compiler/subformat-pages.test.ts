import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
    flattenTree,
    parseManifest,
    serializeManifest,
    subformatPageId,
} from "../core/content-metadata.js";
import { docPath } from "../core/routing.js";
import { createTools } from "../mcp.js";
import { navGroupsHtml, pageDataResponse, publishHtml, siteFrom } from "../viewer/serve.js";
import { compileSite } from "./compile.js";
import { exportEntries } from "./export.js";
import { filesSnapshot, updateFiles } from "./files.js";
import { readManifest } from "./manifest.js";
import { createDocOps } from "./ops.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = (nested = true) => {
    const root = mkdtempSync(join(tmpdir(), "dooc-subformat-pages-"));
    roots.push(root);
    const write = (file: string, content: string) => {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), content);
    };
    const formats = [
        {
            ext: "issue",
            format: "json",
            schema: "files/issue.schema.json",
            layouts: { card_title: "title", group_by: "", sort_by: "title", sort_order: "desc" },
        },
    ];
    write(
        "dooc.yaml",
        stringify(
            nested
                ? { system: { default_lang: "eng" }, center_contents: [], json_subformats: formats }
                : { docs: [], subformats: formats },
        ),
    );
    write(
        "files/issue.schema.json",
        JSON.stringify({
            type: "object",
            properties: {
                title: { type: "string" },
                status: { type: "string", enum: ["Todo", "Done"] },
            },
            required: ["title", "status"],
        }),
    );
    write("files/one.issue", JSON.stringify({ title: "First <record>", status: "Todo" }));
    return { root, write, ops: createDocOps(root) };
};

it.each([
    true,
    false,
])("adds, renames, moves and removes display pages without Markdown or record changes (nested: %s)", (nested) => {
    const { root, ops } = fixture(nested);
    const id = subformatPageId("issue");
    const record = readFileSync(join(root, "files/one.issue"), "utf8");
    expect(ops.addSubformat("missing", "Missing")).toMatchObject({ status: 400 });
    expect(ops.addSubformat("issue", "Issues")).toEqual({ id });
    expect(ops.addSubformat("issue", "Again")).toMatchObject({ status: 409 });
    expect(ops.write(id, "unexpected markdown")).toMatchObject({ status: 404 });
    expect(existsSync(join(root, "content"))).toBe(false);
    const manifest = readManifest(root);
    expect(manifest.errors).toEqual([]);
    expect(parseManifest(parse(serializeManifest(manifest.tree, manifest)))).toEqual(manifest);
    expect(ops.renameSubformat(id, "Work items")).toEqual({ id });
    expect(ops.move(id)).toEqual({ id });
    expect(flattenTree(readManifest(root).tree)[0]).toMatchObject({
        subformat: "issue",
        title: "Work items",
    });
    expect(ops.remove(id)).toEqual({ parent: undefined, danglingRefs: 0 });
    expect(readFileSync(join(root, "files/one.issue"), "utf8")).toBe(record);
    expect(readManifest(root).subformats).toHaveLength(1);
});

it("compiles a subformat-only site and publishes its board in the sidebar", () => {
    const { root, ops, write } = fixture();
    ops.addSubformat("issue", "Issues <board>");
    const compiled = compileSite(root);
    expect(compiled.errors).toEqual([]);
    expect(compiled.docs[0]?.subformat?.records[0]?.data.title).toBe("First <record>");
    expect(compiled.docs[0]?.subformat?.layouts).toEqual({
        card_title: "title",
        group_by: "",
        sort_by: "title",
        sort_order: "desc",
    });
    const site = siteFrom(compiled);
    const id = subformatPageId("issue");
    const path = docPath(site.entries, id);
    expect(pageDataResponse(site, path)).toMatchObject({
        status: 200,
        body: { resource: true, path },
    });
    const html = publishHtml(site, "", undefined, "", "static", "", "/* subformat runtime */");
    expect(html).toContain('data-subformat-page="issue"');
    expect(html).toContain('class="subformat-page-title">Issues &lt;board&gt;</h1>');
    expect(html).toContain("First &lt;record&gt;");
    expect(html).toContain("&quot;sort_order&quot;:&quot;desc&quot;");
    expect(html).toContain("/* subformat runtime */");
    expect(/<button[^>]*data-subformat-trigger/.test(html)).toBe(false);
    expect(html).not.toContain('class="nav-create"');
    expect(navGroupsHtml("edit", site)).toContain("data-subformat-nav");
    expect(filesSnapshot(root).documents).toEqual({});
    expect(createTools(root).read_doc?.run({ id })).toMatchObject({
        file: "dooc.yaml",
        subformat: { ext: "issue" },
    });
    expect(exportEntries(root).map((entry) => entry.name)).toContain("files/one.issue");
    updateFiles(root, {
        action: "rename",
        file: "files/one.issue",
        name: "renamed.issue",
        revision: filesSnapshot(root).revision,
    });
    expect(readManifest(root).tree[0]?.subformat).toBe("issue");
    write("files/renamed.issue", '{"title":"Broken"}');
    expect(compileSite(root).errors.join("\n")).toContain("status");
});

it.each([
    true,
    false,
])("keeps page identity and records when renaming and changing icons (nested: %s)", (nested) => {
    const { root, ops, write } = fixture(nested);
    const id = subformatPageId("issue");
    const record = readFileSync(join(root, "files/one.issue"), "utf8");
    const defaultIcon = `icons/${id}.svg`;
    const svg = '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6"/></svg>';
    expect(ops.addSubformat("issue", "Issues")).toEqual({ id });
    write(defaultIcon, svg);
    expect(compileSite(root).errors).toEqual([]);
    expect(compileSite(root).docs[0]?.icon).toBe(svg);
    expect(exportEntries(root).map((entry) => entry.name)).toContain(defaultIcon);

    const manifest = readManifest(root);
    manifest.files = {
        ...(manifest.files ?? { defaultLayout: true, documents: {} }),
        icons: { [id]: "files/page.svg" },
    };
    write("files/page.svg", svg);
    rmSync(join(root, defaultIcon));
    write("dooc.yaml", serializeManifest(manifest.tree, manifest));
    expect(readManifest(root).errors).toEqual([]);
    expect(readManifest(root).files?.icons?.[id]).toBe("files/page.svg");
    expect(ops.renameSubformat(id, "Work items")).toEqual({ id });
    const compiled = compileSite(root);
    expect(compiled.errors).toEqual([]);
    expect(compiled.docs[0]).toMatchObject({
        id,
        title: "Work items",
        icon: svg,
        subformat: { ext: "issue" },
    });
    const site = siteFrom(compiled);
    expect(docPath(site.entries, id)).toBe(`/${id}`);
    const nav = navGroupsHtml("edit", site);
    expect(nav).toContain('type="file" accept=".svg,image/svg+xml"');
    expect(nav).toContain('class="nav-icon-clear"');
    expect(nav).toContain('aria-keyshortcuts="F2"');
    expect(nav).toContain("Work items");
    const html = publishHtml(site, "");
    expect(html).toContain("Work items");
    expect(html).toContain(Buffer.from(svg).toString("base64"));
    expect(exportEntries(root).map((entry) => entry.name)).toContain("files/page.svg");
    expect(readFileSync(join(root, "files/one.issue"), "utf8")).toBe(record);
    expect(ops.remove(id)).toMatchObject({ danglingRefs: 0 });
    expect(existsSync(join(root, "files/page.svg"))).toBe(false);
    expect(readManifest(root).files?.icons?.[id]).toBeUndefined();
    expect(exportEntries(root).map((entry) => entry.name)).not.toContain("files/page.svg");
});

it("validates unknown, duplicate and mixed file/subformat entries", () => {
    const { root } = fixture();
    const manifest = parse(readFileSync(join(root, "dooc.yaml"), "utf8"));
    for (const entries of [
        [{ subformat: "missing" }],
        [{ subformat: "issue" }, { subformat: "issue" }],
        [{ subformat: "issue", file: "guide.md" }],
        [{ subformat: "issue", title: " " }],
        [{ subformat: "issue", icon: "../outside.svg" }],
        [{ subformat: "issue", icon: "page.png" }],
    ])
        expect(
            parseManifest({ ...manifest, center_contents: entries }).errors.length,
        ).toBeGreaterThan(0);
});

it("preserves subformat pages beneath Markdown parents when moving and exporting", () => {
    const { root, ops } = fixture();
    const added = ops.addFile("guide.md", "Guide");
    if (!("id" in added)) throw new Error(added.error);
    const id = subformatPageId("issue");
    expect(ops.addSubformat("issue", "Issues", added.id)).toEqual({ id });
    expect(compileSite(root).docs.map((doc) => doc.id)).toEqual([added.id, id]);
    expect(ops.remove(added.id)).toMatchObject({ status: 409 });
    expect(ops.move(id)).toEqual({ id });
    expect(ops.move(added.id, id)).toEqual({ id: added.id });
    const compiled = compileSite(root);
    expect(compiled.errors).toEqual([]);
    expect(compiled.docs.map((doc) => doc.id)).toEqual([id, added.id]);
    expect(exportEntries(root).map((entry) => entry.name)).toContain("files/md/guide.md");
});
