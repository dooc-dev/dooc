// dooc.yaml owns document hierarchy and display settings. Nested manifests identify documents
// by complete source paths; legacy manifests retain their authored IDs during migration.

import { type Document, stringify } from "yaml";
import { parseVersionConfig, type VersionConfig } from "./document-version.js";
import {
    docFile,
    type FileLayout,
    fileDocumentId,
    isSkillFile,
    localFile,
    parseFileLayout,
} from "./files.js";
import {
    type FormatSettings,
    isFormat,
    isReferenceLibrary,
    parseCollections,
    type ReferenceLibrary,
} from "./formats.js";
import { contentLanguageCode, DEFAULT_LANG, isLangTag } from "./language.js";
import { isRemoteManifest, remoteManifestSource } from "./remote-manifest.js";
import { parseSubformats, type Subformat } from "./subformats.js";

export const MANIFEST_FILE = "dooc.yaml";

export const isManifestFile = (name: string): boolean => /^(?:[^/\\]+\.)?dooc\.yaml$/.test(name);

export interface DocNode {
    id: string;
    file?: string;
    url?: string;
    root?: boolean;
    name?: string;
    /** Included manifests stay separate when the owning manifest is saved. */
    resolved?: DocNode;
    origin?: string;
    subformat?: string;
    /** A reference collection page. */
    library?: string;
    format?: string;
    title?: string;
    children: DocNode[];
}

export interface ParsedManifest {
    version?: VersionConfig;
    format?: "nested" | "document";
    titles?: Record<string, string>;
    themeIcons?: Record<string, string>;
    tree: DocNode[];
    title?: string;
    icon?: string;
    defaultLang?: string;
    licence?: string;
    skills?: string[];
    libraries?: ReferenceLibrary[];
    formats?: FormatSettings;
    includedFormats?: Record<string, FormatSettings>;
    files?: FileLayout;
    /** Content languages offered by the site, including defaultLang; normalized to ISO 639-3. */
    languages?: string[];
    /** Color themes offered by the site, with authored variants for embedded files. */
    themes?: ("light" | "dark")[];
    subformats?: Subformat[];
    defaultSubformatFolder?: string;
    includedManifests?: string[];
    includedAssets?: string[];
    includedSubformats?: string[];
    errors: string[];
}

