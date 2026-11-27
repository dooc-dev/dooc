// SoT for URL / id resolution logic (browser-safe, no node dependencies). Consumers resolve docs
// through here and never build paths themselves — a consumer is a display-only wrapper, and this
// package owns routing.
//
// Page URLs follow the manifest hierarchy, independently of source folders.
// Body links reference source files, and heading fragments stay separate.

import { isDocId, pageUrlKind } from "./content-metadata.js";
import type { CompiledDoc } from "./content-types.js";
import { fileDocumentId, localFile } from "./files.js";
import { parseFileReference } from "./textfile.js";

/** The minimal doc reference routing needs (a shape CompiledDoc satisfies). */
export type DocRef = Pick<
    CompiledDoc,
    "id" | "parent" | "library" | "format" | "url" | "root" | "name" | "origin"
> & {
    file?: string;
    sourceFile?: string;
    subformat?: string | { ext: string };
};

export const subformatSchemaPath = (ext: string): string =>
    `/_files/schema/${encodeURIComponent(ext)}`;

/** Parse `<docId>` (leading/trailing `/` are ignored). undefined if the shape differs. */
export const parseRoutePath = (path: string): string | undefined => {
    const seg = path.split("/").filter((s) => s !== "");
    const [id] = seg;
    return id != null && seg.length === 1 && isDocId(id) ? id : undefined;
};

/** Authored links navigate to references; they cannot execute code or launch other protocols. */
export const isReferenceUrl = (url: string): boolean => {
    try {
        return ["http:", "https:", "mailto:"].includes(
            new URL(url, "https://dooc.invalid/").protocol,
        );
    } catch {
        return false;
    }
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

/** File stems and declared views form the URL segments; legacy IDs keep their authored names. */
export const docPath = (docs: readonly DocRef[], id: string): string => {
    const doc = docs.find((item) => item.id === id);
    return `/${[...ancestorsOf(docs, id), doc ?? { id }]
        .filter((item) => !item.root)
        .map((item) => {
            const file = item.sourceFile ?? item.file;
            const name =
                item.name ??
                item.library ??
                item.format ??
                (typeof item.subformat === "string" ? item.subformat : item.subformat?.ext) ??
                (file && fileDocumentId(file) === item.id
                    ? file.slice(file.lastIndexOf("/") + 1, -3)
                    : item.id);
            return encodeURIComponent(name);
        })
        .join("/")}`;
};

/** Navigation targets share routing in the server, editor and standalone reader. */
const resolveDocHref = (docs: readonly DocRef[], id: string, inline = false): string => {
    const seen = new Set<string>();
    const parameters = new URLSearchParams();
    let fragment = "";
    const destination = (path: string): string =>
        `${path}${parameters.size ? `?${parameters}` : ""}${fragment}`;
    let target = id;
    for (;;) {
        if (seen.has(target))
            throw new Error(`Circular document redirect: ${docPath(docs, target)}`);
        seen.add(target);
        const doc = docs.find((item) => item.id === target);
        if (doc?.url === "redirect:first") {
            const child = childrenOf(docs, target)[0];
            if (!child)
                throw new Error(`redirect:first requires a child: ${docPath(docs, target)}`);
            target = child.id;
            continue;
        }
        if (doc?.url && pageUrlKind(doc.url) === "link") {
            if (doc.url.startsWith("/")) {
                const url = new URL(doc.url, "https://dooc.invalid");
                for (const [key, value] of url.searchParams)
                    if (!parameters.has(key)) parameters.set(key, value);
                fragment ||= url.hash;
                const next = resolveDocPath(docs, url.pathname);
                if (next) {
                    target = next;
                    continue;
                }
                return destination(url.pathname);
            }
            return inline ? destination(docPath(docs, target)) : doc.url;
        }
        return destination(docPath(docs, target));
    }
};

export const docHref = (docs: readonly DocRef[], id: string, inline = false): string => {
    try {
        return resolveDocHref(docs, id, inline);
    } catch {
        return docPath(docs, id);
    }
};

/** Reject ambiguous page URLs and roots used by the application's own routes. */
export const documentPathErrors = (docs: readonly DocRef[]): string[] => {
    const paths = new Set<string>();
    const errors: string[] = [];
    for (const doc of docs) {
        const path = docPath(docs, doc.id);
        if (/^\/(?:_|(?:api|assets)(?:\/|$))/.test(path))
            errors.push(`Reserved page path: ${path}. Rename the page or place it under a parent.`);
        if (paths.has(path)) errors.push(`Duplicate page path: ${path}`);
        paths.add(path);
        try {
            resolveDocHref(docs, doc.id);
        } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
        }
    }
    return errors;
};

/** Resolve only an unambiguous, complete hierarchy path. */
export const resolveDocPath = (docs: readonly DocRef[], path: string): string | undefined => {
    const matches = docs.filter((doc) => docPath(docs, doc.id) === path);
    return matches.length === 1 ? matches[0]?.id : undefined;
};
