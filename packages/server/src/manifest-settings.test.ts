import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { checkSite } from "../../engine/src/compiler/check.js";
import { exportEntries } from "../../engine/src/compiler/export.js";
import { filesSnapshot, updateFiles } from "../../engine/src/compiler/files.js";
import {
    parseManifestText,
    projectRoot,
    readManifest,
} from "../../engine/src/compiler/manifest.js";
import { serializeManifest } from "../../engine/src/core/content-metadata.js";
import { resourceIndex } from "./resource-library.js";
import { textfileResponse } from "./textfile.js";

const roots: string[] = [];
const fixture = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), "dooc-manifest-settings-"));
    roots.push(root);
    for (const [file, content] of Object.entries(files)) {
        mkdirSync(join(root, file, ".."), { recursive: true });
        writeFileSync(join(root, file), content);
    }
    return root;
};
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const manifest = (files: unknown) =>
    stringify({ system: { library: { files } }, document: { title: "Handbook" } });

it.each([
    "a.csv",
    ["../a.csv"],
    ["/a.csv"],
    ["https://example.com/a.csv"],
    ["a.csv", "a.csv"],
    ["data/*.csv"],
    [null],
])("rejects invalid explicit Library paths: %j", (files) => {
    expect(parseManifestText(manifest(files)).errors).not.toEqual([]);
});

it("accepts literal brackets and spaces in Library file names", () => {
    const files = ["src/[lang]/example.ts", "data/annual report.csv"];
    expect(parseManifestText(manifest(files))).toMatchObject({ libraryFiles: files, errors: [] });
});

it("indexes explicit text files once, retains included sources, and exports and moves them", () => {
    const raw = `${manifest(["example.ts", "table.csv"])}  children:\n    - document: {url: child/dooc.yaml}\n`;
    const root = fixture({
        "team.dooc.yaml": raw,
        "example.ts": "const example = 42;\n",
        "table.csv": "name,value\na,1\n",
        "notes.md": "![Table](table.csv)\n",
        "child/dooc.yaml": manifest(["local.txt"]),
        "child/local.txt": "Included text\n",
    });
    projectRoot(join(root, "team.dooc.yaml"));
    const parsed = readManifest(root);
    expect(parsed.errors).toEqual([]);
    expect(parsed.includedLibraryFiles).toEqual(["child/local.txt"]);
    expect(parseManifestText(serializeManifest(parsed.tree, parsed)).libraryFiles).toEqual([
        "example.ts",
        "table.csv",
    ]);
    const index = resourceIndex(
        root,
        filesSnapshot(root).files.map(({ path }) => path),
    );
    expect(index.errors).toEqual([]);
    expect(
        index.codeblocks.filter(
            (item) => item.reference?.file === "table.csv" || item.source.file === "table.csv",
        ),
    ).toHaveLength(1);
    expect(index.codeblocks).toContainEqual(
        expect.objectContaining({ format: "typescript", source: { file: "example.ts", line: 1 } }),
    );
    expect(index.codeblocks).toContainEqual(
        expect.objectContaining({ content: "Included text\n" }),
    );
    expect(exportEntries(root).map(({ name }) => name)).toEqual(
        expect.arrayContaining(["example.ts", "table.csv", "child/local.txt"]),
    );
    updateFiles(root, {
        action: "move",
        paths: ["example.ts"],
        directory: "examples",
        revision: filesSnapshot(root).revision,
    });
    expect(readManifest(root).libraryFiles).toEqual(["examples/example.ts", "table.csv"]);
    updateFiles(root, {
        action: "move",
        paths: ["child/local.txt"],
        directory: "child/text",
        revision: filesSnapshot(root).revision,
    });
    expect(
        parseManifestText(readFileSync(join(root, "child/dooc.yaml"), "utf8")).libraryFiles,
    ).toEqual(["text/local.txt"]);
});

it("reports unavailable, ignored and binary sources without reading arbitrary files", () => {
    const root = fixture({
        "dooc.yaml": manifest(["missing.csv", "ignored.csv", "binary.csv"]),
        ".gitignore": "ignored.csv\n",
        "ignored.csv": "secret",
        "binary.csv": "\0",
    });
    const index = resourceIndex(
        root,
        filesSnapshot(root).files.map(({ path }) => path),
    );
    expect(index.errors).toHaveLength(3);
    expect(index.codeblocks).toEqual([]);
    expect(checkSite(root).diagnostics.some((item) => item.file === "missing.csv")).toBe(true);
    expect(() => exportEntries(root)).toThrow();
});

it("resolves dependencies in explicitly listed Markdown relative to its included manifest", () => {
    const root = fixture({
        "dooc.yaml": "document: {children: [{document: {url: child/dooc.yaml}}]}\n",
        "child/dooc.yaml": manifest(["notes.md"]),
        "child/notes.md": "![Data](data.csv)\n",
        "child/data.csv": "name,value\na,1\n",
    });
    expect(exportEntries(root).map(({ name }) => name)).toContain("child/data.csv");
    const index = resourceIndex(
        root,
        filesSnapshot(root).files.map(({ path }) => path),
    );
    expect(index.errors).toEqual([]);
    expect(index.codeblocks[0]?.reference?.file).toBe("child/data.csv");
});

it("validates named manifests before saving and refuses to overwrite an external edit", async () => {
    const original = manifest([]);
    const root = fixture({ "team.dooc.yaml": original });
    const save = (content: string, base = original) =>
        textfileResponse(root, { action: "save", file: "team.dooc.yaml", content, base });
    expect((await save("document: [")).status).toBe(400);
    expect((await save(manifest(["../secret.txt"]))).status).toBe(400);
    expect(readFileSync(join(root, "team.dooc.yaml"), "utf8")).toBe(original);
    const next = manifest(["example.ts"]);
    expect((await save(next)).status).toBe(200);
    expect((await save(original)).status).toBe(409);
    expect(readFileSync(join(root, "team.dooc.yaml"), "utf8")).toBe(next);
});

it("migrates a saved sidebar icon without losing comments or overwriting conflicts", async () => {
    const original =
        "# Document\ndocument:\n  # Keep sidebar notes\n  sidebar:\n    icon: # Theme icons\n      light: light.svg\n      dark: dark.svg\n";
    const root = fixture({ "team.dooc.yaml": original });
    const save = (content: string) =>
        textfileResponse(root, { action: "save", file: "team.dooc.yaml", content, base: original });
    expect((await save(`${original}  icon: root.svg\n`)).status).toBe(400);
    expect(readFileSync(join(root, "team.dooc.yaml"), "utf8")).toBe(original);
    const result = await save(original);
    expect(result.status).toBe(200);
    const saved = readFileSync(join(root, "team.dooc.yaml"), "utf8");
    expect(result.body.content).toBe(saved);
    expect(saved).toContain("# Document");
    expect(saved).toContain("# Theme icons");
    expect(saved).toContain("# Keep sidebar notes");
    expect(parse(saved).document).toEqual({
        sidebar: {},
        icon: { light: "light.svg", dark: "dark.svg" },
    });
    expect((await save(original)).status).toBe(409);
});
