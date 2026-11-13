import {
    linkSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseManifest, serializeManifest } from "../core/content-metadata.js";
import { checkSite } from "./check.js";
import { compileSite } from "./compile.js";
import { setDocTranslation, siteContentLanguages } from "./locales.js";
import { parseManifestText } from "./manifest.js";
import { createDocOps } from "./ops.js";

const english =
    "This documentation explains how to configure the application and prepare translated content. When a required file is missing, the validation report identifies the affected document and the language that needs attention.";
const japanese =
    "この文書では、設定ファイルの使い方と翻訳の作成方法について説明します。指定した言語のファイルが不足している場合は、検証結果に問題の場所が表示されます。";
const french =
    "Cette documentation explique comment configurer une application et préparer les traductions. Lorsqu'un fichier obligatoire est absent, le rapport indique le document concerné et la langue qui nécessite une traduction.";
const roots: string[] = [];
const put = (root: string, file: string, raw: string | Buffer) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), raw);
};
const document = (body: string) => `${body}\n`;
const fixture = (settings = "languages: [eng]", body = english) => {
    const root = mkdtempSync(join(tmpdir(), "dooc-check-"));
    roots.push(root);
    put(
        root,
        "dooc.yaml",
        `defaultLang: eng\n${settings.replace(", themes:", "\nthemes:")}\ndocs: [guide]\n`,
    );
    put(root, "content/guide.md", document(body));
    return root;
};
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("site declarations", () => {
    it("round trips required languages and themes through manifest writes", () => {
        const manifest = parseManifest({
            defaultLang: "ja",
            languages: ["jpn", "eng"],
            themes: ["light", "dark"],
            docs: ["guide"],
        });
        expect(manifest.errors).toEqual([]);
        expect(parseManifestText(serializeManifest(manifest.tree, manifest))).toEqual(manifest);
    });
    it("preserves site declarations when existing document operations rewrite the manifest", () => {
        const root = fixture("languages: [eng, jpn], themes: [light, dark]");
        expect(createDocOps(root).rename("guide", "start")).not.toHaveProperty("error");
        expect(parseManifestText(readFileSync(join(root, "dooc.yaml"), "utf8"))).toMatchObject({
            languages: ["eng", "jpn"],
            themes: ["light", "dark"],
        });
    });
    it.each([
        { languages: null },
        { languages: {} },
        { languages: ["ja", "jpn"] },
        { languages: ["jpn"] },
        { themes: ["sepia"] },
        { themes: [] },
        { check: { languages: ["eng"] } },
        { typo: [] },
        { languages: [] },
        { languages: "eng" },
        { languages: ["eng", "eng"] },
        { only: ["typo" as "render"] },
        { themes: ["../dark"] },
        { themes: [1] },
    ])("rejects invalid settings %j", (declarations) => {
        expect(parseManifest({ docs: [], ...declarations }).errors.length).toBeGreaterThan(0);
    });
});

