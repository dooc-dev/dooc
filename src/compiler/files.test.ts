import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { suggestDocFileName } from "../core/files.js";
import { docPath } from "../core/routing.js";
import { compileSite } from "./compile.js";
import { exportEntries } from "./export.js";
import { filesSnapshot, rewriteFileLinks, updateFiles, uploadFile } from "./files.js";
import { setDocTranslation } from "./locales.js";
import { readManifest } from "./manifest.js";
import { createDocOps, isOpError } from "./ops.js";

const roots: string[] = [];
const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-files-"));
    roots.push(root);
    for (const dir of ["content", "terms", "figures", "examples", "icons", "locales"])
        mkdirSync(join(root, dir));
    writeFileSync(
        join(root, "manifest.yaml"),
        "# Preserve this comment\ntitle: Test\ndefaultLang: jpn\ndocs: [a, b]\n",
    );
    writeFileSync(
        join(root, "content/a.md"),
        "---\ntitle: A\n---\n\n[Other](doc:b)\n\n![](figures/picture.svg)\n\n![](examples/a.ts#L1)\n\n[](terms/a.termth)\n",
    );
    writeFileSync(join(root, "content/b.md"), "---\ntitle: B\n---\n\nB\n");
    writeFileSync(join(root, "examples/a.ts"), "const x = 1;\n");
    chmodSync(join(root, "examples/a.ts"), 0o755);
    writeFileSync(join(root, "terms/a.termth"), "name: Alpha\ndefinition: Definition\n");
    const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><title>Picture</title></svg>';
    writeFileSync(join(root, "figures/picture.svg"), svg);
    writeFileSync(join(root, "icons/a.svg"), svg);
    writeFileSync(
        join(root, "locales/eng.json"),
        JSON.stringify({ a: { title: "A", body: "![](examples/a.ts#L1)\n\n[](terms/a.termth)" } }),
    );
    return root;
};
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it.each([false, true])("uploads files with default layout %s without overwriting", (enabled) => {
    const root = fixture();
    if (enabled)
        updateFiles(root, { action: "layout", enabled, revision: filesSnapshot(root).revision });
    for (const [name, bytes] of [
        ["表.csv", Buffer.from("名前,件数\nA,3\n")],
        ["notes.md", Buffer.from("# Notes\n")],
        ["clip.mp4", Buffer.from([0, 255, 17, 128])],
        ["empty.txt", Buffer.alloc(0)],
    ] as const) {
        const file = enabled ? `files/${name.split(".").pop()}/${name}` : name;
        expect(uploadFile(root, { name, data: bytes.toString("base64") })).toEqual({ file });
        expect(readFileSync(join(root, file))).toEqual(bytes);
        expect(filesSnapshot(root).files.map((file) => file.path)).toContain(file);
    }
    const directory = enabled ? "files/csv/" : "";
    expect(
        uploadFile(root, { name: "表.csv", data: Buffer.from("second").toString("base64") }),
    ).toEqual({ file: `${directory}表-2.csv` });
    expect(readFileSync(join(root, directory, "表.csv"), "utf8")).toBe("名前,件数\nA,3\n");
    expect(readFileSync(join(root, directory, "表-2.csv"), "utf8")).toBe("second");
    expect(compileSite(root).errors).toEqual([]);
});

it("rejects upload traversal, configuration files, malformed data and symlink escapes", () => {
    const root = fixture();
    const before = filesSnapshot(root);
    for (const name of [
        "../escape.txt",
        "/tmp/escape.txt",
        "nested/file.txt",
        ".env",
        "manifest.yaml",
        "docs.config.mjs",
        "a\\b.txt",
    ])
        expect(() => uploadFile(root, { name, data: "YQ==" })).toThrow("Invalid file name");
    expect(() => uploadFile(root, { name: "a.txt", data: "%%%" })).toThrow("Invalid file content");
    expect(() => uploadFile(root, { name: "a.txt", data: null })).toThrow("Invalid file content");
    expect(filesSnapshot(root)).toEqual(before);
    updateFiles(root, { action: "layout", enabled: true, revision: before.revision });
    symlinkSync(tmpdir(), join(root, "files"));
    expect(() => uploadFile(root, { name: "escape.txt", data: "YQ==" })).toThrow("outside");
});

