import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { flattenTree, MANIFEST_FILE } from "../core/content-metadata.js";
import { docFile, localFile } from "../core/files.js";
import { DEFAULT_LANG } from "../core/language.js";
import { contentLinks, embeddedImages, parseMdast } from "../core/markdown.js";
import { parseDocLink } from "../core/routing.js";
import { themeVariantFile } from "../core/theme-variants.js";
import { assetProse, checkProse, markdownProse } from "./check-prose.js";
import {
    CHECK_KINDS,
    type CheckCode,
    type CheckDiagnostic,
    type CheckOptions,
    type CheckReport,
} from "./check-types.js";
import { parseContentSource } from "./code-blocks.js";
import { compileSite } from "./compile.js";
import { collectRefs, parseDoc } from "./dialect.js";
import { contentLanguageCode, isContentLanguage } from "./language-codes.js";
import { siteContentLanguages, translationFile } from "./locales.js";
import { parseManifestText } from "./manifest.js";
import { textfilePath } from "./textfile.js";
import { siteThemes, themeVariants } from "./theme-variants.js";

export type {
    CheckCode,
    CheckDiagnostic,
    CheckKind,
    CheckOptions,
    CheckReport,
} from "./check-types.js";
export { CHECK_KINDS } from "./check-types.js";

const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
type Context = Pick<CheckDiagnostic, "documentId" | "sourceFile" | "language" | "theme">;

const finish = (report: CheckReport, options: CheckOptions): CheckReport => {
    const key = (d: CheckDiagnostic) =>
        JSON.stringify([d.file, d.line ?? 0, d.code, d.language, d.theme, d.message]);
    report.diagnostics = [...new Map(report.diagnostics.map((d) => [key(d), d])).values()];
    const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    report.diagnostics.sort((a, b) => {
        return compare(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0) || compare(key(a), key(b));
    });
    for (const diagnostic of report.diagnostics) {
        if (diagnostic.severity === "error") report.summary.errors++;
        else if (diagnostic.severity === "warning") report.summary.warnings++;
        else report.summary.info++;
    }
    if (report.exitCode !== 2)
        report.exitCode =
            report.summary.errors || (options.warningsAsErrors && report.summary.warnings) ? 1 : 0;
    return report;
};

