import { execFileSync } from "node:child_process";
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
import { serializeManifest } from "../core/content-metadata.js";
import { suggestDocFileName } from "../core/files.js";
import { docPath } from "../core/routing.js";
import { compileSite, createCompiler } from "./compile.js";
import { exportEntries } from "./export.js";
import {
    completeFilePaths,
    filesSnapshot,
    rewriteFileLinks,
    updateFiles,
    uploadFile,
} from "./files.js";
import { setDocTranslation } from "./locales.js";
import { readManifest } from "./manifest.js";
import { createDocOps, isOpError } from "./ops.js";
import { readTextfile, writeTextfile } from "./textfile.js";

const roots: string[] = [];
const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-files-"));
    roots.push(root);
    for (const dir of ["content", "terms", "figures", "examples", "icons", "locales"])
        mkdirSync(join(root, dir));
    writeFileSync(
        join(root, "dooc.yaml"),
        "# Preserve this comment\ntitle: Test\ndefaultLang: jpn\ndocs: [a, b]\n",
    );
    writeFileSync(
        join(root, "content/a.md"),
        "---\ntitle: A\n---\n\n[Other](content/b.md)\n\n![](figures/picture.svg)\n\n![](examples/a.ts#L1)\n\n[](terms/a.termth)\n",
    );
    writeFileSync(join(root, "content/b.md"), "---\ntitle: B\n---\n\nB\n");
    writeFileSync(join(root, "examples/a.ts"), "const x = 1;\n");
    chmodSync(join(root, "examples/a.ts"), 0o755);
    writeFileSync(join(root, "terms/a.termth"), "name: Alpha\ndefinition: Definition\n");
    const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><title>Picture</title></svg>';
    writeFileSync(join(root, "figures/picture.svg"), svg);
    writeFileSync(join(root, "icons/a.svg"), svg);
    writeTextfile(
        root,
        "locales/eng/content/a.md",
        "---\ntitle: A\n---\n![](examples/a.ts#L1)\n\n[](terms/a.termth)\n",
        null,
    );
    return root;
};
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(["legacy", "nested"])("retires %s file order while preserving document order", (format) => {
    const root = fixture();
    writeFileSync(
        join(root, "dooc.yaml"),
        format === "legacy"
            ? "docs: [b, a]\nfiles:\n  order: [content/b.md, missing.svg, content/a.md]\n"
            : "system:\n  files:\n    order: [content/b.md, missing.svg, content/a.md]\ncenter_contents:\n  - file: content/b.md\n  - file: content/a.md\n",
    );
    const snapshot = filesSnapshot(root);
    expect(
        snapshot.files.filter((file) => file.extension === "md").map((file) => file.path),
    ).toEqual(["content/a.md", "content/b.md"]);
    expect(snapshot.layout).not.toHaveProperty("order");
    const manifest = readManifest(root);
    expect(manifest.errors).toEqual([]);
    expect(serializeManifest(manifest.tree, manifest)).not.toMatch(/\border:/);
    expect(compileSite(root).docs.map((doc) => doc.file)).toEqual(["content/b.md", "content/a.md"]);
    updateFiles(root, {
        action: "move",
        paths: ["content/b.md"],
        directory: "content",
        revision: snapshot.revision,
    });
    expect(readFileSync(join(root, "dooc.yaml"), "utf8")).not.toMatch(/\border:/);
});

it("sorts folders first at every level and names in numeric order", () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-file-order-"));
    roots.push(root);
    mkdirSync(join(root, "z10"));
    mkdirSync(join(root, "z2/nested"), { recursive: true });
    writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
    for (const file of [
        "z10/a.txt",
        "z2/file10.txt",
        "z2/file2.txt",
        "z2/nested/z.txt",
        "file10.txt",
        "file2.txt",
    ])
        writeFileSync(join(root, file), "");
    expect(filesSnapshot(root).files.map((file) => file.path)).toEqual([
        "z2/nested/z.txt",
        "z2/file2.txt",
        "z2/file10.txt",
        "z10/a.txt",
        "file2.txt",
        "file10.txt",
    ]);
    expect(completeFilePaths(root, "")).toEqual(["z2/", "z10/", "file2.txt", "file10.txt"]);
    expect(completeFilePaths(root, "z2/")).toEqual(["z2/nested/", "z2/file2.txt", "z2/file10.txt"]);
});

