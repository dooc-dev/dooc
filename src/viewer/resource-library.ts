import { basename, extname } from "node:path";
import type { Root } from "mdast";
import { bundledLanguagesInfo } from "shiki/langs";
import { visit } from "unist-util-visit";
import { readManifest } from "../compiler/manifest.js";
import {
    type LoadedSubformat,
    loadSubformat,
    parseSubformatRecord,
    validateSubformatRecord,
} from "../compiler/subformats.js";
import { parseTermSource } from "../compiler/terms.js";
import { readTextfile, selectTextfileRange } from "../compiler/textfile.js";
import { parseFileEmbed } from "../core/file-embed.js";
import { fileExtension, localFile } from "../core/files.js";
import { blocksHtml, escapeHtml } from "../core/html.js";
import { SEARCH_ICON_PATH } from "../core/icons.js";
import { parseMdast } from "../core/markdown.js";
import { type SubformatCollection, subformatChange } from "../core/subformats.js";
import { parseFileReference, parseTextfileRange } from "../core/textfile.js";

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
    errors: string[];
}

const codeFormat = (language: string): string =>
    /^(text|txt|plain|plaintext)$/.test(language)
        ? "text"
        : (bundledLanguagesInfo.find(
              (entry) => entry.id === language || entry.aliases?.includes(language),
          )?.id ?? language);

/** Index authored content, including files not referenced by any document. */
export const resourceIndex = (root: string, files: readonly string[]): ResourceIndex => {
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
            const loaded = loadSubformat(root, config);
            formats.set(config.ext, loaded);
            result.subformats.push({
                ...config,
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
                result.codeblocks.push({
                    language: formats.get(language)?.format ?? language,
                    format: formats.has(language) ? language : codeFormat(language),
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
            if (!/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) {
                try {
                    const file = parseFileReference(target).file.replace(/^(\.\/)+/, "");
                    if (localFile(file) && formats.has(fileExtension(file))) {
                        const sources = references.get(file) ?? [];
                        sources.push(source);
                        references.set(file, sources);
                    }
                } catch {
                    // Invalid references are reported by the compiler.
                }
            }
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
            } else scan(parseMdast(raw), file);
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
                      `<a href="/_statics/${key}"${view === key ? ' aria-current="page"' : ""} data-i18n="${label}">${label}</a>`,
              )
              .join("")}</nav>`;

const sourceLink = ({ file, line }: SourceLocation): string =>
    `<a class="resource-source" href="/_files/file/${encodeURIComponent(file)}#L${line}" data-resource-source="${escapeHtml(file)}" data-resource-line="${line}" title="${escapeHtml(file)}:L${line}"><span class="resource-source-file">${escapeHtml(file)}</span><span>L${line}</span></a>`;

export const resourceLibraryHtml = (
    index: ResourceIndex,
    view: Exclude<ResourceView, "files"> | "subformats",
    pageTitle?: string,
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
          ? index.codeblocks.map(({ language, format, caption, content, source, reference }) => {
                const name = caption || (reference ? reference.file + (reference.range ?? "") : "");
                return `<details class="resource-item resource-code" data-resource-item data-resource-group="${escapeHtml(format)}"><summary><span class="resource-badge">${escapeHtml(format)}</span>${name ? `<span class="resource-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>` : ""}${sourceLink(source)}</summary><div class="resource-body">${reference ? `<div class="resource-sources">${sourceLink(reference)}</div>` : ""}${blocksHtml([{ type: "code", lang: language === "mermaid" ? "text" : language, lines: content.split("\n") }])}</div></details>`;
            })
          : urls.map(
                ({ url, host, sources }) =>
                    `<details class="resource-item resource-url" data-resource-item data-resource-group="${escapeHtml(host)}"><summary><a class="resource-name" href="${escapeHtml(url)}" title="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a><span class="resource-usage" title="references" data-i18n-title="references">${sources.length}</span></summary><div class="resource-body resource-sources">${sources.map(sourceLink).join("")}</div></details>`,
            );
    const filterGroups = subformatsOnly ? index.subformats.map((item) => item.ext) : groups;
    const selector =
        filterGroups.length || subformatsOnly
            ? `<select data-resource-filter${subformatsOnly ? " data-subformat-filter hidden" : ""} aria-label="${groupLabel}" data-i18n-aria-label="${groupLabel}">${subformatsOnly ? (filterGroups.length ? "" : '<option value="" data-i18n="Subformats">Subformats</option>') : '<option value="" data-i18n="All">All</option>'}${filterGroups
                  .map((group) => {
                      const collection = index.subformats.find((item) => item.ext === group);
                      const change = collection && subformatChange(collection);
                      return `<option value="${escapeHtml(group)}"${change ? ` data-subformat-change="${change}"` : ""}>${escapeHtml(group)}</option>`;
                  })
                  .join("")}</select>`
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
            ? `<template data-subformats>${escapeHtml(JSON.stringify(index.subformats))}</template><div data-subformat-board role="region" hidden></div>`
            : "";
    const emptyMessage =
        subformatsOnly && !index.subformats.length
            ? "No subformats configured. Add subformats to dooc.yaml."
            : "No matching resources";
    return `<section class="resource-results" data-resource-results${pageTitle !== undefined ? ` data-subformat-page="${escapeHtml(index.subformats[0]?.ext ?? "")}"` : ""}><div class="resource-toolbar">${subformatsOnly ? `<div class="resource-query">${filter}</div>` : `<span data-i18n="Name">Name</span>${search}${filter}`}${subformatsOnly ? "" : `<span class="resource-count" data-resource-count role="status" aria-live="polite">${items.length}</span>`}</div>${subformats}${index.errors.length ? `<details class="resource-errors"><summary><span data-i18n="Files with errors">Files with errors</span> (${index.errors.length})</summary><ul>${index.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></details>` : ""}<div class="resource-items resource-${view}">${items.join("")}</div><p class="resource-empty" data-resource-empty${items.length ? " hidden" : ""} data-i18n="${emptyMessage}">${emptyMessage}</p></section>`;
};
