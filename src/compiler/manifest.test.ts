import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { compileSite } from "./compile.js";
import { createDocOps } from "./ops.js";

it.each([
    undefined,
    '資料: "API"',
])("document operations preserve the manifest and title %s", (title) => {
    const root = mkdtempSync(join(tmpdir(), "docs-root-manifest-"));
    try {
        if (title !== undefined)
            writeFileSync(
                join(root, "manifest.yaml"),
                `title: ${JSON.stringify(title)}\ndocs: []\n`,
            );
        const ops = createDocOps(root);
        expect(ops.add("guide", "Guide")).toEqual({ id: "guide" });
        expect(ops.add("child", "Child")).toEqual({ id: "child" });
        expect(ops.move("child", "guide")).toEqual({ id: "child" });
        expect(ops.rename("child", "detail")).toMatchObject({ id: "detail" });
        const compiled = compileSite(root);
        expect(compiled.errors).toEqual([]);
        expect(compiled.artifact.title).toBe(title);
        expect(compiled.artifact.docs.map(({ id, parent }) => ({ id, parent }))).toEqual([
            { id: "guide", parent: undefined },
            { id: "detail", parent: "guide" },
        ]);
        expect(ops.remove("detail")).toMatchObject({ parent: "guide" });
        expect(parse(readFileSync(join(root, "manifest.yaml"), "utf8"))).toEqual(
            title === undefined ? ["guide"] : { title, docs: ["guide"] },
        );
        expect(existsSync(join(root, "content", "manifest.yaml"))).toBe(false);
        expect(compileSite(root).errors).toEqual([]);
        expect(ops.remove("guide")).not.toHaveProperty("error");
        expect(compileSite(root).artifact.title).toBe(title);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it("does not overwrite malformed site metadata when adding a document", () => {
    const root = mkdtempSync(join(tmpdir(), "docs-title-"));
    try {
        const raw = "title: 42\ndocs: []\n";
        writeFileSync(join(root, "manifest.yaml"), raw);
        expect(createDocOps(root).add("guide", "Guide")).toMatchObject({ status: 409 });
        expect(readFileSync(join(root, "manifest.yaml"), "utf8")).toBe(raw);
        expect(existsSync(join(root, "content", "guide.md"))).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