it("uses nested ignore rules without a Git repository, including negations and excluded parents", () => {
    const root = fixture();
    mkdirSync(join(root, "private"));
    writeFileSync(join(root, ".gitignore"), "*.txt\nprivate/\nexamples/hidden.ts\n");
    writeFileSync(join(root, "examples/.gitignore"), "!keep.txt\n!hidden.ts\n");
    writeFileSync(join(root, "private/.gitignore"), "!secret.txt\n");
    for (const file of [
        "examples/keep.txt",
        "examples/hidden.ts",
        "examples/secret.txt",
        "private/secret.txt",
    ])
        writeFileSync(join(root, file), "private");
    const files = filesSnapshot(root).files.map((file) => file.path);
    expect(files).toContain("examples/keep.txt");
    expect(files).toContain("examples/hidden.ts");
    expect(files).not.toContain("examples/secret.txt");
    expect(files).not.toContain("private/secret.txt");
    expect(completeFilePaths(root, "examples/")).not.toContain("examples/secret.txt");
});

it("drops ignored assets from cached compilation and rejects aliases to ignored files", () => {
    const root = fixture();
    const compiler = createCompiler(root);
    expect(compiler.compile().figures.some((figure) => figure.file === "figures/picture.svg")).toBe(
        true,
    );
    writeFileSync(
        join(root, ".gitignore"),
        "figures/picture.svg\ncontent/private.md\nicons/private.svg\n",
    );
    writeFileSync(join(root, "content/private.md"), "PRIVATE-DOCUMENT");
    writeFileSync(join(root, "icons/private.svg"), "PRIVATE-ICON");
    const compiled = compiler.compile();
    expect(compiled.figures.some((figure) => figure.file === "figures/picture.svg")).toBe(false);
    expect(JSON.stringify(compiled)).not.toContain("PRIVATE-");
    expect(compiled.errors.join("\n")).not.toContain("private");
    symlinkSync(join(root, "figures/picture.svg"), join(root, "alias.svg"));
    expect(() => readTextfile(root, "alias.svg")).toThrow(/ignored.*alias\.svg/);
    writeFileSync(join(root, ".gitignore"), "");
    expect(compiler.compile().figures.some((figure) => figure.file === "figures/picture.svg")).toBe(
        true,
    );
});

