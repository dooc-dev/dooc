// SoT for URL / id resolution logic (browser-safe, no node dependencies). Consumers resolve docs
// through here and never build paths themselves — a consumer is a display-only wrapper, and this
// package owns routing.
//
// Page URLs follow the manifest hierarchy; heading fragments stay separate.
// Body links reference source files; page URLs use the manifest hierarchy.

import { isDocId } from "./content-metadata.js";
import type { CompiledDoc } from "./content-types.js";
import { localFile } from "./files.js";
import { parseFileReference } from "./textfile.js";

/** The minimal doc reference routing needs (a shape CompiledDoc satisfies). */
export type DocRef = Pick<CompiledDoc, "id" | "parent">;

/** Parse `<docId>` (leading/trailing `/` are ignored). undefined if the shape differs. */
export const parseRoutePath = (path: string): string | undefined => {
    const seg = path.split("/").filter((s) => s !== "");
    const [id] = seg;
    return id != null && seg.length === 1 && isDocId(id) ? id : undefined;
};

/** Document links use paths relative to the docs root and optional heading fragments. */
export const parseDocLink = (url: string): { file: string; fragment: string } | undefined => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(url)) return undefined;
    const path = url.split(/[?#]/)[0] ?? "";
    let decoded: string;
    try {
        decoded = decodeURIComponent(path);
    } catch {
        throw new Error("Invalid file link encoding");
    }
    if (!decoded.toLowerCase().endsWith(".md")) return undefined;
    const ref = parseFileReference(url);
    const file = ref.file.replace(/^(\.\/)+/, "");
    if (!localFile(file)) throw new Error("Document links require a file inside the docs root");
    return { file, fragment: ref.range?.slice(1) ?? "" };
};

/** Docs directly under parent (keeps input order = manifest order). parent omitted = top level. */
export const childrenOf = <D extends DocRef>(docs: readonly D[], parent?: string): D[] =>
    docs.filter((d) => d.parent === parent);

/** Ancestors (ordered top level → parent, excluding self). For breadcrumbs. */
export const ancestorsOf = <D extends DocRef>(docs: readonly D[], id: string): D[] => {
    const byId = new Map(docs.map((d) => [d.id, d]));
    const out: D[] = [];
    const seen = new Set<string>([id]);
    for (let p = byId.get(id)?.parent; p != null && !seen.has(p); p = byId.get(p)?.parent) {
        seen.add(p);
        const d = byId.get(p);
        if (!d) {
            break;
        }
        out.unshift(d);
    }
    return out;
};

/** DOM anchor id for a heading — namespaced by doc id. */
export const headingAnchor = (docId: string, slug: string): string => `${docId}__${slug}`;

/** Canonical page URL: manifest ancestors form the path; headings use a separate fragment. */
export const docPath = (docs: readonly DocRef[], id: string): string =>
    `/${[...ancestorsOf(docs, id).map((doc) => doc.id), id].join("/")}`;

/** Resolve only the complete hierarchy path; no legacy single-id aliases. */
export const resolveDocPath = (docs: readonly DocRef[], path: string): string | undefined => {
    const parts = path.split("/").filter(Boolean);
    const id = parts.at(-1);
    if (!id || !parts.every(isDocId) || !docs.some((doc) => doc.id === id)) return undefined;
    return docPath(docs, id) === path ? id : undefined;
};