it.each([false, true])("creates documents by file name with default layout %s", (enabled) => {
    const root = fixture();
    if (enabled)
        updateFiles(root, { action: "layout", enabled, revision: filesSnapshot(root).revision });
    const ops = createDocOps(root);
    expect(suggestDocFileName("日本語の資料")).toBe("日本語の資料.md");
    expect(suggestDocFileName(" ..資料/例:1.md ")).toBe("資料-例-1.md");
    expect(suggestDocFileName(" ")).toBe("");
    expect(ops.addFile("日本語の資料.md", "資料")).toEqual({ id: "doc" });
    expect(ops.addFile("Second doc.md", "Second", "a")).toEqual({ id: "second-doc" });
    expect(ops.addFile("Second-doc.md", "Another")).toEqual({ id: "second-doc-2" });
    const directory = enabled ? "files/md" : "content";
    expect(readManifest(root).files?.documents.doc).toBe(`${directory}/日本語の資料.md`);
    expect(readFileSync(join(root, directory, "日本語の資料.md"), "utf8")).toContain("資料");
    expect(compileSite(root).errors).toEqual([]);
    expect(docPath(compileSite(root).artifact.docs, "second-doc")).toBe("/a/second-doc");
    const before = readFileSync(join(root, "manifest.yaml"), "utf8");
    expect(ops.addFile("日本語の資料.md", "Duplicate")).toMatchObject({ status: 409 });
    for (const name of ["../escape.md", "folder/file.md", ".hidden.md", "file.txt", "file"])
        expect(ops.addFile(name, "Invalid")).toMatchObject({ status: 400 });
    expect(readFileSync(join(root, "manifest.yaml"), "utf8")).toBe(before);
});

it("renames physical documents and their references while keeping URLs and translations", () => {
    const root = fixture();
    writeFileSync(
        join(root, "content/b.md"),
        "---\ntitle: B\n---\n\n[A](doc:a)\n\n![](content/a.md#L1)\n",
    );
    writeFileSync(
        join(root, "locales/eng.json"),
        JSON.stringify({
            a: { title: "Translated", body: "[A](doc:a)\n\n![](content/a.md#L1)" },
        }),
    );
    let source = "content/a.md";
    for (const name of ["intro.md", "日本語の資料.md"]) {
        const snapshot = updateFiles(root, {
            action: "rename",
            file: source,
            name,
            revision: filesSnapshot(root).revision,
        });
        const target = `content/${name}`;
        expect(snapshot.layout.documents.a).toBe(target);
        expect(existsSync(join(root, source))).toBe(false);
        expect(readFileSync(join(root, target), "utf8")).toContain("[Other](doc:b)");
        const link = `![](content/${encodeURIComponent(name)}#L1)`;
        expect(readFileSync(join(root, "content/b.md"), "utf8")).toContain(link);
        const catalog = JSON.parse(readFileSync(join(root, "locales/eng.json"), "utf8"));
        expect(catalog.a.body).toContain(link);
        expect(catalog.a.body).toContain("[A](doc:a)");
        const compiled = compileSite(root);
        expect(compiled.errors).toEqual([]);
        expect(docPath(compiled.artifact.docs, "a")).toBe("/a");
        expect(compileSite(root, { locale: "eng" }).artifact.docs[0]?.title).toBe("Translated");
        expect(createDocOps(root).write("a", "---\ntitle: A\n---\n\n[Other](doc:b)\n")).toEqual({
            id: "a",
        });
        source = target;
    }
});

it("refuses unsafe file renames and collisions without changing files", () => {
    const root = fixture();
    const before = filesSnapshot(root);
    const source = readFileSync(join(root, "content/a.md"), "utf8");
    for (const name of ["b.md", "../escape.md", "nested/file.md", ".hidden.md", "file.txt", ""])
        expect(() =>
            updateFiles(root, {
                action: "rename",
                file: "content/a.md",
                name,
                revision: before.revision,
            }),
        ).toThrow();
    expect(filesSnapshot(root)).toEqual(before);
    expect(readFileSync(join(root, "content/a.md"), "utf8")).toBe(source);
});

