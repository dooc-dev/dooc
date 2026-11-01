import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileSite } from "./compile.js";
import { exportEntries } from "./export.js";
import { contentLanguageCode, isContentLanguage, webLanguage } from "./language-codes.js";
import { catalogLanguages, readCatalog, writeCatalog } from "./locales.js";
import { createDocOps } from "./ops.js";

const fixture = (): string => {
    const root = mkdtempSync(join(tmpdir(), "docs-locales-"));
    mkdirSync(join(root, "content"));
    writeFileSync(join(root, "manifest.yaml"), "- guide:\n    - child\n");
    writeFileSync(join(root, "content/guide.md"), '---\ntitle: "ガイド"\n---\n\n原文\n');
    writeFileSync(join(root, "content/child.md"), '---\ntitle: "詳細"\n---\n\n詳細の原文\n');
    return root;
};

describe("ISO 639-3 content catalogs", () => {
    it("uses the dedicated package for validation and Web language mapping", () => {
        expect(contentLanguageCode("ja-JP")).toBe("jpn");
        expect(contentLanguageCode("en")).toBe("eng");
        expect(webLanguage("zho")).toBe("zh");
        expect(isContentLanguage("jpn")).toBe(true);
        expect(isContentLanguage("zzz")).toBe(false);
        expect(isContentLanguage("jp")).toBe(false);
        expect(isContentLanguage("ja")).toBe(false);
    });

    it("overlays one language, preserves shared IDs/tree and falls back without changing the source", () => {
        const root = fixture();
        const source = readFileSync(join(root, "content/guide.md"), "utf8");
        writeCatalog(root, "eng", { guide: { title: "Guide", body: "[Details](doc:child)\n" } });
        const result = compileSite(root, { defaultLang: "jpn", locale: "eng" });
        expect(result.errors).toEqual([]);
        expect(result.artifact.docs[0]).toMatchObject({ id: "guide", title: "Guide", lang: "eng" });
        expect(result.artifact.docs[1]).toMatchObject({
            id: "child",
            parent: "guide",
            title: "詳細",
            lang: "eng",
        });
        expect(
            compileSite(root, { defaultLang: "jpn", locale: "jpn" }).artifact.docs[0]?.title,
        ).toBe("ガイド");
        expect(readFileSync(join(root, "content/guide.md"), "utf8")).toBe(source);
        expect(catalogLanguages(root)).toEqual(["eng"]);
        expect(exportEntries(root).map((entry) => entry.name)).toContain("locales/eng.json");
    });

    it("rejects traversal, unknown codes and malformed catalog entries", () => {
        const root = fixture();
        expect(() => readCatalog(root, "../eng")).toThrow();
        expect(() => readCatalog(root, "zzz")).toThrow();
        expect(() => compileSite(root, { locale: "en" })).toThrow();
        mkdirSync(join(root, "locales"));
        writeFileSync(join(root, "locales/eng.json"), '{"guide":{"title":"Guide","body":42}}');
        expect(() => readCatalog(root, "eng")).toThrow("invalid translation");
        expect(compileSite(root, { defaultLang: "jpn", locale: "eng" }).errors.join()).toContain(
            "invalid translation",
        );
        expect(createDocOps(root).rename("guide", "renamed")).toMatchObject({ status: 409 });
        expect(readFileSync(join(root, "content/guide.md"), "utf8")).toContain("ガイド");
    });

    it("renames translated IDs and links, and protects references before deleting every version", () => {
        const root = fixture();
        writeCatalog(root, "eng", {
            guide: { title: "Guide", body: "[Child](doc:child)" },
            child: { title: "Child", body: "Translation" },
        });
        const ops = createDocOps(root);
        expect(ops.rename("child", "detail")).toMatchObject({ id: "detail", updatedRefs: 1 });
        expect(readCatalog(root, "eng").guide?.body).toContain("doc:detail");
        expect(readCatalog(root, "eng").detail?.title).toBe("Child");
        expect(ops.remove("detail")).toMatchObject({
            status: 409,
            referencedBy: ["locales/eng.json:guide"],
        });
        expect(ops.remove("detail", true)).toMatchObject({ danglingRefs: 1 });
        expect(readCatalog(root, "eng").detail).toBeUndefined();
    });
});
