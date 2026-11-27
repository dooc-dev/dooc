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
    expect(parseManifestText(manifest(files))).toMatchObject({
        formats: { ts: { files: [files[0]] }, csv: { files: [files[1]] } },
        errors: [],
    });
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
    expect(parsed.includedFormats).toEqual({
        "child/dooc.yaml": { txt: { files: ["child/local.txt"] } },
    });
    expect(parseManifestText(serializeManifest(parsed.tree, parsed)).formats).toEqual({
        ts: { files: ["example.ts"] },
        csv: { files: ["table.csv"] },
    });
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
        expect.objectContaining({ format: "ts", source: { file: "example.ts", line: 1 } }),
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
    expect(readManifest(root).formats).toEqual({
        ts: { files: ["examples/example.ts"] },
        csv: { files: ["table.csv"] },
    });
    updateFiles(root, {
        action: "move",
        paths: ["child/local.txt"],
        directory: "child/text",
        revision: filesSnapshot(root).revision,
    });
    expect(
        parseManifestText(readFileSync(join(root, "child/dooc.yaml"), "utf8")).formats?.txt?.files,
    ).toEqual(["text/local.txt"]);
});

it("reports unavailable and ignored sources while retaining a link to binary files", () => {
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
    expect(index.errors).toHaveLength(2);
    expect(index.files).toEqual([{ file: "binary.csv", format: "csv", sources: [] }]);
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
    expect(parse(readFileSync(join(root, "team.dooc.yaml"), "utf8")).system).toEqual({
        format: { ts: { files: ["example.ts"] } },
    });
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

it("collects recursive format folders once and toggles aliased fences without hiding references", () => {
    const root = fixture({
        "dooc.yaml": stringify({
            system: {
                library: ["urls"],
                format: {
                    ts: { codeblock: false, folders: ["src", "src/nested"], files: ["src/a.ts"] },
                    svg: { folders: ["assets"] },
                    bin: { files: ["unknown.bin"] },
                    callouth: { codeblock: false },
                },
            },
            document: { url: "guide.md" },
        }),
        "guide.md":
            "```typescript\nconst hidden = 1;\n```\n```ts\nconst hiddenToo = 2;\n```\n```callouth\n[Visible](https://example.com/)\n```\n![Logo](assets/logo.svg)\n[Source](src/a.ts#L1)\n![Preview](https://example.com/preview)\n",
        "src/a.ts": "const file = 3;",
        "src/nested/b.ts": "const nested = 4;",
        "src/ignored.ts": "secret",
        "src/other.js": "const unrelated = 5;",
        "assets/logo.svg":
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><title>Logo</title></svg>',
        "unknown.bin": "\0",
        ".gitignore": "src/ignored.ts\n",
    });
    const index = () =>
        resourceIndex(
            root,
            filesSnapshot(root).files.map((file) => file.path),
        );
    const disabled = index();
    expect(disabled.errors).toEqual([]);
    expect(
        disabled.codeblocks.filter((block) => block.format === "ts").map((block) => block.content),
    ).toEqual(["const file = 3;", "const nested = 4;"]);
    expect(disabled.files?.map((file) => file.file)).toEqual([
        "assets/logo.svg",
        "guide.md",
        "src/a.ts",
        "src/nested/b.ts",
        "unknown.bin",
    ]);
    expect(disabled.urls[0]?.sources).toEqual([{ file: "guide.md", line: 8 }]);
    expect(disabled.urlPreviews).toEqual([]);
    expect(disabled.formats).toEqual(expect.arrayContaining(["ts", "svg", "bin", "callouth"]));
    expect(exportEntries(root).map((entry) => entry.name)).toEqual(
        expect.arrayContaining(["src/a.ts", "src/nested/b.ts", "assets/logo.svg", "unknown.bin"]),
    );
    const raw = readFileSync(join(root, "dooc.yaml"), "utf8");
    writeFileSync(join(root, "dooc.yaml"), raw.replace("codeblock: false", "codeblock: true"));
    expect(index().codeblocks.filter((block) => block.format === "ts")).toHaveLength(4);
    updateFiles(root, {
        action: "move",
        paths: ["src"],
        directory: "examples",
        revision: filesSnapshot(root).revision,
    });
    expect(readManifest(root).formats?.ts).toEqual({
        codeblock: true,
        folders: ["examples/src", "examples/src/nested"],
        files: ["examples/src/a.ts"],
    });
    expect(index().errors).toEqual([]);
});

it("keeps included format folders and codeblock settings relative to their owner", () => {
    const root = fixture({
        "dooc.yaml":
            "system: {format: {ts: {codeblock: false}}}\ndocument: {children: [{document: {url: child/dooc.yaml}}]}\n",
        "notes.md": "```ts\nroot\n```",
        "child/dooc.yaml":
            "system: {format: {ts: {folders: [src], codeblock: true}}}\ndocument: {url: guide.md}\n",
        "child/guide.md": "```typescript\nchild\n```",
        "child/src/a.ts": "child file",
    });
    const index = resourceIndex(
        root,
        filesSnapshot(root).files.map((file) => file.path),
    );
    expect(index.errors).toEqual([]);
    expect(
        index.codeblocks.filter((block) => block.format === "ts").map((block) => block.content),
    ).toEqual(["child", "child file"]);
    expect(exportEntries(root).map((file) => file.name)).toContain("child/src/a.ts");
    updateFiles(root, {
        action: "move",
        paths: ["child/src"],
        directory: "child/code",
        revision: filesSnapshot(root).revision,
    });
    expect(readManifest(root).includedFormats?.["child/dooc.yaml"]?.ts?.folders).toEqual([
        "child/code/src",
    ]);
});

it("rejects ignored folders and non-directories while absent folders remain empty", () => {
    const root = fixture({
        "dooc.yaml":
            "system: {format: {ts: {folders: [private, missing, file.ts]}}}\ndocument: {}\n",
        ".gitignore": "private/\n",
        "private/a.ts": "secret",
        "file.ts": "not a directory",
    });
    const index = resourceIndex(
        root,
        filesSnapshot(root).files.map((file) => file.path),
    );
    expect(index.errors).toHaveLength(2);
    expect(index.files).toEqual([]);
    expect(() => exportEntries(root)).toThrow();
});

it("retains folder membership when restructuring and regroups a renamed file extension", () => {
    const root = fixture({
        "dooc.yaml": "system: {format: {ts: {folders: [src], codeblock: false}}}\ndocument: {}\n",
        "src/a.ts": "const source = 1;",
        "other.ts": "const outside = 2;",
    });
    updateFiles(root, { action: "restructure", revision: filesSnapshot(root).revision });
    const selected = readManifest(root).formats?.ts?.files;
    expect(selected).toHaveLength(1);
    expect(readManifest(root).formats?.ts?.folders).toBeUndefined();
    const file = selected?.[0];
    expect(file).toMatch(/a\.ts$/);
    updateFiles(root, {
        action: "rename",
        file,
        name: "a.js",
        revision: filesSnapshot(root).revision,
    });
    expect(readManifest(root).formats?.js?.files?.[0]).toMatch(/a\.js$/);
    const index = resourceIndex(
        root,
        filesSnapshot(root).files.map((file) => file.path),
    );
    expect(index.errors).toEqual([]);
    expect(index.codeblocks.map((block) => block.content)).toEqual(["const source = 1;"]);
});
