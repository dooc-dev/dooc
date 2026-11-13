// Translations mirror source paths under locales/<ISO 639-3>/ as ordinary Markdown files.

import { isDocId, type ParsedManifest } from "../core/content-metadata.js";
import { localFile } from "../core/files.js";
import { contentLanguageCode, DEFAULT_LANG } from "../core/language.js";
import { existsSync, join, readdirSync, relative, unlinkSync } from "./host.js";
import { ignoredFiles } from "./ignored-files.js";
import { isContentLanguage } from "./language-codes.js";
import { docFile, readManifest } from "./manifest.js";
import { readTextfile, textfilePath, writeTextfile } from "./textfile.js";

export const translationFile = (file: string, language: string): string => {
    if (!isContentLanguage(language)) throw new Error("Expected an ISO 639-3 language code");
    if (!localFile(file) || !file.endsWith(".md")) throw new Error("Expected a Markdown file path");
    return `locales/${language}/${file}`;
};

export const translationLanguages = (root: string): string[] => {
    const dir = textfilePath(root, "locales");
    return existsSync(dir)
        ? readdirSync(dir, { withFileTypes: true })
              .filter((entry) => entry.isDirectory() && isContentLanguage(entry.name))
              .map((entry) => entry.name)
              .sort()
        : [];
};

/** Declared languages are authoritative; older sites retain directory discovery. */
export const siteContentLanguages = (
    root: string,
    manifest: ParsedManifest = readManifest(root),
): string[] =>
    manifest.languages ?? [
        ...new Set([
            contentLanguageCode(manifest.defaultLang ?? DEFAULT_LANG),
            ...translationLanguages(root),
        ]),
    ];

export const translationFiles = (root: string): string[] => {
    const files = translationLanguages(root).flatMap((language) => {
        const directory = `locales/${language}`;
        return readdirSync(textfilePath(root, directory), { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
            .map((entry) =>
                relative(root, join(entry.parentPath, entry.name)).replaceAll("\\", "/"),
            )
            .filter(localFile)
            .sort();
    });
    const ignored = ignoredFiles(root, files);
    return files.filter((file) => !ignored.has(file));
};

export const setDocTranslation = (
    root: string,
    sourceLanguage: string,
    id: string,
    language: string,
    added: boolean,
): void => {
    if (!isDocId(id)) throw new Error("Invalid document id");
    if (language === sourceLanguage) throw new Error("Source language cannot be removed");
    const manifest = readManifest(root);
    if (manifest.errors.length) throw new Error(manifest.errors.join("\n"));
    if (manifest.languages && !manifest.languages.includes(language))
        throw new Error(`Language ${language} is not declared in dooc.yaml languages`);
    const file = docFile(id, manifest.files);
    const translated = translationFile(file, language);
    const path = textfilePath(root, translated);
    const source = readTextfile(root, file);
    if (added === existsSync(path)) return;
    if (added) {
        writeTextfile(root, translated, source, null);
    } else unlinkSync(path);
};
