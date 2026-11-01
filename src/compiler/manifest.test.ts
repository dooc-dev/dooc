import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { compileSite } from "./compile.js";
import { createDocOps } from "./ops.js";

it("document operations update only the root manifest and remain compilable", () => {
    const root = mkdtempSync(join(tmpdir(), "docs-root-manifest-"));
    try {
        const ops = createDocOps(root);
        expect(ops.add("guide", "Guide")).toEqual({ id: "guide" });
        expect(ops.add("child", "Child")).toEqual({ id: "child" });
        expect(ops.move("child", "guide")).toEqual({ id: "child" });
        expect(ops.rename("child", "detail")).toMatchObject({ id: "detail" });
        const compiled = compileSite(root);
        expect(compiled.errors).toEqual([]);
        expect(compiled.artifact.docs.map(({ id, parent }) => ({ id, parent }))).toEqual([
            { id: "guide", parent: undefined },
            { id: "detail", parent: "guide" },
        ]);
        expect(ops.remove("detail")).toMatchObject({ parent: "guide" });
        expect(parse(readFileSync(join(root, "manifest.yaml"), "utf8"))).toEqual(["guide"]);
        expect(existsSync(join(root, "content", "manifest.yaml"))).toBe(false);
        expect(compileSite(root).errors).toEqual([]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
