import type { Root } from "mdast";
import { visit } from "unist-util-visit";
import { parseTermSource } from "../compiler/terms.js";
import { readTextfile } from "../compiler/textfile.js";
import type { TermEntry } from "../core/content-types.js";
import { blocksHtml, escapeHtml } from "../core/html.js";
import { parseMdast } from "../core/markdown.js";

interface SourceLocation {
    file: string;
    line: number;
}
export interface ResourceIndex {
    terms: { entry: TermEntry; source: SourceLocation }[];
    code: { language: string; caption: string; content: string; source: SourceLocation }[];
    urls: { url: string; host: string; sources: SourceLocation[] }[];
    errors: string[];
}

/** Index authored content, including files not referenced by any document. */
export const resourceIndex = (root: string, files: readonly string[]): ResourceIndex => {
    const result: ResourceIndex = { terms: [], code: [], urls: [], errors: [] };
    const urls = new Map<string, ResourceIndex["urls"][number]>();
    const terms = (raw: string, source: SourceLocation) => {
        const parsed = parseTermSource(`${source.file}#L${source.line}`, raw);
        result.terms.push(...parsed.entries.map((entry) => ({ entry, source })));
        result.errors.push(
            ...parsed.errors.map(
                (error) => `${source.file}:L${source.line + error.line}: ${error.message}`,
            ),
        );
    };
    const scan = (tree: Root, file: string, offset = 0): void => {
        const definitions = new Map<string, string>();
        visit(tree, "definition", (node) => {
            definitions.set(node.identifier, node.url);
        });
        visit(tree, (node) => {
            const source = { file, line: offset + (node.position?.start.line ?? 1) };
            if (node.type === "code") {
                const language = node.lang?.toLowerCase() || "text";
                result.code.push({
                    language,
                    caption: node.meta ?? "",
                    content: node.value,
                    source,
                });
                if (language === "termth") terms(node.value, { ...source, line: source.line + 1 });
                if (language === "callouth") scan(parseMdast(node.value), file, source.line);
                return;
            }
            const target =
                node.type === "link" || node.type === "image"
                    ? node.url
                    : node.type === "linkReference" || node.type === "imageReference"
                      ? definitions.get(node.identifier)
                      : undefined;
            if (!target) return;
            try {
                const url = new URL(target);
                if (!["http:", "https:", "mailto:"].includes(url.protocol)) return;
                const key = url.href;
                const entry = urls.get(key) ?? {
                    url: key,
                    host: url.host || url.protocol,
                    sources: [],
                };
                entry.sources.push(source);
                urls.set(key, entry);
            } catch {
                // Local paths and anchors are not external URL resources.
            }
        });
    };
    for (const file of new Set(files)) {
        if (!/\.(?:md|termth)$/i.test(file)) continue;
        try {
            const raw = readTextfile(root, file);
            if (/\.termth$/i.test(file)) terms(raw, { file, line: 1 });
            else scan(parseMdast(raw), file);
        } catch (error) {
            result.errors.push(
                `${file}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
    result.terms.sort((a, b) =>
        a.entry.name.localeCompare(b.entry.name, undefined, { numeric: true }),
    );
    result.urls = [...urls.values()].sort((a, b) => a.url.localeCompare(b.url));
    return result;
};

export type ResourceView = "files" | "dictionary" | "code" | "urls";
export const resourceTabs = (view: ResourceView): string =>
    view === "files"
        ? ""
        : `<nav class="resource-tabs" aria-label="Resource views" data-i18n-aria-label="Resource views">${(
              [
                  ["dictionary", "Dictionary"],
                  ["code", "Code blocks"],
                  ["urls", "URLs"],
              ] as const
          )
              .map(
                  ([key, label]) =>
                      `<a href="/_statics${key === "dictionary" ? "" : `/${key}`}"${view === key ? ' aria-current="page"' : ""} data-i18n="${label}">${label}</a>`,
              )
              .join("")}</nav>`;

const sourceLink = ({ file, line }: SourceLocation): string =>
    `<a class="resource-source" href="/_files/file/${encodeURIComponent(file)}#L${line}" data-resource-source="${escapeHtml(file)}" data-resource-line="${line}" title="${escapeHtml(file)}:L${line}"><span class="resource-source-file">${escapeHtml(file)}</span><span>L${line}</span></a>`;

export const resourceLibraryHtml = (
    index: ResourceIndex,
    view: Exclude<ResourceView, "files">,
): string => {
    const groupLabel = view === "code" ? "Code language" : "Domain";
    const groups =
        view === "dictionary"
            ? []
            : [
                  ...new Set(
                      view === "code"
                          ? index.code.map((item) => item.language)
                          : index.urls.map((item) => item.host),
                  ),
              ].sort();
    const items =
        view === "dictionary"
            ? index.terms.map(
                  ({ entry, source }) =>
                      `<details class="resource-item resource-term" data-resource-item><summary><span class="resource-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span>${sourceLink(source)}</summary><div class="resource-body"><p class="term-definition">${escapeHtml(entry.definition)}</p>${entry.description ? `<p class="resource-description">${escapeHtml(entry.description)}</p>` : ""}</div></details>`,
              )
            : view === "code"
              ? index.code.map(
                    ({ language, caption, content, source }) =>
                        `<details class="resource-item resource-code" data-resource-item data-resource-group="${escapeHtml(language)}"><summary><span class="resource-badge">${escapeHtml(language)}</span>${caption ? `<span class="resource-name" title="${escapeHtml(caption)}">${escapeHtml(caption)}</span>` : ""}${sourceLink(source)}</summary><div class="resource-body">${blocksHtml([{ type: "code", lang: language === "mermaid" ? "text" : language, lines: content.split("\n") }])}</div></details>`,
                )
              : index.urls.map(
                    ({ url, host, sources }) =>
                        `<details class="resource-item resource-url" data-resource-item data-resource-group="${escapeHtml(host)}"><summary><a class="resource-name" href="${escapeHtml(url)}" title="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a><span class="resource-usage" title="references" data-i18n-title="references">${sources.length}</span></summary><div class="resource-body resource-sources">${sources.map(sourceLink).join("")}</div></details>`,
                );
    return `<section class="resource-results" data-resource-results><div class="resource-toolbar"><span data-i18n="Name">Name</span><label class="resource-search"><svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M14 14l4 4M15 9a6 6 0 1 1-12 0 6 6 0 0 1 12 0"/></svg><input type="search" data-resource-search placeholder="Search resources" aria-label="Search resources" data-i18n-placeholder="Search resources" data-i18n-aria-label="Search resources"></label>${groups.length ? `<select data-resource-filter aria-label="${groupLabel}" data-i18n-aria-label="${groupLabel}"><option value="" data-i18n="All">All</option>${groups.map((group) => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`).join("")}</select>` : ""}<span class="resource-count" data-resource-count role="status" aria-live="polite">${items.length}</span></div>${index.errors.length ? `<details class="resource-errors"><summary><span data-i18n="Files with errors">Files with errors</span> (${index.errors.length})</summary><ul>${index.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></details>` : ""}<div class="resource-items resource-${view}">${items.join("")}</div><p class="resource-empty" data-resource-empty${items.length ? " hidden" : ""} data-i18n="No matching resources">No matching resources</p></section>`;
};