export const pageUrlKind = (
    url: string,
): "index" | "content" | "file" | "manifest" | "link" | "redirect" => {
    if (!url) return "index";
    if (url === "redirect:first") return "redirect";
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters before URL normalization.
    if (/[\\\u0000-\u001f\u007f]/.test(url)) throw new Error("Invalid document URL");
    if (/^https?:\/\//i.test(url)) {
        const target = new URL(url);
        if (!target.hostname || target.username || target.password)
            throw new Error("Document links require a host and must not contain credentials");
        if (isRemoteManifest(url)) {
            remoteManifestSource(url);
            return "manifest";
        }
        return "link";
    }
    if (url.startsWith("/") && !url.startsWith("//")) {
        const target = new URL(url, "https://dooc.invalid");
        if (target.pathname !== url.split(/[?#]/)[0])
            throw new Error("Document links must use a normalized site path");
        return "link";
    }
    if (localFile(url)) {
        if (url.endsWith(".md")) return "content";
        if (isManifestFile(url.split("/").at(-1) ?? "")) return "manifest";
        return "file";
    }
    throw new Error(
        "Document URL must be empty, a local file, an HTTP(S) URL, a site path, or redirect:first",
    );
};

export const isContentPage = (node: {
    url?: string;
    subformat?: unknown;
    library?: string;
    format?: string;
}): boolean =>
    !node.subformat &&
    !node.library &&
    !node.format &&
    (node.url === undefined || pageUrlKind(node.url) === "content");

export const DOC_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export const isDocId = (s: string): boolean => DOC_ID_RE.test(s);

export const libraryPageId = (view: string): string => `library-${fileDocumentId(view)}`;
// Preserve existing content-collection IDs across the Library-to-Format migration.
export const formatPageId = (format: string): string =>
    isReferenceLibrary(format) ? `format-${fileDocumentId(format)}` : libraryPageId(format);
export const isLibraryView = (view: unknown): view is string =>
    typeof view === "string" && /^[a-z0-9][a-z0-9+#-]*$/.test(view);

export const subformatPageId = (ext: string): string => `subformat-${fileDocumentId(ext)}`;

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
    if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        ["document", "system", "left_sidebar", "center_contents", "json_subformats"].some(
            (key) => key in (value as object),
        )
    )
        return parseNestedManifest(value);
    const errors: string[] = [];
    let title: string | undefined;
    let version: VersionConfig | undefined;
    let icon: string | undefined;
    let defaultLang: string | undefined;
    let files: FileLayout | undefined;
    let languages: string[] | undefined;
    let themes: ParsedManifest["themes"];
    let subformats: Subformat[] | undefined;
    let defaultSubformatFolder: string | undefined;
    if (value != null && typeof value === "object" && !Array.isArray(value)) {
        const manifest = value as Record<string, unknown>;
        for (const key of Object.keys(manifest))
            if (
                key !== "title" &&
                key !== "version" &&
                key !== "icon" &&
                key !== "defaultLang" &&
                key !== "docs" &&
                key !== "files" &&
                key !== "languages" &&
                key !== "themes" &&
                key !== "subformats" &&
                key !== "default_subformat_folder"
            )
                errors.push(`${MANIFEST_FILE}: unknown field "${key}"`);
        if (manifest.version !== undefined) {
            try {
                version = parseVersionConfig(manifest.version);
            } catch (error) {
                errors.push(`${MANIFEST_FILE}: ${error instanceof Error ? error.message : error}`);
            }
        }
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
        if (manifest.files !== undefined) {
            try {
                files = parseFileLayout(manifest.files);
            } catch (error) {
                errors.push(`${MANIFEST_FILE}: ${error instanceof Error ? error.message : error}`);
            }
        }
        if (manifest.subformats !== undefined) {
            try {
                subformats = parseSubformats(manifest.subformats);
            } catch (error) {
                errors.push(`${MANIFEST_FILE}: ${error instanceof Error ? error.message : error}`);
            }
        }
        if (manifest.default_subformat_folder !== undefined) {
            const folder = manifest.default_subformat_folder;
            if (
                !localFile(folder) ||
                isManifestFile(folder.split("/")[0] ?? "") ||
                [
                    "node_modules",
                    "build",
                    "dist",
                    "locales",
                    MANIFEST_FILE,
                    "docs.config.mjs",
                ].includes(folder.split("/")[0] ?? "")
            )
                errors.push(
                    `${MANIFEST_FILE}: default_subformat_folder must be a local project folder`,
                );
            else defaultSubformatFolder = folder;
        }
        if (manifest.languages !== undefined) {
            try {
                if (
                    !Array.isArray(manifest.languages) ||
                    !manifest.languages.length ||
                    manifest.languages.some((tag) => typeof tag !== "string" || !isLangTag(tag))
                )
                    throw new Error("languages must be a non-empty list of language tags");
                languages = manifest.languages.map(contentLanguageCode);
                if (new Set(languages).size !== languages.length)
                    throw new Error(
                        "languages must contain distinct languages after normalization",
                    );
                if (!languages.includes(contentLanguageCode(defaultLang ?? DEFAULT_LANG)))
                    throw new Error("languages must include defaultLang");
            } catch (error) {
                errors.push(`${MANIFEST_FILE}: ${error instanceof Error ? error.message : error}`);
            }
        }
        if (manifest.themes !== undefined) {
            if (
                !Array.isArray(manifest.themes) ||
                !manifest.themes.length ||
                manifest.themes.some((theme) => theme !== "light" && theme !== "dark") ||
                new Set(manifest.themes).size !== manifest.themes.length
            )
                errors.push(
                    `${MANIFEST_FILE}: themes must be a non-empty list of distinct light / dark themes supported by the reader`,
                );
            else themes = manifest.themes;
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
            if (
                item &&
                typeof item === "object" &&
                !Array.isArray(item) &&
                ("library" in item || "format" in item)
            ) {
                const view = item.format ?? item.library;
                const reference = item.format === undefined && isReferenceLibrary(view);
                const id = isFormat(view)
                    ? reference
                        ? libraryPageId(view)
                        : formatPageId(view)
                    : "";
                if (
                    !id ||
                    (item.library !== undefined && item.format !== undefined) ||
                    Object.keys(item).some(
                        (key) => !["library", "format", "title", "children"].includes(key),
                    ) ||
                    (item.title !== undefined &&
                        (typeof item.title !== "string" || !item.title.trim()))
                ) {
                    errors.push(
                        `${MANIFEST_FILE}: ${at} requires a library view and a non-empty title`,
                    );
                    continue;
                }
                if (seen.has(id)) {
                    errors.push(`${MANIFEST_FILE}: duplicate id "${id}"`);
                    continue;
                }
                seen.add(id);
                nodes.push({
                    id,
                    ...(reference ? { library: view } : { format: view }),
                    title: item.title?.trim() ?? view,
                    children: walk(item.children, `${at}.children`),
                });
                continue;
            }
            if (item && typeof item === "object" && !Array.isArray(item) && "subformat" in item) {
                const config = subformats?.find((format) => format.ext === item.subformat);
                if (
                    !config ||
                    Object.keys(item).some(
                        (key) => !["subformat", "title", "children"].includes(key),
                    ) ||
                    (item.title !== undefined &&
                        (typeof item.title !== "string" || !item.title.trim()))
                ) {
                    errors.push(
                        `${MANIFEST_FILE}: ${at} requires a registered subformat and a non-empty title`,
                    );
                    continue;
                }
                const id = subformatPageId(config.ext);
                if (seen.has(id)) {
                    errors.push(`${MANIFEST_FILE}: duplicate id "${id}"`);
                    continue;
                }
                seen.add(id);
                nodes.push({
                    id,
                    subformat: config.ext,
                    title: item.title?.trim() ?? config.ext,
                    children: walk(item.children, `${at}.children`),
                });
                continue;
            }
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
        const paths = flattenTree(tree)
            .filter((node) => !node.subformat && !node.library && !node.format)
            .map(({ id }) => docFile(id, files));
        if (new Set(paths).size !== paths.length)
            errors.push(`${MANIFEST_FILE}: documents must use distinct files`);
    }
    return {
        tree,
        ...(version === undefined ? {} : { version }),
        ...(title === undefined ? {} : { title }),
        ...(icon === undefined ? {} : { icon }),
        ...(defaultLang === undefined ? {} : { defaultLang }),
        ...(files === undefined ? {} : { files }),
        ...(languages === undefined ? {} : { languages }),
        ...(themes === undefined ? {} : { themes }),
        ...(subformats === undefined ? {} : { subformats }),
        ...(defaultSubformatFolder === undefined ? {} : { defaultSubformatFolder }),
        errors,
    };
};

const parseNestedManifest = (input: object): ParsedManifest => {
    try {
        const object = (value: unknown, keys: string[], at: string): Record<string, unknown> => {
            if (!value || typeof value !== "object" || Array.isArray(value))
                throw new Error(`${at} must be an object`);
            for (const key of Object.keys(value))
                if (!keys.includes(key)) throw new Error(`${at}: unknown field "${key}"`);
            return value as Record<string, unknown>;
        };
        const root = object(
            input,
            [
                "version",
                "system",
                "left_sidebar",
                "center_contents",
                "json_subformats",
                "default_subformat_folder",
                "document",
            ],
            MANIFEST_FILE,
        );
        const documentFormat = Object.hasOwn(root, "document");
        if (
            documentFormat &&
            (root.center_contents !== undefined || root.left_sidebar !== undefined)
        )
            throw new Error("document replaces center_contents and left_sidebar");
        const document = documentFormat
            ? object(
                  root.document,
                  ["title", "url", "icon", "sidebar", "children", "subformat", "library", "format"],
                  "document",
              )
            : undefined;
        const system = object(
            root.system ?? {},
            [
                "languages",
                "default_lang",
                "themes",
                "licence",
                "skills",
                "files",
                "library",
                "format",
            ],
            "system",
        );
        const collections = parseCollections(system);
        const licence = system.licence;
        if (licence !== undefined && (!localFile(licence) || !licence.trim()))
            throw new Error("system.licence must be a local file path");
        const skills = system.skills;
        if (
            skills !== undefined &&
            (!Array.isArray(skills) ||
                skills.some((file) => !isSkillFile(file)) ||
                new Set(skills).size !== skills.length)
        )
            throw new Error(
                "system.skills must be a list of unique project-relative SKILL.md paths",
            );
        const sidebar = object(
            document?.sidebar ?? root.left_sidebar ?? {},
            ["title", "icon"],
            "sidebar",
        );
        const layout = object(system.files ?? {}, ["default_layout", "order"], "system.files");
        const titles: Record<string, string> = {};
        if (sidebar.title !== undefined) {
            if (!sidebar.title || typeof sidebar.title !== "object" || Array.isArray(sidebar.title))
                throw new Error("left_sidebar.title must map languages to titles");
            for (const [tag, title] of Object.entries(sidebar.title)) {
                if (!isLangTag(tag) || typeof title !== "string" || !title.trim())
                    throw new Error("Invalid localized site title");
                const code = contentLanguageCode(tag);
                if (Object.hasOwn(titles, code))
                    throw new Error(`Duplicate title language: ${code}`);
                titles[code] = title.trim();
            }
        }
        if (document?.icon !== undefined && sidebar.icon !== undefined)
            throw new Error("Use document.icon only; remove document.sidebar.icon");
        const rootIcon = document?.icon !== undefined ? document.icon : sidebar.icon;
        const scalarIcon = documentFormat && typeof rootIcon === "string" ? rootIcon : undefined;
        const themeIcons: Record<string, string> = {};
        if (rootIcon !== undefined && scalarIcon === undefined) {
            const icons = object(
                rootIcon,
                ["light", "dark"],
                documentFormat ? "document.icon" : "left_sidebar.icon",
            );
            for (const [theme, file] of Object.entries(icons)) {
                if (!localFile(file) || !file.endsWith(".svg"))
                    throw new Error("Site icons must be local SVG files");
                themeIcons[theme] = file;
            }
        }
        const icon = scalarIcon ?? themeIcons.light ?? themeIcons.dark;
        const documents: Record<string, string> = {};
        const icons: Record<string, string> = {};
        const walk = (value: unknown, position = "root"): DocNode[] => {
            if (!Array.isArray(value))
                throw new Error("center_contents and children must be lists");
            return value.map((entry, index) => {
                const at = `${position}-${index + 1}`;
                if (documentFormat) entry = object(entry, ["document"], at).document;
                const node = object(
                    entry,
                    documentFormat
                        ? [
                              "url",
                              "icon",
                              "children",
                              "subformat",
                              "library",
                              "format",
                              "title",
                              ...(position === "root" ? ["sidebar"] : []),
                          ]
                        : ["file", "icon", "children", "subformat", "library", "format", "title"],
                    documentFormat ? "document" : "center_contents",
                );
                if (documentFormat && node.url != null && typeof node.url !== "string")
                    throw new Error("Document URL must be a string");
                const url = documentFormat
                    ? String(node.url ?? "").replace(/^(\.\/)+/, "")
                    : undefined;
                const kind = url === undefined ? "content" : pageUrlKind(url);
                const location = documentFormat
                    ? { url, ...(position === "root" ? { root: true } : {}) }
                    : {};
                const nodeIcon = documentFormat && position === "root" ? icon : node.icon;
                if (nodeIcon !== undefined && (!localFile(nodeIcon) || !nodeIcon.endsWith(".svg")))
                    throw new Error("Document icons must be local SVG files");
                if (node.library !== undefined || node.format !== undefined) {
                    const view = node.format ?? node.library;
                    const reference = node.format === undefined && isReferenceLibrary(view);
                    if (
                        !isFormat(view) ||
                        (node.library !== undefined && node.format !== undefined) ||
                        node.file !== undefined ||
                        url ||
                        node.subformat !== undefined ||
                        (node.title !== undefined &&
                            (typeof node.title !== "string" || !node.title.trim()))
                    )
                        throw new Error("Library pages require a view and a non-empty title");
                    const id = reference
                        ? libraryPageId(view as string)
                        : formatPageId(view as string);
                    if (typeof nodeIcon === "string") icons[id] = nodeIcon;
                    return {
                        id,
                        ...location,
                        ...(reference ? { library: view as string } : { format: view as string }),
                        title:
                            typeof node.title === "string" ? node.title.trim() : (view as string),
                        children: node.children === undefined ? [] : walk(node.children, at),
                    };
                }
                if (node.subformat !== undefined) {
                    const config = parseSubformats(root.json_subformats ?? []).find(
                        (format) => format.ext === node.subformat,
                    );
                    if (
                        !config ||
                        node.file !== undefined ||
                        url ||
                        (node.title !== undefined &&
                            (typeof node.title !== "string" || !node.title.trim()))
                    )
                        throw new Error(
                            "Subformat pages require a registered subformat and a non-empty title",
                        );
                    const id = subformatPageId(config.ext);
                    if (typeof nodeIcon === "string") icons[id] = nodeIcon;
                    return {
                        id,
                        ...location,
                        subformat: config.ext,
                        title: typeof node.title === "string" ? node.title.trim() : config.ext,
                        children: node.children === undefined ? [] : walk(node.children, at),
                    };
                }
                if (!documentFormat && (!localFile(node.file) || !node.file.endsWith(".md")))
                    throw new Error("Each document requires a local .md file");
                if (
                    node.title !== undefined &&
                    (typeof node.title !== "string" || !node.title.trim())
                )
                    throw new Error("Document titles must be non-empty strings");
                if (kind === "manifest" && node.children !== undefined)
                    throw new Error("An included manifest owns its children");
                const file = kind === "content" ? (url ?? (node.file as string)) : undefined;
                const id = fileDocumentId(
                    file ?? (kind === "manifest" ? (url as string) : `document:${at}`),
                );
                if (Object.hasOwn(documents, id))
                    throw new Error(`Duplicate document: ${node.file}`);
                if (file) documents[id] = file;
                if (typeof nodeIcon === "string") icons[id] = nodeIcon;
                const remote = url && isRemoteManifest(url) ? remoteManifestSource(url) : undefined;
                const manifestPath = remote?.path ?? url;
                return {
                    id,
                    ...location,
                    ...(file ? { file } : {}),
                    ...(documentFormat && kind !== "content"
                        ? {
                              name:
                                  kind === "file"
                                      ? (url as string).split("/").at(-1)
                                      : kind === "manifest"
                                        ? (manifestPath as string).split("/").at(-1) ===
                                          MANIFEST_FILE
                                            ? ((manifestPath as string).split("/").at(-2) ??
                                              remote?.repository
                                                  .split("/")
                                                  .at(-1)
                                                  ?.replace(/\.git$/, "") ??
                                              "index")
                                            : ((manifestPath as string)
                                                  .split("/")
                                                  .at(-1)
                                                  ?.replace(/\.dooc\.yaml$/, "") ?? "index")
                                        : typeof node.title === "string"
                                          ? node.title.trim()
                                          : `page-${index + 1}`,
                          }
                        : {}),
                    ...(typeof node.title === "string" ? { title: node.title.trim() } : {}),
                    children: node.children === undefined ? [] : walk(node.children, at),
                };
            });
        };
        const tree = walk(documentFormat ? [{ document }] : root.center_contents);
        const language = system.default_lang ?? DEFAULT_LANG;
        if (typeof language !== "string" || !isLangTag(language))
            throw new Error("system.default_lang must be a language tag");
        const source = contentLanguageCode(language);
        if (sidebar.title !== undefined && !titles[source])
            throw new Error("left_sidebar.title must include system.default_lang");
        const legacyTree = (nodes: DocNode[]): unknown[] =>
            nodes.map((node) =>
                node.library || node.format
                    ? {
                          ...(node.library ? { library: node.library } : { format: node.format }),
                          title: node.title,
                          ...(node.children.length ? { children: legacyTree(node.children) } : {}),
                      }
                    : node.subformat
                      ? {
                            subformat: node.subformat,
                            title: node.title,
                            children: legacyTree(node.children),
                        }
                      : node.children.length
                        ? { [node.id]: legacyTree(node.children) }
                        : node.id,
            );
        const parsed = parseManifest({
            ...(root.version === undefined ? {} : { version: root.version }),
            docs: legacyTree(tree),
            defaultLang: language,
            ...(system.languages === undefined ? {} : { languages: system.languages }),
            ...(system.themes === undefined ? {} : { themes: system.themes }),
            ...(titles[source] || document?.title
                ? { title: titles[source] ?? document?.title }
                : {}),
            ...(icon === undefined ? {} : { icon }),
            files: {
                defaultLayout: layout.default_layout,
                documents,
                ...(Object.keys(icons).length ? { icons } : {}),
            },
            ...(root.json_subformats === undefined ? {} : { subformats: root.json_subformats }),
            ...(root.default_subformat_folder === undefined
                ? {}
                : { default_subformat_folder: root.default_subformat_folder }),
        });
        return {
            ...parsed,
            format: documentFormat ? "document" : "nested",
            tree,
            ...(licence === undefined ? {} : { licence }),
            ...(skills === undefined ? {} : { skills: skills as string[] }),
            ...collections,
            ...(sidebar.title === undefined ? {} : { titles }),
            ...(rootIcon !== undefined && scalarIcon === undefined ? { themeIcons } : {}),
        };
    } catch (error) {
        return {
            format: "nested",
            tree: [],
            errors: [`${MANIFEST_FILE}: ${error instanceof Error ? error.message : error}`],
        };
    }
};

/** Move the former sidebar icon without discarding YAML comments or choosing between duplicates. */
export const migrateDocumentIcon = (document: Document): boolean => {
    const previous = ["document", "sidebar", "icon"];
    if (!document.hasIn(previous)) return false;
    if (document.hasIn(["document", "icon"]))
        throw new Error("Use document.icon only; remove document.sidebar.icon");
    document.setIn(["document", "icon"], document.getIn(previous, true));
    document.deleteIn(previous);
    return true;
};

/** Serialize the authored format; legacy manifests remain readable during migration. */
export const serializeManifest = (
    tree: readonly DocNode[],
    {
        format,
        version,
        titles,
        themeIcons,
        title,
        icon,
        defaultLang,
        licence,
        skills,
        libraries,
        formats,
        files,
        languages,
        themes,
        subformats,
        defaultSubformatFolder,
        includedSubformats,
    }: Omit<ParsedManifest, "tree" | "errors"> = {},
): string => {
    if (format) {
        const contents = (nodes: readonly DocNode[]): unknown[] =>
            nodes.map((node) => {
                const page = {
                    ...(node.library || node.format
                        ? {
                              ...(node.library
                                  ? { library: node.library }
                                  : { format: node.format }),
                              title: node.title,
                          }
                        : node.subformat
                          ? { subformat: node.subformat, title: node.title }
                          : {
                                ...(format === "document"
                                    ? {
                                          url: isContentPage(node)
                                              ? docFile(node.id, files)
                                              : (node.url ?? ""),
                                      }
                                    : { file: docFile(node.id, files) }),
                                ...(node.title ? { title: node.title } : {}),
                            }),
                    ...(files?.icons?.[node.id] ? { icon: files.icons[node.id] } : {}),
                    ...(node.children.length ? { children: contents(node.children) } : {}),
                };
                return format === "document" ? { document: page } : page;
            });
        const sidebar = {
            ...(titles || (format !== "document" && title)
                ? { title: titles ?? { [contentLanguageCode(defaultLang ?? DEFAULT_LANG)]: title } }
                : {}),
            ...(format !== "document" && (themeIcons || icon)
                ? { icon: themeIcons ?? { light: icon, dark: icon } }
                : {}),
        };
        const hasSidebar = Object.keys(sidebar).length > 0;
        const pages = contents(tree);
        return stringify(
            {
                ...(version === undefined ? {} : { version }),
                system: {
                    ...(languages ? { languages } : {}),
                    default_lang: defaultLang ?? DEFAULT_LANG,
                    ...(licence === undefined ? {} : { licence }),
                    ...(skills === undefined ? {} : { skills }),
                    ...(libraries === undefined ? {} : { library: libraries }),
                    ...(formats === undefined ? {} : { format: formats }),
                    ...(themes ? { themes } : {}),
                    ...(files
                        ? {
                              files: {
                                  default_layout: files.defaultLayout,
                              },
                          }
                        : {}),
                },
                ...(format === "document"
                    ? {
                          document: {
                              ...((pages[0] as { document: object } | undefined)?.document ?? {
                                  url: "",
                              }),
                              ...(themeIcons || icon ? { icon: themeIcons ?? icon } : {}),
                              ...(hasSidebar ? { sidebar } : {}),
                          },
                      }
                    : { ...(hasSidebar ? { left_sidebar: sidebar } : {}), center_contents: pages }),
                ...(subformats
                    ? {
                          json_subformats: subformats.filter(
                              ({ ext }) => !includedSubformats?.includes(ext),
                          ),
                      }
                    : {}),
                ...(defaultSubformatFolder
                    ? { default_subformat_folder: defaultSubformatFolder }
                    : {}),
            },
            { lineWidth: 0 },
        );
    }
    if (flattenTree(tree).some((node) => node.subformat || node.library || node.format)) {
        const contents = (nodes: readonly DocNode[]): unknown[] =>
            nodes.map((node) =>
                node.library || node.format
                    ? {
                          ...(node.library ? { library: node.library } : { format: node.format }),
                          title: node.title,
                          ...(node.children.length ? { children: contents(node.children) } : {}),
                      }
                    : node.subformat
                      ? {
                            subformat: node.subformat,
                            title: node.title,
                            ...(node.children.length ? { children: contents(node.children) } : {}),
                        }
                      : node.children.length
                        ? { [node.id]: contents(node.children) }
                        : node.id,
            );
        return stringify({
            ...(version === undefined ? {} : { version }),
            ...(title ? { title } : {}),
            ...(icon ? { icon } : {}),
            ...(defaultLang ? { defaultLang } : {}),
            ...(files ? { files } : {}),
            ...(languages ? { languages } : {}),
            ...(themes ? { themes } : {}),
            ...(subformats ? { subformats } : {}),
            ...(defaultSubformatFolder ? { default_subformat_folder: defaultSubformatFolder } : {}),
            docs: contents(tree),
        });
    }
    const write = (nodes: readonly DocNode[], indent: string): string[] =>
        nodes.flatMap((n) =>
            n.children.length > 0
                ? [`${indent}- ${n.id}:`, ...write(n.children, `${indent}    `)]
                : [`${indent}- ${n.id}`],
        );
    if (
        version !== undefined ||
        title !== undefined ||
        icon !== undefined ||
        defaultLang !== undefined ||
        files !== undefined ||
        languages !== undefined ||
        themes !== undefined ||
        subformats !== undefined ||
        defaultSubformatFolder !== undefined
    ) {
        const lines = write(tree, "  ");
        const metadata = `${title === undefined ? "" : `title: ${JSON.stringify(title)}\n`}${icon === undefined ? "" : `icon: ${JSON.stringify(icon)}\n`}${defaultLang === undefined ? "" : `defaultLang: ${JSON.stringify(defaultLang)}\n`}${defaultSubformatFolder === undefined ? "" : `default_subformat_folder: ${JSON.stringify(defaultSubformatFolder)}\n`}`;
        return `${version === undefined ? "" : `version: ${JSON.stringify(version)}\n`}${metadata}${files ? `files: ${JSON.stringify(files)}\n` : ""}${languages ? `languages: ${JSON.stringify(languages)}\n` : ""}${themes ? `themes: ${JSON.stringify(themes)}\n` : ""}${subformats ? `subformats: ${JSON.stringify(subformats)}\n` : ""}docs:${lines.length ? `\n${lines.join("\n")}\n` : " []\n"}`;
    }
    const lines = write(tree, "");
    return `# Doc hierarchy and order (each id = content/<id>.md)\n${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
};

/** Flatten the tree into display order (pre-order). parent omitted = top level. */
export const flattenTree = (
    tree: readonly DocNode[],
): (Omit<DocNode, "children"> & { parent?: string; depth: number })[] => {
    const out: (Omit<DocNode, "children"> & { parent?: string; depth: number })[] = [];
    const walk = (nodes: readonly DocNode[], parent: string | undefined, depth: number): void => {
        for (const original of nodes) {
            const n = original.resolved
                ? {
                      ...original.resolved,
                      id: original.id,
                      root: original.root,
                      name: original.name,
                      ...(original.title ? { title: original.title } : {}),
                  }
                : original;
            out.push({
                id: n.id,
                ...(original.resolved ? { resolved: original.resolved } : {}),
                ...(n.url === undefined ? {} : { url: n.url }),
                ...(n.root ? { root: true } : {}),
                ...(n.name ? { name: n.name } : {}),
                ...(n.origin ? { origin: n.origin } : {}),
                ...(n.file ? { file: n.file } : {}),
                ...(n.subformat ? { subformat: n.subformat } : {}),
                ...(n.library ? { library: n.library } : {}),
                ...(n.format ? { format: n.format } : {}),
                ...(n.title ? { title: n.title } : {}),
                ...(parent == null ? {} : { parent }),
                depth,
            });
            walk(n.children, n.id, depth + 1);
        }
    };
    walk(tree, undefined, 0);
    return out;
};

const clone = (tree: readonly DocNode[]): DocNode[] =>
    tree.map((n) => ({ ...n, children: clone(n.children) }));

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
const childList = (tree: DocNode[], parent: string | undefined): DocNode[] | undefined => {
    const node = parent == null ? (tree[0]?.root ? tree[0] : undefined) : findNode(tree, parent);
    return node?.resolved ? undefined : node ? node.children : parent == null ? tree : undefined;
};

/** Append a new doc to the end of parent's children. Duplicate id / missing parent → undefined. */
export const insertDoc = (
    tree: readonly DocNode[],
    id: string,
    parent?: string,
    page: Pick<DocNode, "subformat" | "library" | "format" | "title"> = {},
): DocNode[] | undefined => {
    const next = clone(tree);
    const list = childList(next, parent);
    if (!list || findNode(next, id)) {
        return undefined;
    }
    list.push({ id, ...page, children: [] });
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
    if (
        !node ||
        node.root ||
        (parent != null && (parent === id || findNode(node.children, parent)))
    ) {
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
    if (!node || node.root || node.children.length > 0) {
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
