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
import { publishHtml, siteFrom } from "../viewer/serve.js";
import { compileSite } from "./compile.js";
import { exportEntries } from "./export.js";
import { createDocOps } from "./ops.js";

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