/** Read-only, offline consistency audit. Content errors are returned, never written or repaired. */
export const checkSite = (root: string, options: CheckOptions = {}): CheckReport => {
    const report: CheckReport = {
        schemaVersion: 1,
        root: resolve(root),
        checks: [],
        languages: [],
        themes: [],
        diagnostics: [],
        summary: { errors: 0, warnings: 0, info: 0 },
        exitCode: 0,
    };
    const has = (check: "render" | "languages" | "themes") => report.checks.includes(check);
    const add = (
        code: CheckCode,
        severity: CheckDiagnostic["severity"],
        file: string,
        message: string,
        context: Context = {},
        extra: Partial<CheckDiagnostic> = {},
    ) => {
        const check =
            extra.check ??
            (/^(LANGUAGE_|TRANSLATION_)/.test(code)
                ? "languages"
                : /^THEME_/.test(code)
                  ? "themes"
                  : /^(RENDER_|DOCUMENT_|ASSET_|REMOTE_)/.test(code)
                    ? "render"
                    : "config");
        if (check === "config" || has(check))
            report.diagnostics.push({ code, severity, file, message, ...context, ...extra, check });
    };
    try {
        for (const key of Object.keys(options))
            if (!["only", "allowSharedSvg", "warningsAsErrors"].includes(key))
                throw new Error(`Unknown check option: ${key}`);
        if (
            options.only !== undefined &&
            (!Array.isArray(options.only) ||
                !options.only.length ||
                options.only.some((check) => !CHECK_KINDS.includes(check)))
        )
            throw new Error(`only must be a non-empty list of: ${CHECK_KINDS.join(", ")}`);
        report.checks = CHECK_KINDS.filter(
            (check) => !options.only || options.only.includes(check),
        );
        for (const key of ["allowSharedSvg", "warningsAsErrors"] as const)
            if (options[key] !== undefined && typeof options[key] !== "boolean")
                throw new Error(`${key} must be a boolean`);
    } catch (error) {
        add("INVOCATION_INVALID", "error", MANIFEST_FILE, messageOf(error));
        report.exitCode = 2;
        return finish(report, options);
    }
    const cache = new Map<string, Buffer | null>();
    const read = (
        file: string,
        context: Context = {},
        missing: CheckCode = "FILE_MISSING",
    ): Buffer | undefined => {
        let data = cache.get(file);
        if (data === undefined) {
            try {
                const path = textfilePath(report.root, file);
                if (!statSync(path).isFile()) throw new Error("Expected a regular file");
                data = readFileSync(path);
                cache.set(file, data);
            } catch (error) {
                add(
                    (error as NodeJS.ErrnoException).code === "ENOENT"
                        ? missing
                        : "FILE_UNREADABLE",
                    "error",
                    file,
                    messageOf(error),
                    context,
                );
                cache.set(file, null);
            }
        }
        return data ?? undefined;
    };
    const text = (file: string, data: Buffer, context: Context): string | undefined => {
        try {
            const raw = new TextDecoder("utf-8", { fatal: true }).decode(data);
            if (raw.includes("\0")) throw new Error("Expected UTF-8 text, not binary data");
            return raw;
        } catch (error) {
            add("FILE_UNREADABLE", "error", file, messageOf(error), context);
            return undefined;
        }
    };
    const scan = (directory: string, ancestors = new Set<string>()): string[] => {
        try {
            const path = textfilePath(report.root, directory);
            if (!existsSync(path)) return [];
            if (ancestors.has(path)) throw new Error("Directory symlink cycle");
            const next = new Set([...ancestors, path]);
            return readdirSync(path, { withFileTypes: true })
                .sort((a, b) => (a.name < b.name ? -1 : 1))
                .flatMap((entry) => {
                    const file = `${directory}/${entry.name}`;
                    if (entry.name.startsWith(".")) return [];
                    try {
                        if (!localFile(file)) throw new Error("Invalid local file path");
                        return statSync(textfilePath(report.root, file)).isDirectory()
                            ? scan(file, next)
                            : [file];
                    } catch (error) {
                        add("FILE_UNREADABLE", "error", file, messageOf(error));
                        return [];
                    }
                });
        } catch (error) {
            add("FILE_UNREADABLE", "error", directory, messageOf(error));
            return [];
        }
    };
    const directories = (directory: string): string[] => {
        try {
            const path = textfilePath(report.root, directory);
            if (!existsSync(path)) return [];
            return readdirSync(path)
                .filter((name) => !name.startsWith("."))
                .sort();
        } catch (error) {
            add("FILE_UNREADABLE", "error", directory, messageOf(error));
            return [];
        }
    };
    try {
        if (!statSync(report.root).isDirectory()) throw new Error("Docs root must be a directory");
        const data = read(MANIFEST_FILE);
        if (!data) return finish(report, options);
        const raw = text(MANIFEST_FILE, data, {});
        if (raw === undefined) return finish(report, options);
        const manifest = parseManifestText(raw);
        for (const message of manifest.errors)
            add("MANIFEST_INVALID", "error", MANIFEST_FILE, message);
        if (manifest.errors.length) return finish(report, options);
        let sourceLanguage: string;
        try {
            sourceLanguage = contentLanguageCode(manifest.defaultLang ?? DEFAULT_LANG);
        } catch (error) {
            add(
                "LANGUAGE_INVALID",
                "error",
                MANIFEST_FILE,
                messageOf(error),
                {},
                { check: "config" },
            );
            return finish(report, options);
        }
        report.languages = siteContentLanguages(report.root, manifest).sort();
        report.themes = siteThemes(report.root, manifest).sort();
        const localeDirectories = directories("locales");
        for (const language of localeDirectories) {
            if (!isContentLanguage(language))
                add(
                    "LANGUAGE_INVALID",
                    "error",
                    `locales/${language}`,
                    "Translation directories require an ISO 639-3 code.",
                );
            else if (!report.languages.includes(language))
                add(
                    "LANGUAGE_UNDECLARED",
                    "warning",
                    `locales/${language}`,
                    "Language is not offered by the site declaration and will not be displayed.",
                    { language },
                );
        }
        const themeDirectories = directories("themes");
        for (const theme of themeDirectories) {
            if (!/^[a-z][a-z0-9-]*$/.test(theme) || (theme !== "light" && theme !== "dark"))
                add(
                    "THEME_INVALID",
                    "error",
                    `themes/${theme}`,
                    "Theme cannot be selected in the viewer.",
                    { theme },
                );
            else if (!report.themes.includes(theme))
                add(
                    "THEME_UNDECLARED",
                    "warning",
                    `themes/${theme}`,
                    "Theme variant is not enabled by the site declaration and will not be displayed.",
                    { theme },
                );
        }
        const docs = new Map(
            flattenTree(manifest.tree)
                .filter((node) => !node.subformat)
                .map(({ id }) => [docFile(id, manifest.files), id]),
        );
        const visited = new Set<string>();
        const checkedThemes = new Set<string>();
        const checkAsset = (file: string, context: Context, withThemes = true): void => {
            if (/^[a-z][a-z\d+.-]*:/i.test(file)) {
                add(
                    "REMOTE_UNCHECKED",
                    "info",
                    file,
                    "Remote content is not fetched by the offline audit.",
                    context,
                );
                return;
            }
            file = file.replace(/^(\.\/)+/, "");
            const key = JSON.stringify([file, context.language, context.theme]);
            if (visited.has(key)) {
                if (withThemes) checkThemes(file, context);
                return;
            }
            visited.add(key);
            const data = read(file, context);
            if (!data) return;
            if (/\.(md|callouth|termth|graphth|schemath|txt|html|svg)$/.test(file)) {
                const raw = text(file, data, context);
                if (raw !== undefined) {
                    const syntax = /\.(callouth|termth|graphth|schemath)$/.exec(file)?.[1];
                    for (const error of (syntax
                        ? parseContentSource(syntax, raw, file)?.errors
                        : []) ?? [])
                        add("ASSET_INVALID", "error", file, error.message, context, {
                            line: error.line + 1,
                        });
                    const declared =
                        /<(?:svg|html)\b[^>]*\s(?:xml:)?lang\s*=\s*["']([^"']+)["']/i.exec(
                            raw,
                        )?.[1];
                    if (/\.(svg|html)$/.test(file) && declared) {
                        try {
                            const actual = contentLanguageCode(declared);
                            if (actual !== context.language)
                                add(
                                    "LANGUAGE_MISMATCH",
                                    "error",
                                    file,
                                    `Markup declares ${actual}; expected ${context.language}.`,
                                    context,
                                    { detectedLanguage: actual },
                                );
                        } catch (error) {
                            add("LANGUAGE_INVALID", "error", file, messageOf(error), context);
                        }
                    }
                    for (const finding of has("languages")
                        ? checkProse(
                              assetProse(file, raw) ?? [],
                              context.language ?? sourceLanguage,
                          )
                        : [])
                        report.diagnostics.push({
                            ...context,
                            ...finding,
                            file,
                            check: "languages",
                        });
                    if (/\.(md|callouth)$/.test(file)) checkRefs(raw, context, file);
                }
            } else
                add(
                    "LANGUAGE_UNCHECKED",
                    "info",
                    file,
                    "Language checking is unavailable for this file format; code and binary files are not classified.",
                    context,
                );
            if (withThemes) checkThemes(file, context);
        };
        const checkThemes = (file: string, context: Context): void => {
            if (!has("themes") && !has("languages")) return;
            const key = JSON.stringify([file, context.language]);
            if (file.startsWith("themes/") || checkedThemes.has(key)) return;
            checkedThemes.add(key);
            const original = read(file, context);
            let variants: Record<string, string>;
            try {
                variants = themeVariants(report.root, file, report.themes);
            } catch (error) {
                add("FILE_UNREADABLE", "error", file, messageOf(error), context);
                return;
            }
            const hashes = new Map<string, string>();
            const hash = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
            if (original) hashes.set(hash(original), file);
            for (const theme of report.themes) {
                if (!manifest.themes && !variants[theme]) continue;
                const target = variants[theme] ?? themeVariantFile(file, theme);
                const ctx = { ...context, sourceFile: file, theme };
                const variant = read(target, ctx, "THEME_VARIANT_MISSING");
                if (!variant) continue;
                const digest = has("themes") ? hash(variant) : "";
                const relatedFile = hashes.get(digest);
                if (relatedFile && !(options.allowSharedSvg && file.toLowerCase().endsWith(".svg")))
                    add(
                        "THEME_CONTENT_IDENTICAL",
                        "error",
                        target,
                        "Theme variant has identical bytes to another variant or the source.",
                        ctx,
                        { relatedFile },
                    );
                hashes.set(digest, target);
                checkAsset(target, ctx, false);
            }
        };
        const checkRefs = (raw: string, context: Context, owner: string): void => {
            const tree = parseMdast(raw);
            const refs = collectRefs(tree);
            for (const file of [...refs.figures, ...refs.textfiles]) checkAsset(file, context);
            for (const file of refs.terms) checkAsset(file, context, false);
            for (const image of embeddedImages(tree))
                if (/^https?:\/\//i.test(image.url))
                    add(
                        "REMOTE_UNCHECKED",
                        "info",
                        owner,
                        "Remote content is not fetched by the offline audit.",
                        context,
                        { line: image.position?.start.line },
                    );
            for (const link of contentLinks(tree)) {
                try {
                    const target = parseDocLink(link.url);
                    if (target && !docs.has(target.file))
                        add(
                            "DOCUMENT_INVALID",
                            "error",
                            owner,
                            `Linked document is not registered: ${target.file}`,
                            context,
                            { line: link.position?.start.line, relatedFile: target.file },
                        );
                } catch (error) {
                    add("DOCUMENT_INVALID", "error", owner, messageOf(error), context, {
                        line: link.position?.start.line,
                    });
                }
            }
        };
        const checkDocument = (
            file: string,
            sourceFile: string,
            language: string,
            documentId: string,
        ): void => {
            const context = { sourceFile, language, documentId };
            if (file !== sourceFile && !manifest.languages) {
                try {
                    if (!existsSync(textfilePath(report.root, file))) return;
                } catch (error) {
                    add("FILE_UNREADABLE", "error", file, messageOf(error), context);
                    return;
                }
            }
            const data = read(
                file,
                context,
                file === sourceFile ? "FILE_MISSING" : "TRANSLATION_MISSING",
            );
            if (!data) return;
            const raw = text(file, data, context);
            if (raw === undefined) return;
            const doc = parseDoc(raw, undefined, file);
            for (const message of doc.errors)
                add("DOCUMENT_INVALID", "error", file, message, context, {
                    line: Number(/^L(\d+):/.exec(message)?.[1]) || undefined,
                });
            if (doc.frontmatter?.lang) {
                try {
                    const actual = contentLanguageCode(doc.frontmatter.lang);
                    if (actual !== language)
                        add(
                            "LANGUAGE_MISMATCH",
                            "error",
                            file,
                            `Front-matter declares ${actual}; expected ${language}.`,
                            context,
                            { detectedLanguage: actual },
                        );
                } catch (error) {
                    add("LANGUAGE_INVALID", "error", file, messageOf(error), context);
                }
            }
            if (has("languages")) {
                const prose = markdownProse(doc.root);
                if (doc.frontmatter?.title)
                    prose.unshift({ text: doc.frontmatter.title, line: 2, column: 1 });
                for (const finding of checkProse(prose, language))
                    report.diagnostics.push({ ...context, ...finding, file, check: "languages" });
            }
            if (has("languages") && file !== sourceFile) {
                const sourceData = read(sourceFile, context);
                const source = sourceData && text(sourceFile, sourceData, context);
                if (
                    source !== undefined &&
                    markdownProse(doc.root).some((segment) => /\p{L}/u.test(segment.text)) &&
                    parseDoc(source).body.trim() === doc.body.trim()
                )
                    add(
                        "TRANSLATION_IDENTICAL",
                        "warning",
                        file,
                        "Translation body is identical to the source.",
                        context,
                        { relatedFile: sourceFile },
                    );
            }
            checkRefs(raw, context, file);
        };
        for (const [file, id] of docs)
            for (const language of report.languages)
                checkDocument(
                    language === sourceLanguage ? file : translationFile(file, language),
                    file,
                    language,
                    id,
                );
        for (const language of has("languages")
            ? localeDirectories.filter(isContentLanguage)
            : []) {
            for (const file of scan(`locales/${language}`)) {
                const sourceFile = file.slice(`locales/${language}/`.length);
                if (docs.has(sourceFile) && language !== sourceLanguage) continue;
                if (
                    (!docs.has(sourceFile) && sourceFile.endsWith(".md")) ||
                    language === sourceLanguage
                ) {
                    add(
                        "TRANSLATION_ORPHAN",
                        "warning",
                        file,
                        "Translation has no registered source document, or duplicates the source-language directory.",
                        { sourceFile, language },
                    );
                } else {
                    try {
                        if (!existsSync(textfilePath(report.root, sourceFile)))
                            add(
                                "TRANSLATION_ORPHAN",
                                "warning",
                                file,
                                "Translation has no source file.",
                                { sourceFile, language },
                            );
                    } catch (error) {
                        add("FILE_UNREADABLE", "error", file, messageOf(error));
                    }
                }
                checkAsset(file, { sourceFile, language }, false);
            }
        }
        for (const theme of has("themes") || has("languages") ? themeDirectories : [])
            for (const file of scan(`themes/${theme}`)) {
                const sourceFile = file.slice(`themes/${theme}/`.length);
                try {
                    if (!existsSync(textfilePath(report.root, sourceFile))) {
                        add(
                            "THEME_VARIANT_ORPHAN",
                            "warning",
                            file,
                            "Theme variant has no source file.",
                            { sourceFile, theme },
                        );
                        checkAsset(file, { sourceFile, theme, language: sourceLanguage }, false);
                    } else {
                        const language =
                            /^locales\/([^/]+)\//.exec(sourceFile)?.[1] ?? sourceLanguage;
                        if (!checkedThemes.has(JSON.stringify([sourceFile, language])))
                            checkAsset(sourceFile, { language });
                    }
                } catch (error) {
                    add("FILE_UNREADABLE", "error", file, messageOf(error));
                }
            }
        for (const file of [
            manifest.icon,
            ...Object.values(manifest.themeIcons ?? {}),
            ...Object.values(manifest.files?.icons ?? {}),
        ])
            if (file) checkAsset(file, { language: sourceLanguage }, false);
        if (has("render")) {
            // Resolve with the viewer's compiler, including translated links and theme-specific assets.
            for (const language of report.languages) {
                try {
                    for (const directory of ["content", "figures", "icons"])
                        textfilePath(report.root, directory);
                    const compiled = compileSite(report.root, { locale: language });
                    for (const message of compiled.siteErrors) {
                        const prefix = message.split(":")[0] ?? "";
                        add(
                            "RENDER_INVALID",
                            "error",
                            localFile(prefix) ? prefix : MANIFEST_FILE,
                            message,
                            { language },
                        );
                    }
                    for (const [sourceFile, source] of compiled.sources) {
                        const candidate =
                            language === sourceLanguage
                                ? sourceFile
                                : translationFile(sourceFile, language);
                        const file = cache.get(candidate) ? candidate : sourceFile;
                        for (const message of source.errors)
                            add(
                                "DOCUMENT_INVALID",
                                "error",
                                file,
                                message,
                                { sourceFile, language, documentId: docs.get(sourceFile) },
                                { line: Number(/^L(\d+):/.exec(message)?.[1]) || undefined },
                            );
                    }
                } catch (error) {
                    add("RENDER_INVALID", "error", MANIFEST_FILE, messageOf(error), { language });
                }
            }
        }
    } catch (error) {
        add("CHECK_FAILED", "error", ".", messageOf(error));
        report.exitCode = 2;
    }
    return finish(report, options);
};
