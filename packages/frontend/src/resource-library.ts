import type { Root } from "mdast";
import { bundledLanguagesInfo } from "shiki/langs";
import { visit } from "unist-util-visit";
import { parseContentSource } from "../../engine/src/compiler/code-blocks.js";
import { basename, extname } from "../../engine/src/compiler/host.js";
import { readManifest } from "../../engine/src/compiler/manifest.js";
import {
    type LoadedSubformat,
    loadSubformat,
    parseSubformatRecord,
    subformatIconSvg,
    subformatRelations,
    validateSubformatRecord,
} from "../../engine/src/compiler/subformats.js";
import { parseTermSource } from "../../engine/src/compiler/terms.js";
import { readTextfile, selectTextfileRange } from "../../engine/src/compiler/textfile.js";
import { flattenTree } from "../../engine/src/core/content-metadata.js";
import type { TermEntry } from "../../engine/src/core/content-types.js";
import { parseFileEmbed } from "../../engine/src/core/file-embed.js";
import { fileExtension } from "../../engine/src/core/files.js";
import { blocksHtml, escapeHtml } from "../../engine/src/core/html.js";
import { libraryIcon, SEARCH_ICON_PATH } from "../../engine/src/core/icons.js";
import { termComparator } from "../../engine/src/core/language.js";
import { parseMdast } from "../../engine/src/core/markdown.js";
import type { SchemaModel } from "../../engine/src/core/schema-graph.js";
import { subformatReferences } from "../../engine/src/core/subformat-references.js";
import { type SubformatCollection, subformatChange } from "../../engine/src/core/subformats.js";
import { CODE_TEMPLATES } from "../../engine/src/core/taxonomy.js";
import { parseTextfileRange } from "../../engine/src/core/textfile.js";

interface SourceLocation {
    file: string;
    line: number;
}
export interface ResourceIndex {
    codeblocks: {
        language: string;
        format: string;
        caption: string;
        content: string;
        source: SourceLocation;
        reference?: SourceLocation & { range?: string };
    }[];
    urls: { url: string; host: string; sources: SourceLocation[] }[];
    urlPreviews: ResourceIndex["urls"];
    subformats: SubformatCollection[];
    /** Schema references between subformats, drawn like a schemath diagram. */
    relations?: SchemaModel;
    errors: string[];
}

const codeFormat = (language: string): string =>
    /^(text|txt|plain|plaintext)$/.test(language)
        ? "text"
        : (bundledLanguagesInfo.find(
              (entry) => entry.id === language || entry.aliases?.includes(language),
          )?.id ?? language);

