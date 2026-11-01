// Reads/writes content/manifest.yaml (node-dependent). Tree validation and manipulation live in
// core/content-metadata.ts.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
    type DocNode,
    MANIFEST_FILE,
    parseManifest,
    serializeManifest,
} from "../core/content-metadata.js";

export const parseManifestText = (raw: string): { tree: DocNode[]; errors: string[] } => {
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
export const readManifest = (contentDir: string): { tree: DocNode[]; errors: string[] } => {
    const path = join(contentDir, MANIFEST_FILE);
    return existsSync(path)
        ? parseManifestText(readFileSync(path, "utf8"))
        : { tree: [], errors: [] };
};

export const writeManifest = (contentDir: string, tree: readonly DocNode[]): void => {
    writeFileSync(join(contentDir, MANIFEST_FILE), serializeManifest(tree));
};