describe("consistency report", () => {
    it("runs all checks by default and limits diagnostics to requested checks", () => {
        const root = fixture(
            "languages: [eng], themes: [dark]",
            `<div>raw</div>\n\n${japanese}\n\n![Diagram](files/a.svg)`,
        );
        put(
            root,
            "files/a.svg",
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"></svg>',
        );
        const full = checkSite(root);
        expect(full.checks).toEqual(["render", "languages", "themes"]);
        expect(full.diagnostics.map((d) => d.code)).toEqual(
            expect.arrayContaining([
                "DOCUMENT_INVALID",
                "LANGUAGE_SUSPECT",
                "THEME_VARIANT_MISSING",
            ]),
        );
        for (const check of ["render", "languages", "themes"] as const) {
            const partial = checkSite(root, { only: [check] });
            expect(partial.checks).toEqual([check]);
            expect(partial.diagnostics.length).toBeGreaterThan(0);
            expect(partial.diagnostics.every((d) => d.check === check)).toBe(true);
        }
        expect(checkSite(root, { only: [] }).exitCode).toBe(2);
        put(root, "dooc.yaml", "languages: [unknown]\ndocs: []\n");
        expect(checkSite(root, { only: ["themes"] }).diagnostics).toContainEqual(
            expect.objectContaining({ code: "MANIFEST_INVALID", check: "config" }),
        );
    });

    it("uses the same declared languages as compilation and translation creation", () => {
        const root = fixture("languages: [eng, jpn]");
        put(root, "locales/jpn/content/guide.md", document(japanese));
        put(root, "locales/fra/content/guide.md", document(french));
        expect(siteContentLanguages(root)).toEqual(["eng", "jpn"]);
        expect(checkSite(root).languages).toEqual(["eng", "jpn"]);
        expect(compileSite(root, { locale: "jpn" }).docs[0]?.body).toContain(japanese);
        expect(() => compileSite(root, { locale: "fra" })).toThrow("not declared");
        expect(() => setDocTranslation(root, "eng", "guide", "fra", true)).toThrow("not declared");
        expect(checkSite(root).diagnostics).toContainEqual(
            expect.objectContaining({ code: "LANGUAGE_UNDECLARED", language: "fra" }),
        );
    });

    it("reports missing translations even when the viewer can fall back to the source", () => {
        const root = fixture("languages: [eng, jpn]");
        const rendered = compileSite(root, { locale: "jpn" });
        expect(rendered.errors).toEqual([]);
        expect(rendered.docs[0]?.lang).toBe("eng");
        expect(checkSite(root).diagnostics).toContainEqual(
            expect.objectContaining({ code: "TRANSLATION_MISSING", language: "jpn" }),
        );
        expect(checkSite(root, { only: ["render"] }).exitCode).toBe(0);
    });

    it("uses declared theme resolution and reports the viewer's fallback as a missing variant", () => {
        const root = fixture(
            "languages: [eng], themes: [dark]",
            `${english}\n\n![Diagram](files/a.svg)`,
        );
        const svg = (fill: string) =>
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect fill="${fill}"/></svg>`;
        put(root, "files/a.svg", svg("gray"));
        put(root, "themes/light/files/a.svg", svg("black"));
        expect(compileSite(root).docs[0]?.blocks.at(-1)?.type).toBe("figureRef");
        expect(checkSite(root).diagnostics).toContainEqual(
            expect.objectContaining({ code: "THEME_VARIANT_MISSING", theme: "dark" }),
        );
        put(root, "themes/dark/files/a.svg", svg("white"));
        expect(compileSite(root).docs[0]?.blocks.at(-1)).toMatchObject({
            type: "themeVariants",
            variants: { dark: { type: "figureRef" } },
        });
        const block = compileSite(root).docs[0]?.blocks.at(-1);
        expect(block?.type === "themeVariants" && Object.keys(block.variants)).toEqual(["dark"]);
        expect(checkSite(root, { only: ["themes"] }).diagnostics.map((d) => d.code)).toEqual([
            "THEME_UNDECLARED",
        ]);
    });

    it("shares renderer validation of heading links and embedded line ranges across languages", () => {
        const root = fixture(
            "languages: [eng, jpn]",
            `${english}\n\n# Details\n\n[Details](content/guide.md#details)\n\n![Excerpt](files/example.txt#L1-L9)`,
        );
        put(root, "files/example.txt", "one line\n");
        put(
            root,
            "locales/jpn/content/guide.md",
            document(`${japanese}\n\n# Different\n\n[Details](content/guide.md#details)`),
        );
        const report = checkSite(root, { only: ["render"] });
        expect(report.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    code: "DOCUMENT_INVALID",
                    file: "content/guide.md",
                    message: expect.stringContaining("range line 9"),
                }),
                expect.objectContaining({
                    code: "DOCUMENT_INVALID",
                    file: "locales/jpn/content/guide.md",
                    language: "jpn",
                    message: expect.stringContaining("missing heading"),
                }),
            ]),
        );
        expect(compileSite(root, { locale: "jpn" }).errors.join()).toContain("missing heading");
    });

    it("passes complete translations with normalized language tags and deterministic output", () => {
        const root = fixture("languages: [en-US, ja-JP, fra]");
        put(root, "locales/jpn/content/guide.md", document(japanese));
        put(root, "locales/fra/content/guide.md", document(french));
        const before = readFileSync(join(root, "dooc.yaml"));
        const report = checkSite(root, { warningsAsErrors: true });
        expect(report).toMatchObject({
            schemaVersion: 1,
            languages: ["eng", "fra", "jpn"],
            exitCode: 0,
            summary: { errors: 0, warnings: 0 },
        });
        expect(JSON.parse(JSON.stringify(report))).toEqual(
            checkSite(root, { warningsAsErrors: true }),
        );
        expect(readFileSync(join(root, "dooc.yaml"))).toEqual(before);
    });

    it("reports entirely missing languages and custom document paths without fallback", () => {
        const root = fixture();
        put(
            root,
            "dooc.yaml",
            "defaultLang: eng\nlanguages: [eng, jpn, fra]\ndocs: [guide]\nfiles: {documents: {guide: manual/start.md}}\n",
        );
        put(root, "manual/start.md", document(english));
        const report = checkSite(root);
        expect(report.exitCode).toBe(1);
        expect(report.diagnostics.filter((d) => d.code === "TRANSLATION_MISSING")).toMatchObject([
            {
                file: "locales/fra/manual/start.md",
                sourceFile: "manual/start.md",
                language: "fra",
                documentId: "guide",
                severity: "error",
            },
            { file: "locales/jpn/manual/start.md", sourceFile: "manual/start.md", language: "jpn" },
        ]);
    });

    it("retains legacy language discovery when no language declaration exists", () => {
        const root = fixture();
        put(root, "dooc.yaml", "docs: [guide]\n");
        put(root, "locales/jpn/content/other.md", document(japanese));
        const report = checkSite(root);
        expect(report.diagnostics.map((d) => d.code)).toEqual(
            expect.arrayContaining(["TRANSLATION_ORPHAN"]),
        );
        expect(report.diagnostics.some((d) => d.code === "TRANSLATION_MISSING")).toBe(false);
        expect(report.languages).toEqual(["eng", "jpn"]);
    });

    it("retains viewer fallbacks for undeclared themes without inventing missing variants", () => {
        const root = fixture(
            "languages: [eng]",
            `${english}\n\n![A](files/a.svg)\n\n![B](files/b.svg)`,
        );
        const svg = (fill: string) =>
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect fill="${fill}"/></svg>`;
        put(root, "files/a.svg", svg("gray"));
        put(root, "files/b.svg", svg("gray"));
        put(root, "themes/dark/files/a.svg", svg("white"));
        expect(checkSite(root).exitCode).toBe(0);
        expect(checkSite(root).diagnostics.some((d) => d.code === "THEME_VARIANT_MISSING")).toBe(
            false,
        );
    });

    it("distinguishes copied bodies and inferred language warnings", () => {
        const root = fixture("languages: [eng, jpn]");
        put(root, "locales/jpn/content/guide.md", document(english));
        const report = checkSite(root);
        expect(report.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    code: "TRANSLATION_IDENTICAL",
                    severity: "warning",
                    sourceFile: "content/guide.md",
                }),
                expect.objectContaining({
                    code: "LANGUAGE_SUSPECT",
                    severity: "warning",
                    language: "jpn",
                    detectedLanguage: "eng",
                    line: 1,
                }),
            ]),
        );
    });

    it("finds mixed prose inside documents, callouts, terms and SVG while ignoring ordinary code", () => {
        const root = fixture(
            "languages: [eng]",
            `${english}\n\n${japanese}\n\n\`\`\`js\n${french}\n\`\`\`\n\n\`\`\`callouth\n${japanese}\n\`\`\`\n\n[Term](terms/a.termth)\n\n![Diagram](figures/a.svg)`,
        );
        put(root, "terms/a.termth", `name: Test\ndefinition: ${japanese}\n`);
        put(
            root,
            "figures/a.svg",
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><style>${french}</style><text>${japanese}</text></svg>`,
        );
        const findings = checkSite(root).diagnostics.filter((d) => d.code === "LANGUAGE_SUSPECT");
        expect(findings).toHaveLength(4);
        expect(findings.every((d) => d.detectedLanguage === "jpn")).toBe(true);
        expect(findings.map((d) => d.file)).toEqual(
            expect.arrayContaining(["content/guide.md", "terms/a.termth", "figures/a.svg"]),
        );
    });

    it("uses warning policy without changing diagnostic severity and marks inconclusive text", () => {
        const root = fixture("languages: [eng]", japanese);
        expect(checkSite(root).exitCode).toBe(0);
        const strict = checkSite(root, { warningsAsErrors: true });
        expect(strict).toMatchObject({ exitCode: 1, summary: { errors: 0, warnings: 1 } });
        put(root, "content/guide.md", document("Hi"));
        expect(checkSite(root).diagnostics).toContainEqual(
            expect.objectContaining({ code: "LANGUAGE_UNDETERMINED", severity: "info" }),
        );
    });

    it("checks mixed sentences and prose beyond the detector's sample length", () => {
        const root = fixture("languages: [eng]", `${english.repeat(20)} ${japanese}`);
        expect(checkSite(root).diagnostics).toContainEqual(
            expect.objectContaining({
                code: "LANGUAGE_SUSPECT",
                detectedLanguage: "jpn",
                file: "content/guide.md",
            }),
        );
    });

    it("checks semantic asset syntax, markup language declarations and document references", () => {
        const root = fixture(
            "languages: [eng]",
            `${english}\n\n[Missing](content/missing.md)\n\n[Term](terms/broken.termth)\n\n![SVG](figures/a.svg)\n\n![Remote](https://example.com/a.svg)`,
        );
        put(root, "terms/broken.termth", "name: []\n");
        put(root, "figures/a.svg", '<svg xml:lang="ja"><text>OK</text></svg>');
        const report = checkSite(root);
        expect(report.diagnostics.map((d) => d.code)).toEqual(
            expect.arrayContaining([
                "DOCUMENT_INVALID",
                "ASSET_INVALID",
                "LANGUAGE_MISMATCH",
                "REMOTE_UNCHECKED",
            ]),
        );
    });

    it("checks theme text in every language that uses a shared asset", () => {
        const root = fixture(
            "languages: [eng, jpn], themes: [dark]",
            `${english}\n\n![Diagram](figures/a.svg)`,
        );
        put(
            root,
            "locales/jpn/content/guide.md",
            document(`${japanese}\n\n![Diagram](figures/a.svg)`),
        );
        put(
            root,
            "figures/a.svg",
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"></svg>',
        );
        put(
            root,
            "themes/dark/figures/a.svg",
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><text>${english}</text></svg>`,
        );
        expect(checkSite(root).diagnostics).toContainEqual(
            expect.objectContaining({
                code: "LANGUAGE_SUSPECT",
                file: "themes/dark/figures/a.svg",
                language: "jpn",
                theme: "dark",
            }),
        );
    });

    it("does not classify Chinese as the wrong language because franc returns cmn", () => {
        const root = fixture("languages: [eng, zho]");
        put(
            root,
            "locales/zho/content/guide.md",
            document(
                "本文介绍如何配置应用程序并准备翻译内容。如果缺少必需的文件，验证报告将指出受影响的文档和需要翻译的语言。",
            ),
        );
        expect(checkSite(root, { warningsAsErrors: true }).exitCode).toBe(0);
    });

    it.each([
        "copy",
        "symlink",
        "hardlink",
    ])("detects identical theme bytes through %s and only exempts SVG", (kind) => {
        const root = fixture(
            "languages: [eng], themes: [light, dark]",
            `${english}\n\n![A](figures/a.svg)\n\n![B](figures/b.png)`,
        );
        put(
            root,
            "figures/a.svg",
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><text>${english}</text></svg>`,
        );
        put(root, "figures/b.png", Buffer.from([0, 1, 2, 3]));
        for (const file of ["figures/a.svg", "figures/b.png"])
            for (const theme of ["light", "dark"]) {
                const target = join(root, `themes/${theme}/${file}`);
                mkdirSync(dirname(target), { recursive: true });
                if (kind === "copy") writeFileSync(target, readFileSync(join(root, file)));
                else if (kind === "symlink") symlinkSync(join(root, file), target);
                else linkSync(join(root, file), target);
            }
        expect(
            checkSite(root).diagnostics.filter((d) => d.code === "THEME_CONTENT_IDENTICAL"),
        ).toHaveLength(4);
        const allowed = checkSite(root, { allowSharedSvg: true });
        expect(
            allowed.diagnostics
                .filter((d) => d.code === "THEME_CONTENT_IDENTICAL")
                .map((d) => d.file),
        ).toEqual(["themes/dark/figures/b.png", "themes/light/figures/b.png"]);
        expect(allowed.exitCode).toBe(1);
    });

    it("requires missing theme variants even with the SVG exception and accepts distinct variants", () => {
        const root = fixture(
            "languages: [eng], themes: [light, dark]",
            `${english}\n\n![A](figures/a.svg)`,
        );
        put(
            root,
            "figures/a.svg",
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"></svg>',
        );
        expect(
            checkSite(root, { allowSharedSvg: true }).diagnostics.filter(
                (d) => d.code === "THEME_VARIANT_MISSING",
            ),
        ).toHaveLength(2);
        put(
            root,
            "themes/light/figures/a.svg",
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect fill="black"/></svg>',
        );
        put(
            root,
            "themes/dark/figures/a.svg",
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect fill="white"/></svg>',
        );
        expect(checkSite(root).exitCode).toBe(0);
    });

    it("reports invalid directories and orphan themes without ignoring other findings", () => {
        const root = fixture("languages: [eng], themes: [light]");
        put(root, "locales/ja/content/guide.md", document(japanese));
        put(root, "locales/fra/content/other.md", document(french));
        put(
            root,
            "themes/dark/figures/lost.svg",
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"></svg>',
        );
        expect(checkSite(root).diagnostics.map((d) => d.code)).toEqual(
            expect.arrayContaining([
                "LANGUAGE_INVALID",
                "LANGUAGE_UNDECLARED",
                "TRANSLATION_ORPHAN",
                "THEME_UNDECLARED",
                "THEME_VARIANT_ORPHAN",
            ]),
        );
    });

    it("aggregates unreadable files, malformed documents, absent assets and remote exclusions", () => {
        const root = fixture(
            "languages: [eng, jpn]",
            `${english}\n\n![A](figures/missing.svg)\n\n![B](examples/absent.txt)\n\n![Remote](https://example.com/a.txt)`,
        );
        put(root, "locales/jpn/content/guide.md", "Broken\n");
        const report = checkSite(root);
        expect(report.diagnostics.map((d) => d.code)).toEqual(
            expect.arrayContaining(["DOCUMENT_INVALID", "FILE_MISSING"]),
        );
        expect(report.exitCode).toBe(1);
        put(root, "locales/jpn/content/guide.md", Buffer.from([0xff, 0xfe]));
        expect(checkSite(root).diagnostics.map((d) => d.code)).toContain("FILE_UNREADABLE");
    });

    it("rejects symlink escapes for manifest, translations and theme assets without reading targets", () => {
        const root = fixture("languages: [eng, jpn]", `${english}\n\n![A](figures/a.svg)`);
        const outside = fixture();
        put(
            outside,
            "secret.svg",
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><text>${japanese}</text></svg>`,
        );
        mkdirSync(join(root, "figures"));
        symlinkSync(join(outside, "secret.svg"), join(root, "figures/a.svg"));
        mkdirSync(join(root, "locales/jpn"), { recursive: true });
        symlinkSync(join(outside, "content"), join(root, "locales/jpn/content"));
        const report = checkSite(root);
        expect(
            report.diagnostics.filter((d) => d.code === "FILE_UNREADABLE").length,
        ).toBeGreaterThanOrEqual(2);
        expect(report.diagnostics.some((d) => d.code === "LANGUAGE_SUSPECT")).toBe(false);
        rmSync(join(root, "dooc.yaml"));
        symlinkSync(join(outside, "dooc.yaml"), join(root, "dooc.yaml"));
        expect(checkSite(root).diagnostics[0]?.code).toBe("FILE_UNREADABLE");
    });

    it("returns structured failures for invalid YAML, unknown languages, absent manifests and roots", () => {
        const root = fixture();
        put(root, "dooc.yaml", "docs: [\n");
        expect(checkSite(root).diagnostics[0]?.code).toBe("MANIFEST_INVALID");
        put(root, "dooc.yaml", "defaultLang: xyz\ndocs: []\n");
        expect(checkSite(root).diagnostics[0]?.code).toBe("LANGUAGE_INVALID");
        rmSync(join(root, "dooc.yaml"));
        expect(checkSite(root)).toMatchObject({
            exitCode: 1,
            diagnostics: [{ code: "FILE_MISSING" }],
        });
        expect(checkSite(join(root, "missing"))).toMatchObject({
            exitCode: 2,
            diagnostics: [{ code: "CHECK_FAILED" }],
        });
        expect(checkSite(root, { only: ["typo" as "render"] })).toMatchObject({
            exitCode: 2,
            diagnostics: [{ code: "INVOCATION_INVALID" }],
        });
    });
});