/** Index authored content, including files not referenced by any document. */
export const resourceIndex = (
    root: string,
    files: readonly string[],
    domains: readonly string[] = [],
): ResourceIndex => {
    const result: ResourceIndex = {
        codeblocks: [],
        urls: [],
        urlPreviews: [],
        subformats: [],
        errors: [],
    };
    const paths = new Set(files);
    const manifest = readManifest(root);
    result.errors.push(...manifest.errors);
    const formats = new Map<string, LoadedSubformat>();
    for (const config of manifest.subformats ?? []) {
        try {
            if (!paths.has(config.schema))
                throw new Error("Schema is not available in the workspace");
            const loaded = loadSubformat(root, config, domains);
            formats.set(config.ext, loaded);
            let iconSvg: string | undefined;
            try {
                iconSvg = subformatIconSvg(root, config);
            } catch {
                // The subformat page reports a broken icon; listings fall back to the default.
            }
            result.subformats.push({
                ...config,
                ...(iconSvg ? { iconSvg } : {}),
                fields: loaded.fields,
                template: loaded.template,
                defaultFolder: manifest.defaultSubformatFolder,
                records: [],
            });
        } catch (error) {
            result.errors.push(
                `${config.schema}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
    result.relations = subformatRelations(root, result.subformats, domains);
    const urls = new Map<string, ResourceIndex["urls"][number]>();
    const urlPreviews = new Map<string, ResourceIndex["urls"][number]>();
    const references = new Map<string, SourceLocation[]>();
    const validateTerms = (raw: string, source: SourceLocation) => {
        const parsed = parseTermSource(`${source.file}#L${source.line}`, raw);
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
                const format = formats.get(language.replace(/^\./, ""));
                result.codeblocks.push({
                    language: format?.format ?? language,
                    format: format?.ext ?? codeFormat(language),
                    caption: node.meta ?? "",
                    content: node.value,
                    source,
                });
                if (language === "termth")
                    validateTerms(node.value, { ...source, line: source.line + 1 });
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
            const preview = node.type === "image" || node.type === "imageReference";
            if (preview && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) {
                try {
                    const ref = parseFileEmbed(target);
                    if (ref.kind !== "textfile") return;
                    const referencedFile = ref.file.replace(/^(\.\/)+/, "");
                    if (!paths.has(referencedFile))
                        throw new Error("File is not available in the workspace");
                    const language = (
                        extname(referencedFile).slice(1) || basename(referencedFile)
                    ).toLowerCase();
                    result.codeblocks.push({
                        language: formats.get(language)?.format ?? language,
                        format: formats.has(language) ? language : codeFormat(language),
                        caption: node.alt ?? "",
                        content: selectTextfileRange(readTextfile(root, referencedFile), ref.range),
                        source,
                        reference: {
                            file: referencedFile,
                            line: ref.range ? parseTextfileRange(ref.range)[0] : 1,
                            ...(ref.range ? { range: ref.range } : {}),
                        },
                    });
                } catch (error) {
                    result.errors.push(
                        `${file}:L${source.line}: ${target}: ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
                return;
            }
            try {
                const url = new URL(target);
                if (!["http:", "https:", "mailto:"].includes(url.protocol)) return;
                const entries = preview ? urlPreviews : urls;
                const key = url.href;
                const entry = entries.get(key) ?? {
                    url: key,
                    host: url.host || url.protocol,
                    sources: [],
                };
                entry.sources.push(source);
                entries.set(key, entry);
            } catch {
                // Local paths and anchors are not external URL resources.
            }
        });
    };
    for (const file of paths) {
        const format = formats.get(fileExtension(file));
        if (format && !(manifest.subformats ?? []).some((item) => item.schema === file)) {
            try {
                const content = readTextfile(root, file);
                result.codeblocks.push({
                    language: format.format,
                    format: format.ext,
                    caption: file,
                    content,
                    source: { file, line: 1 },
                });
                const data = parseSubformatRecord(content, format.format);
                validateSubformatRecord(format, data);
                result.subformats
                    .find((item) => item.ext === format.ext)
                    ?.records.push({ file, content, data });
            } catch (error) {
                result.errors.push(
                    `${file}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
            continue;
        }
        if (!/\.(?:md|termth)$/i.test(file)) continue;
        try {
            const raw = readTextfile(root, file);
            if (/\.termth$/i.test(file)) {
                const source = { file, line: 1 };
                result.codeblocks.push({
                    language: "termth",
                    format: "termth",
                    caption: "",
                    content: raw,
                    source,
                });
                validateTerms(raw, source);
            } else {
                const tree = parseMdast(raw);
                scan(tree, file);
                for (const ref of subformatReferences(tree)) {
                    if (!formats.has(fileExtension(ref.file))) continue;
                    const sources = references.get(ref.file) ?? [];
                    sources.push({ file, line: ref.line });
                    references.set(ref.file, sources);
                }
            }
        } catch (error) {
            result.errors.push(
                `${file}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
    // A format with its own Library page lists every file of that type, like subformat records.
    const listed = new Set(
        flattenTree(manifest.tree).flatMap((node) =>
            node.library && node.library !== "termth" && Object.hasOwn(CODE_TEMPLATES, node.library)
                ? [node.library]
                : [],
        ),
    );
    const embedded = new Set(result.codeblocks.map((item) => item.reference?.file));
    for (const file of paths) {
        const format = fileExtension(file);
        if (!listed.has(format) || embedded.has(file)) continue;
        try {
            result.codeblocks.push({
                language: format,
                format,
                caption: file,
                content: readTextfile(root, file),
                source: { file, line: 1 },
            });
        } catch (error) {
            result.errors.push(
                `${file}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
    result.urls = [...urls.values()].sort((a, b) => a.url.localeCompare(b.url));
    result.urlPreviews = [...urlPreviews.values()].sort((a, b) => a.url.localeCompare(b.url));
    for (const collection of result.subformats)
        for (const record of collection.records)
            record.references = references.get(record.file) ?? [];
    return result;
};

export type ResourceView = "files" | "codeblocks" | "urls" | "url-previews";
export const resourceTabs = (view: ResourceView): string =>
    view === "files"
        ? ""
        : `<nav class="resource-tabs" aria-label="Resource views" data-i18n-aria-label="Resource views">${(
              [
                  ["codeblocks", "Codeblocks"],
                  ["urls", "URLs"],
                  ["url-previews", "URL previews"],
              ] as const
          )
              .map(
                  ([key, label]) =>
                      `<a href="/_library/${key}"${view === key ? ' aria-current="page"' : ""}>${libraryIcon(key) ?? ""}<span data-i18n="${label}">${label}</span></a>`,
              )
              .join("")}</nav>`;

const sourceLink = ({ file, line }: SourceLocation): string =>
    `<a class="resource-source" href="/_files/file/${encodeURIComponent(file)}#L${line}" data-resource-source="${escapeHtml(file)}" data-resource-line="${line}" title="${escapeHtml(file)}:L${line}"><span class="resource-source-file">${escapeHtml(file)}</span><span>L${line}</span></a>`;

const codeItems = (codeblocks: ResourceIndex["codeblocks"], page: boolean): string[] => {
    const terms = new Map<
        string,
        { entry: TermEntry; source: SourceLocation; references: Map<string, SourceLocation> }
    >();
    const items = codeblocks.flatMap(
        ({ language, format, caption, content, source, reference }) => {
            const location = reference ?? source;
            const parsed = page
                ? parseContentSource(language, content, `${location.file}#L${location.line}`)
                : undefined;
            const term = parsed?.blocks[0];
            if (term?.type === "term" && !parsed?.errors.length) {
                // Merge uses of the same definition, but keep distinct files and range contents.
                const key = JSON.stringify([location.file, location.line, content]);
                const item = terms.get(key) ?? {
                    entry: term.entry,
                    source: location,
                    references: new Map<string, SourceLocation>(),
                };
                if (source.file !== location.file || source.line !== location.line)
                    item.references.set(JSON.stringify(source), source);
                terms.set(key, item);
                return [];
            }
            const name = page
                ? caption !== source.file && caption !== reference?.file
                    ? caption
                    : ""
                : caption || (reference ? reference.file + (reference.range ?? "") : "");
            const blocks =
                parsed && !parsed.errors.length && parsed.blocks.length
                    ? parsed.blocks
                    : [
                          {
                              type: "code" as const,
                              lang: language === "mermaid" ? "text" : language,
                              lines: content.split("\n"),
                          },
                      ];
            const errors = parsed?.errors.length
                ? `<ul class="resource-errors">${parsed.errors.map((error) => `<li>${escapeHtml(error.message)}</li>`).join("")}</ul>`
                : "";
            return [
                `<details class="resource-item resource-code"${page ? " open" : ""} data-resource-item data-resource-group="${escapeHtml(format)}"><summary>${page ? "" : `${libraryIcon(format) ?? ""}<span class="resource-badge">${escapeHtml(format)}</span>`}${name ? `<span class="resource-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>` : ""}${sourceLink(source)}</summary><div class="resource-body">${reference ? `<div class="resource-sources">${sourceLink(reference)}</div>` : ""}${errors}${blocksHtml(blocks)}</div></details>`,
            ];
        },
    );
    const compare = termComparator(undefined);
    return [
        ...[...terms.values()]
            .sort((a, b) => compare(a.entry, b.entry))
            .map(
                ({ entry, source, references }) =>
                    `<div class="resource-item resource-term" data-resource-item data-resource-group="termth">${blocksHtml([{ type: "term", entry }])}<div class="resource-term-sources">${sourceLink(source)}${references.size ? `<details><summary><span data-i18n="references">references</span> (${references.size})</summary><div class="resource-sources">${[...references.values()].map(sourceLink).join("")}</div></details>` : ""}</div></div>`,
            ),
        ...items,
    ];
};

export const resourceLibraryHtml = (
    index: ResourceIndex,
    view: Exclude<ResourceView, "files"> | "subformats",
    pageTitle?: string,
    /** Library page: use each format's preview without the format picker. */
    page = false,
): string => {
    const subformatsOnly = view === "subformats";
    const groupLabel = subformatsOnly ? "Subformats" : view === "codeblocks" ? "Format" : "Domain";
    const urls = view === "url-previews" ? index.urlPreviews : index.urls;
    const groups = [
        ...new Set(
            subformatsOnly
                ? index.subformats.map((item) => item.ext)
                : view === "codeblocks"
                  ? [
                        ...index.codeblocks.map((item) => item.format),
                        ...index.subformats.map((item) => item.ext),
                    ]
                  : urls.map((item) => item.host),
        ),
    ].sort();
    const items = subformatsOnly
        ? []
        : view === "codeblocks"
          ? codeItems(index.codeblocks, page)
          : urls.map(
                ({ url, host, sources }) =>
                    `<details class="resource-item resource-url" data-resource-item data-resource-group="${escapeHtml(host)}"><summary><a class="resource-name" href="${escapeHtml(url)}" title="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a><span class="resource-usage" title="references" data-i18n-title="references">${sources.length}</span></summary><div class="resource-body resource-sources">${sources.map(sourceLink).join("")}</div></details>`,
            );
    const relations =
        subformatsOnly && pageTitle === undefined && index.relations?.edges.length
            ? index.relations
            : undefined;
    const filterGroups = subformatsOnly ? index.subformats.map((item) => item.ext) : groups;
    const selector =
        !page && (filterGroups.length || subformatsOnly)
            ? `<select data-resource-filter${subformatsOnly ? " data-subformat-filter hidden" : ""} aria-label="${groupLabel}" data-i18n-aria-label="${groupLabel}">${subformatsOnly ? (filterGroups.length ? "" : '<option value="" data-i18n="Subformats">Subformats</option>') : '<option value="" data-i18n="All">All</option>'}${filterGroups
                  .map((group) => {
                      const collection = index.subformats.find((item) => item.ext === group);
                      const change = collection && subformatChange(collection);
                      return `<option value="${escapeHtml(group)}"${change ? ` data-subformat-change="${change}"` : ""}>${escapeHtml(group)}</option>`;
                  })
                  .join(
                      "",
                  )}${relations ? '<option value="*" data-i18n="Relations">Relations</option>' : ""}</select>`
            : "";
    const selectedChange = index.subformats[0] && subformatChange(index.subformats[0]);
    const filter =
        pageTitle !== undefined
            ? `<h1 class="subformat-page-title">${escapeHtml(pageTitle)}</h1>`
            : subformatsOnly
              ? `<div class="subformat-picker">${selector}<button type="button" data-subformat-trigger aria-haspopup="menu" aria-expanded="false"${selectedChange ? ` data-subformat-change="${selectedChange}"` : ""}>${escapeHtml(filterGroups[0] ?? "Subformats")}</button><div class="subformat-picker-menu" data-subformat-options popover="auto" role="menu" aria-label="Subformats" data-i18n-aria-label="Subformats"></div></div>`
              : selector;
    const search = `<label class="resource-search"><svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="${SEARCH_ICON_PATH}"/></svg><input type="search" data-resource-search placeholder="Search resources" aria-label="Search resources" data-i18n-placeholder="Search resources" data-i18n-aria-label="Search resources"></label>`;
    const subformats =
        subformatsOnly || (view === "codeblocks" && index.subformats.length)
            ? `<template data-subformats>${escapeHtml(JSON.stringify(index.subformats))}</template><div data-subformat-board role="region" hidden></div>${relations ? `<div data-subformat-relations hidden>${blocksHtml([{ type: "schemaGraph", graph: relations }])}</div>` : ""}`
            : "";
    const emptyMessage =
        subformatsOnly && !index.subformats.length
            ? "No subformats configured. Add subformats to dooc.yaml."
            : "No matching resources";
    return `<section class="resource-results" data-resource-results${page ? " data-resource-page" : ""}${pageTitle !== undefined ? ` data-subformat-page="${escapeHtml(index.subformats[0]?.ext ?? "")}"` : ""}><div class="resource-toolbar">${subformatsOnly ? `<div class="resource-query">${filter}</div>` : `${page ? "" : '<span data-i18n="Name">Name</span>'}${search}${filter}`}${subformatsOnly ? "" : `<span class="resource-count" data-resource-count role="status" aria-live="polite">${items.length}</span>`}</div>${subformats}${index.errors.length && !page ? `<details class="resource-errors"><summary><span data-i18n="Files with errors">Files with errors</span> (${index.errors.length})</summary><ul>${index.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></details>` : ""}<div class="resource-items resource-${view}">${items.join("")}</div><p class="resource-empty" data-resource-empty${items.length ? " hidden" : ""} data-i18n="${emptyMessage}">${emptyMessage}</p></section>`;
};

/** A Library view shown as a site page: one block format, `urls` or `url-previews`. */
export const libraryPageHtml = (index: ResourceIndex, view: string, title: string): string => {
    const heading = `<h1 class="subformat-page-title">${escapeHtml(title)}</h1>`;
    if (view === "urls" || view === "url-previews")
        return heading + resourceLibraryHtml({ ...index, subformats: [] }, view, undefined, true);
    return (
        heading +
        resourceLibraryHtml(
            {
                ...index,
                subformats: [],
                codeblocks: index.codeblocks.filter((item) => item.format === view),
            },
            "codeblocks",
            undefined,
            true,
        )
    );
};
