// Reads/writes dooc.yaml (node-dependent). Tree validation and manipulation live in
// core/content-metadata.ts.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import {
    type DocNode,
    MANIFEST_FILE,
    type ParsedManifest,
    parseManifest,
    serializeManifest,
} from "../core/content-metadata.js";

/** CLI paths select a manifest; every project path is relative to its parent. */
export const projectRoot = (input = MANIFEST_FILE): string => {
    const file = resolve(input);
    if (basename(file) !== MANIFEST_FILE || !existsSync(file) || !statSync(file).isFile())
        throw new Error(`Specify an existing dooc.yaml file: ${file}`);
    return dirname(file);
};

export const parseManifestText = (raw: string): ParsedManifest => {
    let value: unknown;
    try {
        value = parse(raw);
    } catch (e) {
        return {
            tree: [],
            errors: [`${MANIFEST_FILE}: invalid YAML (${e instanceof Error ? e.message : e})`],
        };
    }
    return parseManifest(value);
};

/** Empty tree if missing (a new docs root with zero docs). */
export const readManifest = (root: string): ParsedManifest => {
    const path = join(root, MANIFEST_FILE);
    return existsSync(path)
        ? parseManifestText(readFileSync(path, "utf8"))
        : { tree: [], errors: [] };
};

export const writeManifest = (
    root: string,
    tree: readonly DocNode[],
    metadata: Omit<ParsedManifest, "tree" | "errors"> = {},
): void => {
    writeFileSync(join(root, MANIFEST_FILE), serializeManifest(tree, metadata));
};

export { docFile } from "../core/files.js";
