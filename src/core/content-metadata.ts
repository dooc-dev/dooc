// The content/ contract. Doc bodies sit flat in content/<id>.md, and only dooc.yaml
// holds the hierarchy and order (docs themselves have no root / child distinction; any doc can
// have children). id = the file name stem is the resolution key for URLs / file links and is
// unique site-wide. YAML reading/writing lives in compiler/manifest.ts; this file only does
// browser-safe tree validation and manipulation.

import { docFile, type FileLayout, localFile, parseFileLayout } from "./files.js";
import { isLangTag } from "./language.js";
import { type PreviewSettings, parsePreviewSettings } from "./previewers.js";

export const MANIFEST_FILE = "dooc.yaml";

export interface DocNode {
    id: string;
    children: DocNode[];
}

export interface ParsedManifest {
    tree: DocNode[];
    title?: string;
    icon?: string;
    defaultLang?: string;
    previews?: PreviewSettings;
    files?: FileLayout;
    errors: string[];
}

export const DOC_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export const isDocId = (s: string): boolean => DOC_ID_RE.test(s);

/** Doc file name directly under content/ (`<id>.md`) → id. undefined if the shape differs. */
export const docIdOfFile = (name: string): string | undefined => {
    const id = name.endsWith(".md") ? name.slice(0, -3) : "";
    return isDocId(id) ? id : undefined;
};

/**
 * Turn the parsed dooc.yaml (YAML → JS value) into a tree. Each element is `id` (no
 * children) or `{ id: [children...] }` (a single-key map; a null value also means no children).
 * Validates id shape and duplicates.
 */
export const parseManifest = (value: unknown): ParsedManifest => {
    const errors: string[] = [];
    let title: string | undefined;
    let icon: string | undefined;
    let defaultLang: string | undefined;
    let previews: PreviewSettings | undefined;
    let files: FileLayout | undefined;
    if (value != null && typeof value === "object" && !Array.isArray(value)) {
        const manifest = value as Record<string, unknown>;
        for (const key of Object.keys(manifest))
            if (
                key !== "title" &&
                key !== "icon" &&
                key !== "defaultLang" &&
                key !== "docs" &&
                key !== "previews" &&
                key !== "files"
            )
                errors.push(`${MANIFEST_FILE}: unknown field "${key}"`);
        if (manifest.title !== undefined) {
            if (typeof manifest.title !== "string" || !manifest.title.trim())
                errors.push(`${MANIFEST_FILE}: title must be a non-empty string`);
            else title = manifest.title.trim();
        }
        if (manifest.icon !== undefined) {
            if (
                typeof manifest.icon !== "string" ||
                !localFile(manifest.icon.trim()) ||
                !manifest.icon.trim().endsWith(".svg")
            )
                errors.push(`${MANIFEST_FILE}: icon must be a local .svg file`);
            else icon = manifest.icon.trim();
        }
        if (manifest.defaultLang !== undefined) {
            if (typeof manifest.defaultLang !== "string" || !isLangTag(manifest.defaultLang))
                errors.push(`${MANIFEST_FILE}: defaultLang must be a BCP 47 language tag`);
            else defaultLang = manifest.defaultLang;
        }
        if (manifest.previews !== undefined) {
            try {
                previews = parsePreviewSettings(manifest.previews);
            } catch (error) {
                errors.push(`${MANIFEST_FILE}: ${error instanceof Error ? error.message : error}`);
            }
        }
        if (manifest.files !== undefined) {
            try {
                files = parseFileLayout(manifest.files);
            } catch (error) {
                errors.push(`${MANIFEST_FILE}: ${error instanceof Error ? error.message : error}`);
            }
        }
        if (!Array.isArray(manifest.docs)) errors.push(`${MANIFEST_FILE}: docs must be a list`);
        value = manifest.docs;
    }
    const seen = new Set<string>();
    const walk = (v: unknown, path: string): DocNode[] => {
        if (v == null) {
            return [];
        }
        if (!Array.isArray(v)) {
            errors.push(`${MANIFEST_FILE}: ${path} must be a list`);
            return [];
        }
        const nodes: DocNode[] = [];
        for (const [i, item] of v.entries()) {
            const at = `${path}[${i}]`;
            let id: unknown;
            let children: unknown;
            if (typeof item === "string") {
                id = item;
            } else if (
                typeof item === "object" &&
                item != null &&
                !Array.isArray(item) &&
                Object.keys(item).length === 1
            ) {
                [id, children] = Object.entries(item)[0] ?? [];
            } else {
                errors.push(`${MANIFEST_FILE}: ${at} must be "id" or "id: [children...]"`);
                continue;
            }
            if (typeof id !== "string" || !isDocId(id)) {
                errors.push(
                    `${MANIFEST_FILE}: ${at} id "${String(id)}" must be lowercase alphanumerics and hyphens`,
                );
                continue;
            }
            if (seen.has(id)) {
                errors.push(`${MANIFEST_FILE}: duplicate id "${id}"`);
                continue;
            }
            seen.add(id);
            nodes.push({ id, children: walk(children, `${at}.${id}`) });
        }
        return nodes;
    };
    const tree = walk(value, "root");
    if (files) {
        for (const id of [...Object.keys(files.documents), ...Object.keys(files.icons ?? {})])
            if (!seen.has(id))
                errors.push(`${MANIFEST_FILE}: files references unknown document "${id}"`);
        const paths = [...seen].map((id) => docFile(id, files));
        if (new Set(paths).size !== paths.length)
            errors.push(`${MANIFEST_FILE}: documents must use distinct files`);
    }
    return {
        tree,
        ...(title === undefined ? {} : { title }),
        ...(icon === undefined ? {} : { icon }),
        ...(defaultLang === undefined ? {} : { defaultLang }),
        ...(previews === undefined ? {} : { previews }),
        ...(files === undefined ? {} : { files }),
        errors,
    };
};