it("restructures documents and assets, keeping IDs, translations, icons and source exports", () => {
    const root = fixture();
    const snapshot = updateFiles(root, {
        action: "restructure",
        revision: filesSnapshot(root).revision,
    });
    expect(snapshot.layout.documents).toEqual({ a: "files/md/a.md", b: "files/md/b.md" });
    expect(statSync(join(root, "files/ts/a.ts")).mode & 0o777).toBe(0o755);
    expect(snapshot.layout.icons).toEqual({ a: "files/svg/a.svg" });
    expect(readFileSync(join(root, "files/md/a.md"), "utf8")).toContain("![](files/ts/a.ts#L1)");
    expect(readFileSync(join(root, "files/md/a.md"), "utf8")).toContain(
        "[](files/termth/a.termth)",
    );
    expect(readFileSync(join(root, "manifest.yaml"), "utf8")).toContain("# Preserve this comment");
    expect(JSON.parse(readFileSync(join(root, "locales/eng.json"), "utf8")).a.body).toContain(
        "files/ts/a.ts#L1",
    );
    expect(compileSite(root).errors).toEqual([]);
    expect(compileSite(root, { locale: "eng" }).errors).toEqual([]);
    expect(compileSite(root).artifact.docs[0]?.icon).toContain("<svg");
    expect(compileSite(root).artifact.docs.map((d) => [d.id, d.file])).toEqual([
        ["a", "files/md/a.md"],
        ["b", "files/md/b.md"],
    ]);
    expect(updateFiles(root, { action: "restructure", revision: snapshot.revision }).files).toEqual(
        snapshot.files,
    );
    const ops = createDocOps(root);
    expect(ops.write("a", "---\ntitle: A\n---\n\nSaved\n")).toEqual({ id: "a" });
    setDocTranslation(root, "jpn", "b", "eng", true);
    expect(ops.rename("a", "alpha")).toEqual({ id: "alpha", updatedRefs: 0 });
    expect(readManifest(root).files?.documents.alpha).toBe("files/md/a.md");
    expect(compileSite(root).errors).toEqual([]);
    const exported = exportEntries(root).map((e) => e.name);
    expect(exported).toContain("files/md/a.md");
    expect(exported).toContain("files/svg/a.svg");
    expect(exported).toContain("files/termth/a.termth");
});
it("rewrites Markdown destinations and definitions without touching literal examples", () => {
    const raw =
        '[x](./a%20b.ts#L2-L3 "a b.ts")\n\n![x][ref]\n\n[ref]: <a%20b.ts> "title"\n\n`[x](a%20b.ts)`\n\n```md\n![](a%20b.ts)\n```\n';
    expect(rewriteFileLinks(raw, new Map([["a b.ts", "files/ts/a b.ts"]]))).toBe(
        raw
            .replace("(./a%20b.ts#L2-L3", "(files/ts/a%20b.ts#L2-L3")
            .replace("<a%20b.ts>", "files/ts/a%20b.ts"),
    );
});
it("moves a selection with folders, preserves order, and blocks stale and unsafe changes", () => {
    const root = fixture();
    let snap = filesSnapshot(root);
    snap = updateFiles(root, {
        action: "move",
        paths: ["examples", "terms/a.termth"],
        directory: "custom",
        revision: snap.revision,
    });
    expect(snap.files.map((f) => f.path)).toContain("custom/examples/a.ts");
    expect(compileSite(root).errors).toEqual([]);
    snap = updateFiles(root, {
        action: "move",
        paths: ["content/b.md"],
        directory: "content",
        before: "content/a.md",
        revision: snap.revision,
    });
    expect(snap.files.findIndex((f) => f.path === "content/b.md")).toBeLessThan(
        snap.files.findIndex((f) => f.path === "content/a.md"),
    );
    expect(() =>
        updateFiles(root, {
            action: "move",
            paths: ["custom"],
            directory: "custom/inside",
            revision: snap.revision,
        }),
    ).toThrow("itself");
    expect(() =>
        updateFiles(root, {
            action: "move",
            paths: ["content/a.md"],
            directory: "../escape",
            revision: snap.revision,
        }),
    ).toThrow("Invalid move");
    const before = readFileSync(join(root, "manifest.yaml"), "utf8");
    writeFileSync(join(root, "custom/examples/a.ts"), "external");
    expect(() => updateFiles(root, { action: "restructure", revision: snap.revision })).toThrow(
        "Files changed",
    );
    expect(readFileSync(join(root, "manifest.yaml"), "utf8")).toBe(before);
    snap = filesSnapshot(root);
    symlinkSync(tmpdir(), join(root, "outside"));
    expect(() =>
        updateFiles(root, {
            action: "move",
            paths: ["content/a.md"],
            directory: "outside",
            revision: snap.revision,
        }),
    ).toThrow();
    expect(existsSync(join(root, "content/a.md"))).toBe(true);
});
it("keeps colliding files and uses default placement for new documents and images", () => {
    const root = fixture();
    mkdirSync(join(root, "other"));
    writeFileSync(join(root, "other/a.ts"), "second");
    let snap = updateFiles(root, { action: "restructure", revision: filesSnapshot(root).revision });
    expect(readFileSync(join(root, "files/ts/a.ts"), "utf8")).toContain("const");
    expect(readFileSync(join(root, "files/ts/a-2.ts"), "utf8")).toBe("second");
    snap = updateFiles(root, { action: "layout", enabled: true, revision: snap.revision });
    expect(snap.layout.defaultLayout).toBe(true);
    const ops = createDocOps(root);
    expect(ops.add("new", "New")).toEqual({ id: "new" });
    expect(existsSync(join(root, "files/md/new.md"))).toBe(true);
    const image = ops.addFigure("x.png", Buffer.from([0, 1, 2]));
    expect(isOpError(image)).toBe(false);
    expect(image).toEqual({ file: "x.png", path: "files/png/x.png" });
    expect(compileSite(root).errors).toEqual([]);
});

