import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { publishHtml, siteFrom } from "../../../server/src/serve.js";
import { siteIconResponse } from "../../../server/src/site-icon.js";
import { siteTitleResponse } from "../../../server/src/site-title.js";
import { isManifestFile } from "../core/content-metadata.js";
import { checkSite } from "./check.js";
import { compileSite } from "./compile.js";
import { exportEntries } from "./export.js";
import { filesSnapshot, managedFile, updateFiles } from "./files.js";
import { manifestFile, projectRoot, readManifest } from "./manifest.js";
import { createDocOps } from "./ops.js";
import { subformatResponse } from "./subformats.js";

it.each([
    ["dooc.yaml", true],
    ["team.dooc.yaml", true],
    ["my.team.dooc.yaml", true],
    ["other.yaml", false],
    ["team.dooc.yml", false],
    [".dooc.yaml", false],
    ["nested/team.dooc.yaml", false],
    ["nested\\team.dooc.yaml", false],
] as const)("recognizes manifest filename %s", (file, expected) => {
    expect(isManifestFile(file)).toBe(expected);
});

it("uses the selected manifest for editing, compilation, validation and export", () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-named-manifest-"));
    try {
        const file = "team.dooc.yaml";
        const other = "title: Other\ndocs: []\n";
        writeFileSync(join(root, "dooc.yaml"), other);
        writeFileSync(join(root, file), "title: Team\ndefaultLang: eng\ndocs: []\n");
        expect(projectRoot(join(root, file))).toBe(root);
        expect(manifestFile(root)).toBe(file);
        const ops = createDocOps(root);
        expect(ops.add("guide", "Guide")).not.toHaveProperty("error");
        expect(compileSite(root).docs.map(({ id }) => id)).toEqual(["guide"]);
        expect(siteTitleResponse(root, { title: "Updated", baseTitle: "Team" }).status).toBe(200);
        expect(
            siteIconResponse(root, {
                data: Buffer.from('<svg viewBox="0 0 10 10"><path d="M0 0h10"/></svg>').toString(
                    "base64",
                ),
            }).status,
        ).toBe(200);
        const snapshot = filesSnapshot(root);
        expect(snapshot.files.map(({ path }) => path)).not.toContain(file);
        expect(managedFile(file)).toBe(false);
        updateFiles(root, {
            action: "move",
            paths: ["files/md/guide.md"],
            directory: "docs",
            revision: snapshot.revision,
        });
        expect(readManifest(root).files?.documents.guide).toBe("docs/guide.md");
        expect(compileSite(root)).toMatchObject({ title: "Updated", errors: [] });
        expect(checkSite(root, { only: ["render"] }).exitCode).toBe(0);
        const entries = exportEntries(root).map(({ name }) => name);
        expect(entries).toContain(file);
        expect(entries).toContain("docs/guide.md");
        expect(entries).not.toContain("dooc.yaml");
        const registered = subformatResponse(root, {
            action: "register",
            ext: "issue",
            format: "json",
            schema: "issue.schema.json",
        });
        expect(registered.status).toBe(200);
        const config = readManifest(root).subformats?.[0];
        expect(subformatResponse(root, { action: "delete", ext: "issue", base: config })).toEqual({
            status: 200,
            body: { file },
        });
        expect(readFileSync(join(root, "dooc.yaml"), "utf8")).toBe(other);
        projectRoot(join(root, "dooc.yaml"));
        expect(readManifest(root)).toMatchObject({ title: "Other", tree: [] });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it.each([
    "docs: [",
    "title: 42\ndocs: []\n",
])("reports errors against the selected manifest: %s", (raw) => {
    const root = mkdtempSync(join(tmpdir(), "dooc-named-errors-"));
    try {
        const file = "team.dooc.yaml";
        writeFileSync(join(root, file), raw);
        mkdirSync(join(root, "content"));
        projectRoot(join(root, file));
        expect(readManifest(root).errors[0]).toMatch(/^team\.dooc\.yaml:/);
        expect(compileSite(root).errors).toContainEqual(
            expect.stringMatching(/^team\.dooc\.yaml:/),
        );
        expect(checkSite(root).diagnostics[0]?.file).toBe(file);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it.each([
    undefined,
    '資料: "API"',
])("document operations preserve the manifest and title %s", (title) => {
    const root = mkdtempSync(join(tmpdir(), "docs-root-manifest-"));
    try {
        if (title !== undefined)
            writeFileSync(join(root, "dooc.yaml"), `title: ${JSON.stringify(title)}\ndocs: []\n`);
        const ops = createDocOps(root);
        expect(ops.add("guide", "Guide")).toEqual({ id: "guide" });
        expect(ops.add("child", "Child")).toEqual({ id: "child" });
        expect(ops.move("child", "guide")).toEqual({ id: "child" });
        expect(ops.rename("child", "detail")).toMatchObject({ id: "detail" });
        const compiled = compileSite(root);
        expect(compiled.errors).toEqual([]);
        expect(compiled.title).toBe(title);
        expect(exportEntries(root).map((entry) => entry.name)).toContain("dooc.yaml");
        expect(compiled.docs.map(({ id, parent }) => ({ id, parent }))).toEqual([
            { id: "guide", parent: undefined },
            { id: "detail", parent: "guide" },
        ]);
        expect(ops.remove("detail")).toMatchObject({ parent: "guide" });
        expect(parse(readFileSync(join(root, "dooc.yaml"), "utf8"))).toEqual({
            ...(title === undefined ? {} : { title }),
            docs: ["guide"],
            files: { defaultLayout: true, documents: { guide: "files/md/guide.md" } },
        });
        expect(existsSync(join(root, "content", "dooc.yaml"))).toBe(false);
        expect(compileSite(root).errors).toEqual([]);
        expect(ops.remove("guide")).not.toHaveProperty("error");
        expect(compileSite(root).title).toBe(title);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it("does not overwrite malformed site metadata when adding a document", () => {
    const root = mkdtempSync(join(tmpdir(), "docs-title-"));
    try {
        const raw = "title: 42\ndocs: []\n";
        writeFileSync(join(root, "dooc.yaml"), raw);
        expect(createDocOps(root).add("guide", "Guide")).toMatchObject({ status: 409 });
        expect(readFileSync(join(root, "dooc.yaml"), "utf8")).toBe(raw);
        expect(existsSync(join(root, "content", "guide.md"))).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it("keeps the site SVG file through document operations, compilation and export", () => {
    const root = mkdtempSync(join(tmpdir(), "docs-site-icon-"));
    try {
        mkdirSync(join(root, "icons"));
        writeFileSync(
            join(root, "icons/logo.svg"),
            '<svg viewBox="0 0 20 10"><path d="M0 0h20"/></svg>',
        );
        writeFileSync(
            join(root, "dooc.yaml"),
            "title: Guide\nicon: icons/logo.svg\ndefaultLang: jpn\ndocs: []\n",
        );
        const ops = createDocOps(root);
        expect(ops.add("guide", "Guide")).not.toHaveProperty("error");
        expect(ops.add("child", "Child")).not.toHaveProperty("error");
        expect(ops.move("child", "guide")).not.toHaveProperty("error");
        expect(ops.rename("child", "detail")).not.toHaveProperty("error");
        expect(ops.remove("detail")).not.toHaveProperty("error");
        expect(parse(readFileSync(join(root, "dooc.yaml"), "utf8"))).toMatchObject({
            title: "Guide",
            icon: "icons/logo.svg",
            defaultLang: "jpn",
        });
        const compiled = compileSite(root);
        expect(compiled.errors).toEqual([]);
        expect(compiled.defaultLang).toBe("jpn");
        expect(compiled.docs[0]?.lang).toBe("jpn");
        expect(compiled.icon).toContain('viewBox="0 -5 20 20"');
        const html = publishHtml(siteFrom(compiled), "");
        expect(html).toContain('<img id="site-icon" alt="" src="data:image/svg+xml;base64,');
        expect(html).not.toContain('id="nav-search"');
        expect(html).toContain("doc-search");
        expect(exportEntries(root).filter((entry) => entry.name === "icons/logo.svg")).toHaveLength(
            1,
        );
        writeFileSync(join(root, "icons/logo.svg"), "not SVG");
        expect(compileSite(root).errors.join()).toContain("expected an SVG");
        rmSync(join(root, "icons/logo.svg"));
        expect(compileSite(root).errors.join()).toContain("icon icons/logo.svg");
        symlinkSync("/etc/hosts", join(root, "icons/logo.svg"));
        expect(compileSite(root).errors.join()).toContain("outside the docs root");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it("reads an independent manifest each time and follows edits on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-manifest-cache-"));
    try {
        writeFileSync(join(root, "dooc.yaml"), "docs: [guide]\n");
        const first = readManifest(root);
        first.tree.length = 0;
        expect(readManifest(root).tree.map((node) => node.id)).toEqual(["guide"]);
        writeFileSync(join(root, "dooc.yaml"), "docs: [guide, extra]\n");
        expect(readManifest(root).tree.map((node) => node.id)).toEqual(["guide", "extra"]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