/** Tree → dooc.yaml text (serialized in the hand-written shape, keeping git diffs clean). */
export const serializeManifest = (
    tree: readonly DocNode[],
    { title, icon, defaultLang, previews, files }: Omit<ParsedManifest, "tree" | "errors"> = {},
): string => {
    const write = (nodes: readonly DocNode[], indent: string): string[] =>
        nodes.flatMap((n) =>
            n.children.length > 0
                ? [`${indent}- ${n.id}:`, ...write(n.children, `${indent}    `)]
                : [`${indent}- ${n.id}`],
        );
    if (
        title !== undefined ||
        icon !== undefined ||
        defaultLang !== undefined ||
        previews !== undefined ||
        files !== undefined
    ) {
        const lines = write(tree, "  ");
        const metadata = `${title === undefined ? "" : `title: ${JSON.stringify(title)}\n`}${icon === undefined ? "" : `icon: ${JSON.stringify(icon)}\n`}${defaultLang === undefined ? "" : `defaultLang: ${JSON.stringify(defaultLang)}\n`}`;
        const previewLines =
            previews === undefined
                ? ""
                : `previews:\n  domains: ${JSON.stringify(previews.domains)}\n  formats:\n${Object.entries(
                      previews.formats,
                  )
                      .map(([id, extensions]) => `    ${id}: ${JSON.stringify(extensions)}\n`)
                      .join("")}`;
        return `${metadata}${previewLines}${files ? `files: ${JSON.stringify(files)}\n` : ""}docs:${lines.length ? `\n${lines.join("\n")}\n` : " []\n"}`;
    }
    const lines = write(tree, "");
    return `# Doc hierarchy and order (each id = content/<id>.md)\n${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
};

/** Flatten the tree into display order (pre-order). parent omitted = top level. */
export const flattenTree = (
    tree: readonly DocNode[],
): { id: string; parent?: string; depth: number }[] => {
    const out: { id: string; parent?: string; depth: number }[] = [];
    const walk = (nodes: readonly DocNode[], parent: string | undefined, depth: number): void => {
        for (const n of nodes) {
            out.push(parent == null ? { id: n.id, depth } : { id: n.id, parent, depth });
            walk(n.children, n.id, depth + 1);
        }
    };
    walk(tree, undefined, 0);
    return out;
};

const clone = (tree: readonly DocNode[]): DocNode[] =>
    tree.map((n) => ({ id: n.id, children: clone(n.children) }));

const findNode = (tree: readonly DocNode[], id: string): DocNode | undefined => {
    for (const n of tree) {
        if (n.id === id) {
            return n;
        }
        const hit = findNode(n.children, id);
        if (hit) {
            return hit;
        }
    }
    return undefined;
};

/** Detach the node with this id (along with its children). Returns the detached node. */
const detach = (tree: DocNode[], id: string): DocNode | undefined => {
    const i = tree.findIndex((n) => n.id === id);
    if (i !== -1) {
        return tree.splice(i, 1)[0];
    }
    for (const n of tree) {
        const hit = detach(n.children, id);
        if (hit) {
            return hit;
        }
    }
    return undefined;
};

/** Child list of parent (omitted = top level). undefined if parent doesn't exist. */
const childList = (tree: DocNode[], parent: string | undefined): DocNode[] | undefined =>
    parent == null ? tree : findNode(tree, parent)?.children;

/** Append a new doc to the end of parent's children. Duplicate id / missing parent → undefined. */
export const insertDoc = (
    tree: readonly DocNode[],
    id: string,
    parent?: string,
): DocNode[] | undefined => {
    const next = clone(tree);
    const list = childList(next, parent);
    if (!list || findNode(next, id)) {
        return undefined;
    }
    list.push({ id, children: [] });
    return next;
};

/**
 * Move a doc (with its children) to position index under parent. It can't be moved under
 * itself or its own descendants (that would create a cycle). An invalid move returns undefined
 * (no partial update).
 */
export const moveDoc = (
    tree: readonly DocNode[],
    id: string,
    parent: string | undefined,
    index: number,
): DocNode[] | undefined => {
    const node = findNode(tree, id);
    if (!node || (parent != null && (parent === id || findNode(node.children, parent)))) {
        return undefined;
    }
    const next = clone(tree);
    const moved = detach(next, id);
    const list = childList(next, parent);
    if (!moved || !list || !Number.isInteger(index) || index < 0 || index > list.length) {
        return undefined;
    }
    list.splice(index, 0, moved);
    return next;
};

/** Remove a doc. Docs with children are not removed (we don't decide where the children go). */
export const removeDoc = (tree: readonly DocNode[], id: string): DocNode[] | undefined => {
    const node = findNode(tree, id);
    if (!node || node.children.length > 0) {
        return undefined;
    }
    const next = clone(tree);
    detach(next, id);
    return next;
};

/** Change a doc's id (position and children stay as they are). */
export const renameDoc = (
    tree: readonly DocNode[],
    oldId: string,
    newId: string,
): DocNode[] | undefined => {
    const next = clone(tree);
    const node = findNode(next, oldId);
    if (!node || findNode(next, newId)) {
        return undefined;
    }
    node.id = newId;
    return next;
};
