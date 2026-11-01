// SoT for URL / id resolution logic (browser-safe, no node dependencies). Consumers resolve docs
// through here and never build paths themselves — a consumer is a display-only wrapper, and this
// package owns routing.
//
// Route form = `<docId>` (ids are unique site-wide; the hierarchy isn't exposed in the URL, so
// moving a doc doesn't change its URL). Shared by preview URLs and body-text `doc:` links (the
// consumer adds the prefix).
import type { ArtifactDoc } from "./artifact-types.js";
import { isDocId } from "./content-metadata.js";

/** The minimal doc reference routing needs (a shape ArtifactDoc satisfies). */
export type DocRef = Pick<ArtifactDoc, "id" | "parent">;

/** Parse `<docId>` (leading/trailing `/` are ignored). undefined if the shape differs. */
export const parseRoutePath = (path: string): string | undefined => {
    const seg = path.split("/").filter((s) => s !== "");
    const [id] = seg;
    return id != null && seg.length === 1 && isDocId(id) ? id : undefined;
};

// Link scheme within body text: [label](doc:<docId>).
export const DOC_LINK_SCHEME = "doc:";
export const parseDocLink = (url: string): string | undefined =>
    url.startsWith(DOC_LINK_SCHEME) ? parseRoutePath(url.slice(DOC_LINK_SCHEME.length)) : undefined;

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