it("follows moves from HTML, SVG and CSS, including relative paths when the owner moves", () => {
    const root = fixture();
    mkdirSync(join(root, "assets"));
    const html =
        '<!-- keep -->\n<img src="../figures/picture.svg?v=1#mark" srcset="../figures/picture.svg 1x, ../figures/picture.svg 2x"><div style="background:url(../figures/picture.svg)"></div><iframe srcdoc="&lt;img src=&quot;../figures/picture.svg&quot;>"></iframe><script>const example = "../figures/picture.svg";</script>';
    writeFileSync(join(root, "assets/card.html"), html);
    writeFileSync(
        join(root, "assets/card.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="../figures/picture.svg#mark"/></svg>',
    );
    writeFileSync(
        join(root, "assets/card.css"),
        '/* keep */\n@import "../examples/a.ts"; p {background: image-set("../figures/picture.svg" 1x, url(../figures/picture.svg) 2x)}',
    );
    updateFiles(root, {
        action: "rename",
        file: "figures/picture.svg",
        name: "new picture.svg",
        revision: filesSnapshot(root).revision,
    });
    const changed = readFileSync(join(root, "assets/card.html"), "utf8");
    expect(changed).toContain('src="../figures/new%20picture.svg?v=1#mark"');
    expect(changed).toContain(
        'srcset="../figures/new%20picture.svg 1x, ../figures/new%20picture.svg 2x"',
    );
    expect(changed).toContain("&lt;img src=&quot;../figures/new%20picture.svg&quot;>");
    expect(changed).toContain('<script>const example = "../figures/picture.svg";</script>');
    expect(readFileSync(join(root, "assets/card.svg"), "utf8")).toContain(
        'xlink:href="../figures/new%20picture.svg#mark"',
    );
    updateFiles(root, {
        action: "move",
        paths: ["assets"],
        directory: "archive",
        revision: filesSnapshot(root).revision,
    });
    expect(readFileSync(join(root, "archive/assets/card.html"), "utf8")).toContain(
        "../../figures/new%20picture.svg?v=1#mark",
    );
    expect(readFileSync(join(root, "archive/assets/card.css"), "utf8")).toContain(
        '@import "../../examples/a.ts"',
    );
    expect(readFileSync(join(root, "archive/assets/card.css"), "utf8")).toContain(
        "../../figures/new%20picture.svg",
    );
});

it("hides Git-ignored files while keeping tracked files and explicit re-inclusions", () => {
    const root = fixture();
    const git = (...args: string[]) =>
        execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
    git("init");
    writeFileSync(join(root, "tracked.log"), "tracked");
    git("add", "tracked.log");
    writeFileSync(join(root, ".gitignore"), "*.log\ncache/\n!keep.log\n");
    mkdirSync(join(root, "cache"));
    mkdirSync(join(root, "files"));
    writeFileSync(join(root, "files/.gitignore"), "private.txt\n");
    writeFileSync(join(root, ".git/info/exclude"), "local.txt\n");
    writeFileSync(join(root, ".global-ignore"), "global.txt\n");
    git("config", "core.excludesFile", join(root, ".global-ignore"));
    for (const file of [
        "debug.log",
        "keep.log",
        "cache/generated.txt",
        "files/private.txt",
        "files/日本語 note.log",
        "local.txt",
        "global.txt",
        "visible.txt",
    ])
        writeFileSync(join(root, file), file);
    const paths = () => filesSnapshot(root).files.map((file) => file.path);
    const visible = paths();
    expect(visible).toEqual(expect.arrayContaining(["tracked.log", "keep.log", "visible.txt"]));
    for (const file of [
        "debug.log",
        "cache/generated.txt",
        "files/private.txt",
        "files/日本語 note.log",
        "local.txt",
        "global.txt",
    ])
        expect(visible).not.toContain(file);
    writeFileSync(join(root, "files/.gitignore"), "");
    expect(paths()).toContain("files/private.txt");
});

it("uses repository ignore rules when the document root is a subdirectory", () => {
    const root = fixture();
    execFileSync("git", ["-C", root, "init"], { stdio: "pipe" });
    writeFileSync(join(root, ".gitignore"), "nested/private.txt\n");
    const docs = join(root, "nested");
    mkdirSync(docs);
    writeFileSync(join(docs, "dooc.yaml"), "docs: []\n");
    writeFileSync(join(docs, "private.txt"), "ignored");
    writeFileSync(join(docs, "public.txt"), "visible");
    expect(filesSnapshot(docs).files.map((file) => file.path)).toEqual(["public.txt"]);
});

it("keeps the default subformat folder subject to ignore rules and follows visible folder moves", () => {
    const root = fixture();
    execFileSync("git", ["-C", root, "init"], { stdio: "pipe" });
    writeFileSync(
        join(root, "dooc.yaml"),
        "docs: []\ndefault_subformat_folder: records\nsubformats: [{ext: issue, format: json, schema: issue.schema.json}]\n",
    );
    writeFileSync(join(root, ".gitignore"), "records/\nelsewhere/\n");
    mkdirSync(join(root, "records/nested"), { recursive: true });
    mkdirSync(join(root, "elsewhere"));
    writeFileSync(join(root, "issue.schema.json"), '{"type":"object"}');
    for (const file of [
        "records/a.issue",
        "records/nested/b.issue",
        "records/secret.txt",
        "elsewhere/c.issue",
    ])
        writeFileSync(join(root, file), "{}");
    symlinkSync(join(root, "elsewhere"), join(root, "records/linked"));
    const snapshot = filesSnapshot(root);
    expect(
        snapshot.files
            .map((file) => file.path)
            .filter((file) => /^(issue.schema.json|records\/|elsewhere\/)/.test(file)),
    ).toEqual(["issue.schema.json"]);
    writeFileSync(join(root, ".gitignore"), "records/secret.txt\nelsewhere/\n");
    updateFiles(root, {
        action: "move",
        paths: ["records"],
        directory: "archive",
        revision: filesSnapshot(root).revision,
    });
    expect(readManifest(root).defaultSubformatFolder).toBe("archive/records");
    expect(existsSync(join(root, "archive/records/a.issue"))).toBe(true);
});

it.each([
    undefined,
    "docs: []\n",
    "files: {}\ndocs: []\n",
])("defaults new documents, figures and translations to format folders: %s", (manifest) => {
    const root = mkdtempSync(join(tmpdir(), "dooc-default-layout-"));
    roots.push(root);
    if (manifest !== undefined) writeFileSync(join(root, "dooc.yaml"), manifest);
    expect(filesSnapshot(root).layout.defaultLayout).toBe(true);
    const ops = createDocOps(root);
    expect(ops.add("guide", "Guide")).toEqual({ id: "guide" });
    expect(readManifest(root).files?.documents.guide).toBe("files/md/guide.md");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>';
    expect(ops.addFigure("diagram.svg", Buffer.from(svg))).toEqual({
        file: "diagram.svg",
        path: "files/svg/diagram.svg",
    });
    expect(ops.write("guide", "---\ntitle: Guide\n---\n\n![](files/svg/diagram.svg)\n")).toEqual({
        id: "guide",
    });
    setDocTranslation(root, "eng", "guide", "jpn", true);
    expect(existsSync(join(root, "locales/jpn/files/md/guide.md"))).toBe(true);
    expect(compileSite(root).errors).toEqual([]);
    expect(compileSite(root, { locale: "jpn" }).errors).toEqual([]);
    expect(exportEntries(root).map((entry) => entry.name)).toEqual(
        expect.arrayContaining([
            "dooc.yaml",
            "files/md/guide.md",
            "files/svg/diagram.svg",
            "locales/jpn/files/md/guide.md",
        ]),
    );
});

it("tracks, exports, and rewrites linked figures, including links in external callouts", () => {
    const root = fixture();
    mkdirSync(join(root, "assets"));
    const image = Buffer.from([0xff, 0xd8, 0xff]);
    writeFileSync(join(root, "assets/photo.jpg"), image);
    writeFileSync(
        join(root, "note.callouth"),
        "[Picture](figures/picture.svg) and [Photo](assets/photo.jpg)\n",
    );
    writeFileSync(join(root, "content/a.md"), "---\ntitle: A\n---\n\n![](note.callouth)\n");
    writeFileSync(
        join(root, "content/b.md"),
        "---\ntitle: B\n---\n\n[Picture](figures/picture.svg)\n",
    );
    const compiled = compileSite(root);
    expect(compiled.errors).toEqual([]);
    expect(compiled.docs[0]?.refs.figures).toContain("picture");
    expect(createDocOps(root).removeFigure("picture")).toMatchObject({
        status: 409,
        referencedBy: ["a", "b"],
    });
    expect(exportEntries(root).find((entry) => entry.name === "assets/photo.jpg")?.data).toEqual(
        image,
    );
    updateFiles(root, {
        action: "rename",
        file: "figures/picture.svg",
        name: "diagram.svg",
        revision: filesSnapshot(root).revision,
    });
    expect(readFileSync(join(root, "note.callouth"), "utf8")).toContain(
        "[Picture](figures/diagram.svg)",
    );
    expect(readFileSync(join(root, "content/b.md"), "utf8")).toContain(
        "[Picture](figures/diagram.svg)",
    );
    expect(compileSite(root).errors).toEqual([]);
    writeFileSync(join(root, "note.callouth"), "[Missing](figures/missing.svg)\n");
    expect(compileSite(root).errors.join()).toContain('"missing.svg" is not in figures/');
});

it("updates links inside fenced and extracted callouts while preserving examples and exports", () => {
    const root = fixture();
    writeFileSync(join(root, "content/b.md"), "---\ntitle: B\n---\n\n# Details\n\nB\n");
    const body =
        "  ~~~callouth Read next\r\n  [B](content/b.md#details)\r\n  `example: [B](content/b.md)`\r\n  ~~~\r\n\r\n![](notes.callouth)\r\n";
    writeFileSync(join(root, "content/a.md"), `---\r\ntitle: A\r\n---\r\n\r\n${body}`);
    writeFileSync(
        join(root, "notes.callouth"),
        "[B](content/b.md#details) and [](terms/a.termth)\n",
    );
    expect(compileSite(root).errors).toEqual([]);
    expect(exportEntries(root).map((entry) => entry.name)).toEqual(
        expect.arrayContaining(["notes.callouth", "terms/a.termth"]),
    );
    updateFiles(root, {
        action: "rename",
        file: "content/b.md",
        name: "next (page).md",
        revision: filesSnapshot(root).revision,
    });
    const updated = readFileSync(join(root, "content/a.md"), "utf8");
    expect(updated).toContain("  [B](content/next%20%28page%29.md#details)\r\n");
    expect(updated).toContain("`example: [B](content/b.md)`");
    expect(readFileSync(join(root, "notes.callouth"), "utf8")).toContain(
        "content/next%20%28page%29.md#details",
    );
    const compiled = compileSite(root);
    expect(compiled.errors).toEqual([]);
    expect(compiled.docs[0]?.refs.terms).toContain("terms/a.termth");
    expect(createDocOps(root).rename("b", "next")).toEqual({ id: "next", updatedRefs: 0 });
    expect(createDocOps(root).remove("next")).toMatchObject({
        status: 409,
        referencedBy: ["a.md", "notes.callouth"],
    });
    writeFileSync(join(root, "notes.callouth"), "[Missing](content/missing.md)\n");
    expect(compileSite(root).errors.join()).toContain(
        'Document link "content/missing.md" is unresolved',
    );
});

it("rejects a rename with an unclosed callout before changing files, translations, or the manifest", () => {
    const root = fixture();
    writeFileSync(
        join(root, "content/a.md"),
        "---\ntitle: A\n---\n\n~~~callouth\n[B](content/b.md)\n",
    );
    const manifest = readFileSync(join(root, "dooc.yaml"), "utf8");
    const translated = readFileSync(join(root, "locales/eng/content/a.md"), "utf8");
    expect(createDocOps(root).rename("b", "next")).toMatchObject({ status: 409 });
    expect(existsSync(join(root, "content/b.md"))).toBe(true);
    expect(existsSync(join(root, "content/next.md"))).toBe(false);
    expect(readFileSync(join(root, "dooc.yaml"), "utf8")).toBe(manifest);
    expect(readFileSync(join(root, "locales/eng/content/a.md"), "utf8")).toBe(translated);
});
it.each([
    false,
    true,
    undefined,
])("uploads files with default layout %s without overwriting", (enabled) => {
    const root = fixture();
    if (enabled !== undefined)
        updateFiles(root, { action: "layout", enabled, revision: filesSnapshot(root).revision });
    for (const [name, bytes] of [
        ["表.csv", Buffer.from("名前,件数\nA,3\n")],
        ["notes.md", Buffer.from("# Notes\n")],
        ["clip.mp4", Buffer.from([0, 255, 17, 128])],
        ["empty.txt", Buffer.alloc(0)],
    ] as const) {
        const file = enabled !== false ? `files/${name.split(".").pop()}/${name}` : name;
        expect(uploadFile(root, { name, data: bytes.toString("base64") })).toEqual({ file });
        expect(readFileSync(join(root, file))).toEqual(bytes);
        expect(filesSnapshot(root).files.map((file) => file.path)).toContain(file);
    }
    const directory = enabled !== false ? "files/csv/" : "";
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
        "dooc.yaml",
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

it.each([
    false,
    true,
    undefined,
])("creates documents by file name with default layout %s", (enabled) => {
    const root = fixture();
    if (enabled !== undefined)
        updateFiles(root, { action: "layout", enabled, revision: filesSnapshot(root).revision });
    const ops = createDocOps(root);
    expect(suggestDocFileName("日本語の資料")).toBe("日本語の資料.md");
    expect(suggestDocFileName(" ..資料/例:1.md ")).toBe("資料-例-1.md");
    expect(suggestDocFileName(" ")).toBe("");
    expect(ops.addFile("日本語の資料.md", "資料")).toEqual({ id: "doc" });
    expect(ops.addFile("Second doc.md", "Second", "a")).toEqual({ id: "second-doc" });
    expect(ops.addFile("Second-doc.md", "Another")).toEqual({ id: "second-doc-2" });
    const directory = enabled !== false ? "files/md" : "content";
    expect(readManifest(root).files?.documents.doc).toBe(`${directory}/日本語の資料.md`);
    expect(readFileSync(join(root, directory, "日本語の資料.md"), "utf8")).toContain("資料");
    expect(compileSite(root).errors).toEqual([]);
    expect(docPath(compileSite(root).docs, "second-doc")).toBe("/a/second-doc");
    const before = readFileSync(join(root, "dooc.yaml"), "utf8");
    expect(ops.addFile("日本語の資料.md", "Duplicate")).toMatchObject({ status: 409 });
    for (const name of ["../escape.md", "folder/file.md", ".hidden.md", "file.txt", "file"])
        expect(ops.addFile(name, "Invalid")).toMatchObject({ status: 400 });
    expect(readFileSync(join(root, "dooc.yaml"), "utf8")).toBe(before);
});

it("renames physical documents and their references while keeping URLs and translations", () => {
    const root = fixture();
    writeFileSync(
        join(root, "content/b.md"),
        "---\ntitle: B\n---\n\n[A](content/a.md)\n\n![](content/a.md#L1)\n",
    );
    writeFileSync(
        join(root, "locales/eng/content/a.md"),
        "---\ntitle: Translated\n---\n[A](content/a.md)\n\n![](content/a.md#L1)\n",
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
        expect(readFileSync(join(root, target), "utf8")).toContain("[Other](content/b.md)");
        const link = `![](content/${encodeURIComponent(name)}#L1)`;
        expect(readFileSync(join(root, "content/b.md"), "utf8")).toContain(link);
        const translated = readFileSync(join(root, `locales/eng/${target}`), "utf8");
        expect(existsSync(join(root, `locales/eng/${source}`))).toBe(false);
        expect(translated).toContain(link);
        expect(translated).toContain(`[A](content/${encodeURIComponent(name)})`);
        const compiled = compileSite(root);
        expect(compiled.errors).toEqual([]);
        expect(docPath(compiled.docs, "a")).toBe("/a");
        expect(compileSite(root, { locale: "eng" }).docs[0]?.title).toBe("Translated");
        expect(
            createDocOps(root).write("a", "---\ntitle: A\n---\n\n[Other](content/b.md)\n"),
        ).toEqual({
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
    expect(readFileSync(join(root, "dooc.yaml"), "utf8")).toContain("# Preserve this comment");
    expect(readFileSync(join(root, "locales/eng/files/md/a.md"), "utf8")).toContain(
        "files/ts/a.ts#L1",
    );
    expect(compileSite(root).errors).toEqual([]);
    expect(compileSite(root, { locale: "eng" }).errors).toEqual([]);
    expect(compileSite(root).docs[0]?.icon).toContain("<svg");
    expect(compileSite(root).docs.map((d) => [d.id, d.file])).toEqual([
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
it("keeps file-list document URLs valid across restructuring and hierarchy changes", () => {
    const root = fixture();
    const ops = createDocOps(root);
    expect(ops.move("b", "a")).toEqual({ id: "b" });
    const before = filesSnapshot(root);
    expect(before.documents).toEqual({ "content/a.md": "/a", "content/b.md": "/a/b" });

    const after = updateFiles(root, { action: "restructure", revision: before.revision });
    expect(after.documents).toEqual({ "files/md/a.md": "/a", "files/md/b.md": "/a/b" });
    expect(compileSite(root).errors).toEqual([]);
    expect(ops.rename("a", "renamed")).toMatchObject({ id: "renamed" });
    expect(filesSnapshot(root).documents["files/md/b.md"]).toBe("/renamed/b");
    expect(ops.move("b")).toEqual({ id: "b" });
    expect(filesSnapshot(root).documents["files/md/b.md"]).toBe("/b");
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
it("moves a selection with folders, sorts by name, and blocks stale and unsafe changes", () => {
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
        revision: snap.revision,
    });
    expect(snap.files.findIndex((f) => f.path === "content/b.md")).toBeGreaterThan(
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
    const before = readFileSync(join(root, "dooc.yaml"), "utf8");
    writeFileSync(join(root, "custom/examples/a.ts"), "external");
    expect(() => updateFiles(root, { action: "restructure", revision: snap.revision })).toThrow(
        "Files changed",
    );
    expect(readFileSync(join(root, "dooc.yaml"), "utf8")).toBe(before);
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
    const manifest = readFileSync(join(root, "dooc.yaml"), "utf8");
    const body = readFileSync(join(root, "content/a.md"), "utf8");
    chmodSync(join(root, "content"), 0o555);
    try {
        expect(() =>
            updateFiles(root, { action: "restructure", revision: original.revision }),
        ).toThrow();
        expect(readFileSync(join(root, "dooc.yaml"), "utf8")).toBe(manifest);
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
    expect(readManifest(root).files?.documents["new-constructor"]).toBe("files/md/constructor.md");
    expect(existsSync(join(root, "files/md/constructor.md"))).toBe(true);
});

it("completes paths from the project root without traversing hidden or external directories", () => {
    const root = fixture();
    for (const dir of [".dooc", "node_modules", "empty"]) mkdirSync(join(root, dir));
    writeFileSync(join(root, ".env"), "private");
    writeFileSync(join(root, "examples/日本語 (1).ts"), "const x = 1;");
    expect(completeFilePaths(root, "")).toEqual([
        "content/",
        "empty/",
        "examples/",
        "figures/",
        "icons/",
        "terms/",
    ]);
    expect(completeFilePaths(root, "ex")).toEqual(["examples/"]);
    expect(completeFilePaths(root, "examples/")).toEqual([
        "examples/a.ts",
        "examples/日本語 (1).ts",
    ]);
    writeFileSync(join(root, "examples/new.ts"), "new");
    expect(completeFilePaths(root, "examples/n")).toEqual(["examples/new.ts"]);
    expect(completeFilePaths(root, "missing/")).toEqual([]);
    const outside = fixture();
    symlinkSync(outside, join(root, "escape"));
    expect(completeFilePaths(root, "esc")).toEqual([]);
    for (const prefix of ["escape/", "../", "/", ".dooc/", "node_modules/", "examples/../../", 3])
        expect(() => completeFilePaths(root, prefix)).toThrow();
});
