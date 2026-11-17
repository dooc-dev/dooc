import type { ParsedManifest } from "../core/content-metadata.js";
import { localFile, manifestDirectory } from "../core/files.js";
import { themeVariantFile } from "../core/theme-variants.js";
import { existsSync, join, posix, readdirSync } from "./host.js";
import { ignoredFiles } from "./ignored-files.js";
import { readManifest, sourceOrigin } from "./manifest.js";
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
    manifest.themes ?? [
        ...new Set([
            ...themeNames(root),
            ...(manifest.includedManifests ?? []).flatMap((file) =>
                themeNames(join(root, posix.dirname(file))),
            ),
        ]),
    ];

export const themeVariants = (
    root: string,
    file: string,
    themes?: string[],
    manifest = readManifest(root),
): Record<string, string> => {
    const directory = manifestDirectory(sourceOrigin(manifest, file));
    const source = file.slice(directory.length);
    if (!localFile(file) || source.startsWith("themes/")) return {};
    const variants = (themes ?? siteThemes(root, manifest))
        .map((theme): [string, string] => [theme, directory + themeVariantFile(source, theme)])
        .filter(([, path]) => existsSync(textfilePath(root, path)));
    const ignored = ignoredFiles(
        root,
        variants.map(([, path]) => path),
    );
    return Object.fromEntries(variants.filter(([, path]) => !ignored.has(path)));
};
