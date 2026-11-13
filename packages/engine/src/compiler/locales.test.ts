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
import { afterEach, describe, expect, it } from "vitest";
import { compileSite, createCompiler } from "./compile.js";
import { exportEntries } from "./export.js";
import { contentLanguageCode, isContentLanguage, webLanguage } from "./language-codes.js";
import {
    setDocTranslation,
    translationFile,
    translationFiles,
    translationLanguages,
} from "./locales.js";
import { createDocOps } from "./ops.js";
import { readTextfile, writeTextfile } from "./textfile.js";

const roots: string[] = [];
const fixture = (): string => {
    const root = mkdtempSync(join(tmpdir(), "docs-locales-"));
    roots.push(root);
    mkdirSync(join(root, "content"));
    writeFileSync(join(root, "dooc.yaml"), "defaultLang: jpn\ndocs:\n  - guide:\n      - child\n");
    writeFileSync(join(root, "content/guide.md"), "原文\n");
    writeFileSync(join(root, "content/child.md"), "詳細の原文\n");
    return root;
};
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("parallel Markdown translations", () => {
    it("adds and removes only the chosen file, preserving edited translations and source", () => {
        const root = fixture();
        const source = readTextfile(root, "content/guide.md");
        const guide = translationFile("content/guide.md", "eng");
        const child = translationFile("content/child.md", "eng");
        writeTextfile(root, child, "Translated child\n", null);
        setDocTranslation(root, "jpn", "guide", "eng", true);
        expect(readTextfile(root, guide)).toContain("原文\n");
        const edited = "Edited translation\n";
        writeTextfile(root, guide, edited, readTextfile(root, guide));
        setDocTranslation(root, "jpn", "guide", "eng", true);
        expect(readTextfile(root, guide)).toBe(edited);
        setDocTranslation(root, "jpn", "guide", "eng", false);
        setDocTranslation(root, "jpn", "guide", "eng", false);
        expect(translationFiles(root)).toEqual([child]);
        expect(readTextfile(root, child)).toContain("Translated child");
        expect(() => setDocTranslation(root, "jpn", "guide", "jpn", false)).toThrow(
            "Source language",
        );
        expect(() => setDocTranslation(root, "jpn", "../guide", "eng", true)).toThrow(
            "Invalid document id",
        );
        expect(() => setDocTranslation(root, "jpn", "guide", "../eng", true)).toThrow("ISO 639-3");
        expect(() => setDocTranslation(root, "jpn", "missing", "eng", true)).toThrow();
        expect(readTextfile(root, "content/guide.md")).toBe(source);
    });

    it("uses ISO 639-3 codes with Web language mapping", () => {
        expect(contentLanguageCode("ja-JP")).toBe("jpn");
        expect(contentLanguageCode("en")).toBe("eng");
        expect(webLanguage("zho")).toBe("zh");
        expect(isContentLanguage("jpn")).toBe(true);
        for (const code of ["zzz", "jp", "ja"]) expect(isContentLanguage(code)).toBe(false);
    });

    it("loads Markdown verbatim, shares the tree, and falls back to the source language", () => {
        const root = fixture();
        const source = readTextfile(root, "content/guide.md");
        const file = translationFile("content/guide.md", "eng");
        const raw = "[Details](content/child.md)\n";
        writeTextfile(root, file, raw, null);
        const compiler = createCompiler(root, { locale: "eng" });
        const result = compiler.compile();
        expect(result.errors).toEqual([]);
        expect(result.docs[0]).toMatchObject({ id: "guide", title: "guide", lang: "eng" });
        expect(result.sources.get("content/guide.md")?.raw).toBe(raw);
        expect(result.docs[1]).toMatchObject({
            id: "child",
            parent: "guide",
            title: "child",
            lang: "jpn",
        });
        expect(compileSite(root, { locale: "jpn" }).docs[0]?.lang).toBe("jpn");
        expect(readTextfile(root, "content/guide.md")).toBe(source);
        expect(translationLanguages(root)).toEqual(["eng"]);
        expect(
            exportEntries(root)
                .find((entry) => entry.name === file)
                ?.data.toString(),
        ).toBe(raw);
        writeTextfile(root, file, `${raw}External edit\n`, raw);
        expect(compiler.compile().docs[0]?.body).toContain("External edit");
        rmSync(join(root, file));
        expect(compiler.compile().docs[0]).toMatchObject({ title: "guide", lang: "jpn" });
    });

    it("validates translations as Markdown and keeps broken text editable", () => {
        const root = fixture();
        const raw = "---\ntitle: Broken\n---\n";
        writeTextfile(root, translationFile("content/guide.md", "eng"), raw, null);
        const result = compileSite(root, { locale: "eng" });
        expect(result.errors.join()).toContain("front-matter");
        expect(result.sources.get("content/guide.md")?.raw).toBe(raw);
        expect(compileSite(root).errors).toEqual([]);
    });

    it("rejects unsafe language codes, paths and symlinks outside the project", () => {
        const root = fixture();
        const outside = fixture();
        for (const code of ["../eng", "zzz"])
            expect(() => translationFile("content/guide.md", code)).toThrow();
        expect(() => translationFile("../guide.md", "eng")).toThrow();
        expect(() => compileSite(root, { locale: "en" })).toThrow();
        mkdirSync(join(root, "locales/eng"), { recursive: true });
        symlinkSync(join(outside, "content"), join(root, "locales/eng/content"));
        expect(() => setDocTranslation(root, "jpn", "guide", "eng", true)).toThrow(
            "outside the docs root",
        );
        expect(compileSite(root, { locale: "eng" }).errors.join()).toContain(
            "outside the docs root",
        );
        expect(readTextfile(outside, "content/guide.md")).toContain("原文");
        rmSync(join(root, "locales/eng/content"));
        mkdirSync(join(root, "locales/eng/content"));
        symlinkSync(join(outside, "content/guide.md"), join(root, "locales/eng/content/guide.md"));
        expect(() => exportEntries(root)).toThrow("outside the docs root");
    });

    it("renames translated files and links, and protects references before deleting every version", () => {
        const root = fixture();
        const guide = translationFile("content/guide.md", "eng");
        writeTextfile(root, guide, "[Child](content/child.md)\n", null);
        const child = translationFile("content/child.md", "eng");
        const childRaw = "---\n# Keep this comment\ntitle: Child\n---\nTranslation\n";
        writeTextfile(root, child, childRaw, null);
        const ops = createDocOps(root);
        expect(ops.rename("child", "detail")).toMatchObject({ id: "detail", updatedRefs: 1 });
        expect(readTextfile(root, guide)).toContain("content/detail.md");
        const detail = translationFile("content/detail.md", "eng");
        expect(readTextfile(root, detail)).toBe(childRaw);
        expect(existsSync(join(root, child))).toBe(false);
        expect(ops.remove("detail")).toMatchObject({ status: 409, referencedBy: [guide] });
        expect(ops.remove("detail", true)).toMatchObject({ danglingRefs: 1 });
        expect(existsSync(join(root, detail))).toBe(false);
    });

    it("refuses translated destination collisions before renaming any source", () => {
        const root = fixture();
        const target = translationFile("content/detail.md", "eng");
        writeTextfile(root, target, "Existing translation", null);
        expect(createDocOps(root).rename("child", "detail")).toMatchObject({ status: 409 });
        expect(existsSync(join(root, "content/child.md"))).toBe(true);
        expect(existsSync(join(root, "content/detail.md"))).toBe(false);
        expect(readFileSync(join(root, target), "utf8")).toBe("Existing translation");
    });
});
