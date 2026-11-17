// Reads/writes dooc.yaml (node-dependent). Tree validation and manipulation live in
// core/content-metadata.ts.

import { parse } from "yaml";
import {
    type DocNode,
    flattenTree,
    isContentPage,
    isManifestFile,
    MANIFEST_FILE,
    type ParsedManifest,
    pageUrlKind,
    parseManifest,
    serializeManifest,
} from "../core/content-metadata.js";
import { docFile, fileDocumentId, parseFileLayout } from "../core/files.js";
import { isRemoteManifest } from "../core/remote-manifest.js";
import { documentPathErrors } from "../core/routing.js";
import { createFileCache } from "./file-cache.js";
import {
    basename,
    dirname,
    existsSync,
    join,
    posix,
    resolve,
    statSync,
    writeFileSync,
} from "./host.js";
import { assertNotIgnored } from "./ignored-files.js";
import { manifestSourcePath, remoteManifestFile } from "./remote-manifests.js";
import { textfilePath } from "./textfile.js";

const manifests = new Map<string, string>();
const parsed = createFileCache<ParsedManifest>();

export const manifestFile = (root: string): string => manifests.get(resolve(root)) ?? MANIFEST_FILE;

export const sourceOrigin = (manifest: ParsedManifest, file: string): string | undefined => {
    const page = flattenTree(manifest.tree).find(
        (node) => isContentPage(node) && docFile(node.id, manifest.files) === file,
    );
    if (page) return page.origin;
    return manifest.includedManifests
        ?.filter(
            (owner) => posix.dirname(owner) === "." || file.startsWith(`${posix.dirname(owner)}/`),
        )
        .sort((a, b) => b.length - a.length)[0];
};

export const sectionManifest = (root: string, value?: unknown): string => {
    const file = value === undefined ? manifestFile(root) : value;
    if (
        typeof file !== "string" ||
        (file !== manifestFile(root) && !readManifest(root).includedManifests?.includes(file))
    )
        throw new Error("Document section is not available");
    return manifestSourcePath(textfilePath(root, file));
};

/** Select the manifest for subsequent operations on its parent directory. */
export const projectRoot = (input = MANIFEST_FILE): string => {
    const file = resolve(input);
    if (!isManifestFile(basename(file)) || !existsSync(file) || !statSync(file).isFile())
        throw new Error(`Specify an existing dooc.yaml or <name>.dooc.yaml file: ${file}`);
    const root = dirname(file);
    manifests.set(root, basename(file));
    return root;
};

export const parseManifestText = (
    raw: string,
    file: string = MANIFEST_FILE,
    validatePaths = true,
): ParsedManifest => {
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
    if (validatePaths)
        manifest.errors.push(
            ...documentPathErrors(flattenTree(manifest.tree)).map(
                (error) => `${MANIFEST_FILE}: ${error}`,
            ),
        );
    manifest.errors = manifest.errors.map((error) => error.replace(/^dooc\.yaml(?=:)/, () => file));
    return manifest;
};

