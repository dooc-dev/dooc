import { existsSync, readdirSync } from "node:fs";
import type { ParsedManifest } from "../core/content-metadata.js";
import { localFile } from "../core/files.js";
import { themeVariantFile } from "../core/theme-variants.js";
import { readManifest } from "./manifest.js";
import { textfilePath } from "./textfile.js";

export const themeNames = (root: string): string[] => {
    const directory = textfilePath(root, "themes");
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^[a-z][a-z0-9-]*$/.test(entry.name))
        .map((entry) => entry.name)
        .sort();
};

export const siteThemes = (root: string, manifest: ParsedManifest = readManifest(root)): string[] =>
    manifest.themes ?? themeNames(root);

export const themeVariants = (
    root: string,
    file: string,
    themes = siteThemes(root),
): Record<string, string> => {
    if (!localFile(file) || file.startsWith("themes/")) return {};
    return Object.fromEntries(
        themes
            .map((theme): [string, string] => [theme, themeVariantFile(file, theme)])
            .filter(([, path]) => existsSync(textfilePath(root, path))),
    );
};
