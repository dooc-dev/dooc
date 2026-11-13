// Reads/writes dooc.yaml (node-dependent). Tree validation and manipulation live in
// core/content-metadata.ts.

import { parse } from "yaml";
import {
    type DocNode,
    isManifestFile,
    MANIFEST_FILE,
    type ParsedManifest,
    parseManifest,
    serializeManifest,
} from "../core/content-metadata.js";
import { createFileCache } from "./file-cache.js";
import { basename, dirname, existsSync, join, resolve, statSync, writeFileSync } from "./host.js";

const manifests = new Map<string, string>();
const parsed = createFileCache<ParsedManifest>();

export const manifestFile = (root: string): string => manifests.get(resolve(root)) ?? MANIFEST_FILE;

/** Select the manifest for subsequent operations on its parent directory. */
export const projectRoot = (input = MANIFEST_FILE): string => {
    const file = resolve(input);
    if (!isManifestFile(basename(file)) || !existsSync(file) || !statSync(file).isFile())
        throw new Error(`Specify an existing dooc.yaml or <name>.dooc.yaml file: ${file}`);
    const root = dirname(file);
    manifests.set(root, basename(file));
    return root;
};

export const parseManifestText = (raw: string, file: string = MANIFEST_FILE): ParsedManifest => {
    let value: unknown;
    try {
        value = parse(raw);
    } catch (e) {
        return {
            tree: [],
            errors: [`${file}: invalid YAML (${e instanceof Error ? e.message : e})`],
        };
    }
    const manifest = parseManifest(value);
    manifest.errors = manifest.errors.map((error) => error.replace(/^dooc\.yaml(?=:)/, () => file));
    return manifest;
};

/** Empty tree if missing (a new docs root with zero docs). */
export const readManifest = (root: string): ParsedManifest => {
    const file = manifestFile(root);
    const path = join(root, file);
    // Callers may edit the result before writing it back, so each gets its own copy.
    return existsSync(path)
        ? structuredClone(parsed.get(path, (raw) => parseManifestText(raw, file)))
        : { tree: [], errors: [] };
};

export const writeManifest = (
    root: string,
    tree: readonly DocNode[],
    metadata: Omit<ParsedManifest, "tree" | "errors"> = {},
): void => {
    writeFileSync(join(root, manifestFile(root)), serializeManifest(tree, metadata));
};

export { docFile } from "../core/files.js";