/** Empty tree if missing (a new docs root with zero docs). */
export const readManifest = (root: string, file = manifestFile(root)): ParsedManifest => {
    if (!existsSync(join(root, file))) return { tree: [], errors: [] };
    const active = new Set<string>();
    const load = (file: string, imported = false): ParsedManifest => {
        const path = textfilePath(root, file);
        if (imported) assertNotIgnored(root, file);
        if (active.has(path)) throw new Error(`Circular manifest include: ${file}`);
        if (active.size >= 64) throw new Error("Manifest nesting exceeds 64 levels");
        active.add(path);
        try {
            const manifest = structuredClone(
                parsed.get(path, (raw) => parseManifestText(raw, file, false)),
            );
            const folder = posix.dirname(file);
            const qualify = (value: string): string => posix.join(folder, value);
            const icons = manifest.files?.icons ?? {};
            const rebasedIcons: Record<string, string> = {};
            const visit = (nodes: DocNode[]): void => {
                for (const node of nodes) {
                    const oldId = node.id;
                    if (imported) {
                        if (isContentPage(node))
                            node.file = qualify(node.file ?? docFile(oldId, manifest.files));
                        if (
                            node.url &&
                            !isRemoteManifest(node.url) &&
                            ["content", "file", "manifest"].includes(pageUrlKind(node.url))
                        )
                            node.url = qualify(node.url);
                        node.id = fileDocumentId(
                            node.file ??
                                (node.url && pageUrlKind(node.url) === "manifest"
                                    ? node.url
                                    : `${file}#${oldId}`),
                        );
                        node.origin = file;
                        if (icons[oldId]) rebasedIcons[node.id] = qualify(icons[oldId]);
                    }
                    visit(node.children);
                    if (node.url === undefined || pageUrlKind(node.url) !== "manifest") continue;
                    const included = isRemoteManifest(node.url)
                        ? qualify(remoteManifestFile(node.url))
                        : node.url;
                    const child = load(included, true);
                    manifest.errors.push(...child.errors);
                    node.resolved = child.tree[0]?.root
                        ? child.tree[0]
                        : {
                              id: node.id,
                              url: "",
                              title: child.title,
                              origin: included,
                              children: child.tree,
                          };
                    if (!node.resolved.title) node.resolved.title = child.title;
                    manifest.includedManifests ??= [];
                    manifest.includedManifests.push(included, ...(child.includedManifests ?? []));
                    manifest.includedAssets ??= [];
                    manifest.includedAssets.push(...(child.includedAssets ?? []));
                    manifest.files ??= parseFileLayout({});
                    Object.assign(rebasedIcons, child.files?.icons);
                    const includedIcon = child.files?.icons?.[node.resolved.id];
                    if (includedIcon && !icons[oldId]) rebasedIcons[node.id] = includedIcon;
                    for (const format of child.subformats ?? []) {
                        const existing = manifest.subformats?.find(({ ext }) => ext === format.ext);
                        if (existing && JSON.stringify(existing) !== JSON.stringify(format))
                            throw new Error(`Conflicting subformat ${format.ext} in ${included}`);
                        if (!existing) {
                            manifest.subformats ??= [];
                            manifest.includedSubformats ??= [];
                            manifest.subformats.push(format);
                            manifest.includedSubformats.push(format.ext);
                        }
                    }
                }
            };
            if (imported) {
                manifest.includedAssets = [
                    manifest.icon,
                    manifest.licence,
                    ...Object.values(manifest.themeIcons ?? {}),
                ].flatMap((asset) => (asset ? [qualify(asset)] : []));
                for (const format of manifest.subformats ?? []) {
                    format.schema = qualify(format.schema);
                    if (format.icon) format.icon = qualify(format.icon);
                }
            }
            visit(manifest.tree);
            if (imported || manifest.includedManifests?.length) {
                manifest.files ??= parseFileLayout({});
                if (imported) manifest.files.documents = {};
                for (const node of flattenTree(manifest.tree))
                    if (node.file && isContentPage(node))
                        manifest.files.documents[node.id] = node.file;
                manifest.files.icons = { ...(imported ? {} : icons), ...rebasedIcons };
            }
            return manifest;
        } finally {
            active.delete(path);
        }
    };
    try {
        const manifest = load(file);
        const pages = flattenTree(manifest.tree);
        manifest.errors.push(...documentPathErrors(pages).map((error) => `${file}: ${error}`));
        const ids = pages.map(({ id }) => id);
        if (new Set(ids).size !== ids.length)
            manifest.errors.push(`${file}: Duplicate document in included manifests`);
        return manifest;
    } catch (error) {
        return { tree: [], errors: [`${file}: ${error instanceof Error ? error.message : error}`] };
    }
};

export const writeManifest = (
    root: string,
    tree: readonly DocNode[],
    metadata: Omit<ParsedManifest, "tree" | "errors"> = {},
): void => {
    writeFileSync(join(root, manifestFile(root)), serializeManifest(tree, metadata));
};

export { docFile } from "../core/files.js";