it("keeps nested image labels and destination-like titles unchanged", () => {
    const raw = '![some [link](a.svg)](a.svg "title ](a.svg)")\n\n![`[x]`](a.svg)\n';
    expect(rewriteFileLinks(raw, new Map([["a.svg", "files/svg/a.svg"]]))).toBe(
        '![some [link](a.svg)](files/svg/a.svg "title ](a.svg)")\n\n![`[x]`](files/svg/a.svg)\n',
    );
});
it("rolls back references and the manifest when a source cannot be removed", () => {
    const root = fixture();
    const original = filesSnapshot(root);
    const manifest = readFileSync(join(root, "manifest.yaml"), "utf8");
    const body = readFileSync(join(root, "content/a.md"), "utf8");
    chmodSync(join(root, "content"), 0o555);
    try {
        expect(() =>
            updateFiles(root, { action: "restructure", revision: original.revision }),
        ).toThrow();
        expect(readFileSync(join(root, "manifest.yaml"), "utf8")).toBe(manifest);
        expect(readFileSync(join(root, "content/a.md"), "utf8")).toBe(body);
        expect(filesSnapshot(root).files).toEqual(original.files);
    } finally {
        chmodSync(join(root, "content"), 0o755);
    }
});

it("keeps ordinary document IDs that match object properties", () => {
    const root = fixture();
    const ops = createDocOps(root);
    expect(ops.add("constructor", "Constructor")).toEqual({ id: "constructor" });
    updateFiles(root, { action: "layout", enabled: true, revision: filesSnapshot(root).revision });
    expect(compileSite(root).errors).toEqual([]);
    expect(ops.rename("constructor", "new-constructor")).toEqual({
        id: "new-constructor",
        updatedRefs: 0,
    });
    expect(existsSync(join(root, "content/new-constructor.md"))).toBe(true);
});
