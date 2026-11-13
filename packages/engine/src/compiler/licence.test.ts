import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { parseManifest, serializeManifest } from "../core/content-metadata.js";
import { checkSite } from "./check.js";
import { compileSite } from "./compile.js";
import { exportEntries } from "./export.js";
import { filesSnapshot, updateFiles } from "./files.js";
import { readManifest } from "./manifest.js";
import { createDocOps } from "./ops.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = (licence = "LICENSE") => {
    const root = mkdtempSync(join(tmpdir(), "dooc-licence-"));
    roots.push(root);
    writeFileSync(
        join(root, "dooc.yaml"),
        stringify({ system: { licence }, center_contents: [{ file: "guide.md" }] }),
    );
    writeFileSync(join(root, "guide.md"), "Guide content.\n");
    mkdirSync(dirname(join(root, licence)), { recursive: true });
    writeFileSync(join(root, licence), "Licence text.\n");
    return root;
};

it.each([
    "LICENSE",
    "LICENSE.md",
    "legal/LICENSE.txt",
])("preserves and exports the licence reference %s", (licence) => {
    const root = fixture(licence);
    const manifest = readManifest(root);
    expect(manifest.errors).toEqual([]);
    expect(manifest.licence).toBe(licence);
    expect(parseManifest(parse(serializeManifest(manifest.tree, manifest)))).toEqual(manifest);
    expect(compileSite(root).errors).toEqual([]);
    expect(checkSite(root, { only: ["render"] }).exitCode).toBe(0);
    expect(exportEntries(root).filter((entry) => entry.name === licence)).toEqual([
        { name: licence, data: Buffer.from("Licence text.\n") },
    ]);
});

it.each([
    null,
    true,
    42,
    {},
    [],
    "",
    " ",
    "../LICENSE",
    "legal/../../LICENSE",
    "/LICENSE",
    "C:\\LICENSE",
    "https://example.com/LICENSE",
    ".dooc/credentials.json",
    "LICENSE\n",
])("rejects invalid licence references: %j", (licence) => {
    expect(parseManifest({ system: { licence }, center_contents: [] }).errors).toEqual([
        "dooc.yaml: system.licence must be a local file path",
    ]);
});

it("keeps the licence through document edits and updates it after file moves", () => {
    const root = fixture();
    const ops = createDocOps(root);
    const added = ops.add("extra", "Extra");
    expect(added).not.toHaveProperty("error");
    if ("error" in added) throw new Error(added.error);
    expect(ops.remove(added.id)).not.toHaveProperty("error");
    expect(readManifest(root).licence).toBe("LICENSE");
    for (const [action, expected] of [
        [{ action: "rename", file: "LICENSE", name: "LICENSE.md" }, "LICENSE.md"],
        [{ action: "move", paths: ["LICENSE.md"], directory: "legal" }, "legal/LICENSE.md"],
        [{ action: "restructure" }, "files/md/LICENSE.md"],
    ] as const) {
        updateFiles(root, { ...action, revision: filesSnapshot(root).revision });
        expect(readManifest(root).licence).toBe(expected);
        expect(parse(readFileSync(join(root, "dooc.yaml"), "utf8")).system.licence).toBe(expected);
        expect(
            exportEntries(root)
                .find((entry) => entry.name === expected)
                ?.data.toString(),
        ).toBe("Licence text.\n");
    }
    expect(compileSite(root).errors).toEqual([]);
});

it.each([
    "missing",
    "directory",
    "outside",
    "ignored",
])("reports an unusable licence file: %s", (kind) => {
    const root = fixture();
    if (kind === "ignored") writeFileSync(join(root, ".gitignore"), "LICENSE\n");
    else {
        rmSync(join(root, "LICENSE"));
        if (kind === "directory") mkdirSync(join(root, "LICENSE"));
        if (kind === "outside") symlinkSync(join(fixture(), "LICENSE"), join(root, "LICENSE"));
    }
    expect(compileSite(root).errors.join("\n")).toContain("system.licence LICENSE");
    expect(checkSite(root, { only: ["render"] }).exitCode).toBe(1);
    expect(() => exportEntries(root)).toThrow();
    if (kind === "missing")
        expect(checkSite(root, { only: ["themes"] }).diagnostics).toContainEqual(
            expect.objectContaining({
                code: "FILE_MISSING",
                file: "LICENSE",
                sourceFile: "dooc.yaml",
            }),
        );
});
