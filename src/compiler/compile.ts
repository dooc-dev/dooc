// Reads dooc.yaml and source files into validated, in-memory content for the viewer and HTML
// bundles. createCompiler caches unchanged files; compileSite performs a one-shot compilation.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Block, type ListItem, type TocEntry, walkBlocks } from "../core/blocks.js";
import { docIdOfFile, flattenTree, MANIFEST_FILE } from "../core/content-metadata.js";
import type { CompiledDoc, FigureEntry, TermEntry } from "../core/content-types.js";
import { termMap } from "../core/inline.js";
import { DEFAULT_LANG, isLangTag } from "../core/language.js";
import { contentLinks, parseMdast } from "../core/markdown.js";
import {
    defaultPreviewSettings,
    type PreviewSettings,
    parsePreviewSettings,
} from "../core/previewers.js";
import { type DocRef, parseDocLink } from "../core/routing.js";
import type { Frontmatter } from "../core/taxonomy.js";
import { isTermFile } from "../core/term-reference.js";
import { isRemoteTextfile } from "../core/textfile.js";
import { parseContentSource } from "./code-blocks.js";
import { collectRefs, type ParsedDoc, parseDoc } from "./dialect.js";
import { figureName, loadFigures } from "./figures.js";
import { createFileCache, createSigCache, dirSig, fileSig } from "./file-cache.js";
import { projectFiles } from "./files.js";
import { toBlocks } from "./from-mdast.js";
import { loadIcons, squareSvg } from "./icons.js";
import { assertNotIgnored, ignoredFiles } from "./ignored-files.js";
import { contentLanguageCode, isContentLanguage } from "./language-codes.js";
import { siteContentLanguages, translationFile } from "./locales.js";
import { parseManifestText } from "./manifest.js";
import { loadSubformat, parseSubformatRecord, validateSubformatRecord } from "./subformats.js";
import { parseTermSource } from "./terms.js";
import { readTextfile, selectTextfileRange } from "./textfile.js";
import { TextfileUnavailable } from "./textfile-remote.js";
import { siteThemes, themeVariants } from "./theme-variants.js";

export type {
    CompiledDoc,
    FigureEntry,
} from "../core/content-types.js";

/** Authored links, including callout bodies; code examples do not create references. */
export const collectDocLinks = (body: string): string[] =>
    contentLinks(parseMdast(body))
        .map((node) => node.url)
        .filter((url) => {
            try {
                return parseDocLink(url) !== undefined;
            } catch {
                return false;
            }
        });

/** Source text and diagnostics for editing. key = CompiledDoc.file. */
export interface DocSource {
    terms: TermEntry[];
    /** Files already discovered during parsing, used by the viewer's change watcher. */
    referencedFiles: string[];
    /**
     * Raw text on disk (including front-matter). The editor's initial value and the base for
     * detecting external changes.
     */
    raw: string;
    /** Validated front-matter; undefined if broken (CompiledDoc then uses the id as title). */
    frontmatter: Frontmatter | undefined;
    /**
     * For the editor's source-mapping display: each block's start line, relative to the body
     * (same index as CompiledDoc.blocks).
     */
    lines: number[];
    /**
     * This doc's validation errors (dialect + resolution of figures/document links).
     * No file prefix.
     */
    errors: string[];
}

export interface Compiled {
    subformats?: import("../core/subformats.js").Subformat[];
    previews: PreviewSettings;
    title?: string;
    icon?: string;
    /** Theme name → site icon from themes/<theme>/<icon file>. */
    iconVariants?: Record<string, string>;
    /** Display order follows dooc.yaml. Invalid sources retain their diagnostics for editing. */
    docs: CompiledDoc[];
    terms: TermEntry[];
    figures: FigureEntry[];
    sources: Map<string, DocSource>;
    /** Errors not tied to a doc (layout convention / manifest / figures / terms). */
    siteErrors: string[];
    /** All errors (siteErrors + each doc's errors with a file prefix). */
    errors: string[];
    /** Site default language (docs without front-matter `lang` resolve to it). */
    defaultLang: string;
    contentLanguages?: string[];
    themes?: ("light" | "dark")[];
}

export interface CompileOptions {
    /** Network permissions supplied by the host application, never by document metadata. */
    previews?: PreviewSettings;
    /** Selected content language; translations mirror source paths under locales/<locale>/. */
    locale?: string;
    /** Override dooc.yaml's defaultLang for programmatic compilation. */
    defaultLang?: string;
}

export interface Compiler {
    /**
     * Compiles the whole docs root (content/ figures/). Unchanged files hit the
     * cache.
     */
    compile(): Compiled;
}

/** Site context needed to check a draft's references (document file targets / figures). */
export interface DraftContext {
    previews?: PreviewSettings;
    /** Docs root used to resolve embedded file paths. */
    root?: string;
    /** Unsaved local file contents, used only for draft previews. */
    textfiles?: ReadonlyMap<string, string>;
    /** file = CompiledDoc.file (`content/<id>.md`); used to look up a draft's id / parent. */
    docs: readonly (DocRef & { file: string; toc?: readonly TocEntry[] })[];
    /** name → figure (file = `figures/<file>`). */
    figures: { get(name: string): { file: string } | undefined };
    /** Site default language for a draft without front-matter `lang`. Default: DEFAULT_LANG. */
    defaultLang?: string;
}

interface ParsedFile {
    raw: string;
    referencedFiles: string[];
    parsed: ParsedDoc;
    blocks: Block[];
    toc: TocEntry[];
    lines: number[];
    refs: CompiledDoc["refs"];
    docLinks: string[];
    /** Visual assets referenced by Markdown links and embeds, relative to the docs root. */
    figureFiles: string[];
}

// Maps mdast line numbers (1-indexed in raw, which includes front-matter) to the body-relative
// lines the editor shows. body is a suffix of raw (parseDoc only strips the front-matter), so
// subtract the number of newlines before it.
const toBodyLines = (raw: string, body: string, lines: number[]): number[] => {
    const before = raw.slice(0, raw.length - body.length).split("\n").length - 1;
    return lines.map((l) => Math.max(1, l - before));
};

const parseFile = (raw: string, previews?: PreviewSettings, file?: string): ParsedFile => {
    const parsed = parseDoc(raw, previews, file);
    const { blocks, toc, lines } = toBlocks(parsed.root, parsed.source, previews, file);
    const refs = collectRefs(parsed.root, previews);
    const figureFiles = refs.figures;
    return {
        raw,
        referencedFiles: [...refs.textfiles, ...refs.figures, ...refs.terms],
        parsed,
        blocks,
        toc,
        lines: toBodyLines(raw, parsed.body, lines),
        refs: { figures: figureFiles.map(figureName), terms: refs.terms },
        figureFiles,
        docLinks: collectDocLinks(parsed.body),
    };
};

const resolveFiles = (
    f: ParsedFile,
    root?: string,
    textfiles?: ReadonlyMap<string, string>,
    previews?: PreviewSettings,
    themes?: string[],
): ParsedFile => {
    if (
        !f.refs.terms.length &&
        !walkBlocks(f.blocks).some(
            (b) => b.type === "figureRef" || (b.type === "code" && b.filename),
        )
    )
        return f;
    const errors = [...f.parsed.errors];
    const terms = [...f.parsed.terms];
    const termFiles = new Set(f.refs.terms);
    const figureFiles = new Set(f.figureFiles);
    const docLinks = [...f.docLinks];
    const resolveItem = (item: ListItem): ListItem =>
        typeof item === "string"
            ? item
            : "blocks" in item
              ? { blocks: item.blocks.map(resolveBlock) }
              : { ...item, children: item.children.map(resolveItem) };
    const resolveBlock = (b: Block): Block => {
        const file =
            b.type === "code"
                ? b.filename?.replace(/^(\.\/)+/, "")
                : b.type === "figureRef"
                  ? f.figureFiles.find((file) => figureName(file) === b.name)
                  : undefined;
        let variants: Record<string, string> = {};
        try {
            if (file && root) variants = themeVariants(root, file, themes);
        } catch (error) {
            errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
        const base = resolveContent(b);
        if (!Object.keys(variants).length) return base;
        return {
            type: "themeVariants",
            default: base,
            variants: Object.fromEntries(
                Object.entries(variants).map(([theme, path]) => {
                    if (b.type === "figureRef") {
                        figureFiles.add(path);
                        return [theme, { ...b, name: figureName(path) }];
                    }
                    return [theme, resolveContent({ ...b, filename: path } as Block)];
                }),
            ),
        };
    };
    const resolveContent = (b: Block): Block => {
        if (b.type === "quote") return { ...b, blocks: b.blocks.map(resolveBlock) };
        if (b.type === "list") return { ...b, items: b.items.map(resolveItem) };
        if (b.type !== "code" || !b.filename) return b;
        try {
            if (!root) throw new Error("docs root is required to read text files");
            const source = selectTextfileRange(
                textfiles?.get(b.filename.replace(/^(\.\/)+/, "")) ??
                    readTextfile(root, b.filename, false, previews?.domains),
                b.range,
            );
            const parsed =
                b.range === undefined && !isRemoteTextfile(b.filename)
                    ? parseContentSource(b.lang ?? "", source, b.filename.replace(/^(\.\/)+/, ""))
                    : undefined;
            if (parsed) {
                if (b.lang === "callouth") {
                    docLinks.push(...collectDocLinks(source));
                    const refs = collectRefs(parseMdast(source));
                    for (const file of refs.terms) termFiles.add(file);
                    for (const file of refs.figures) figureFiles.add(file);
                }
                errors.push(
                    ...parsed.errors.map(
                        (error) => `${b.filename}: L${error.line + 1}: ${error.message}`,
                    ),
                );
                for (const block of parsed.blocks)
                    if (block.type === "term") terms.push(block.entry);
                if (parsed.blocks[0]) {
                    const block = { ...parsed.blocks[0], ...(b.alt ? { alt: b.alt } : {}) };
                    return block.type === "table" && b.tableMode
                        ? { ...block, tableMode: b.tableMode }
                        : block;
                }
            }
            return {
                ...b,
                lines: source.split("\n"),
            };
        } catch (error) {
            if (
                error instanceof TextfileUnavailable ||
                (error as NodeJS.ErrnoException).code === "ENOENT"
            )
                return {
                    ...b,
                    unavailable: error instanceof TextfileUnavailable ? error.reason : "missing",
                };
            errors.push(
                `${b.filename}${b.range ?? ""}: ${error instanceof Error ? error.message : error}`,
            );
            return b;
        }
    };
    const blocks = f.blocks.map(resolveBlock);
    for (const file of termFiles) {
        try {
            if (!root) throw new Error("docs root is required to read term files");
            const parsed = parseTermSource(file, textfiles?.get(file) ?? readTextfile(root, file));
            terms.push(...parsed.entries);
            errors.push(
                ...parsed.errors.map((error) => `${file}: L${error.line + 1}: ${error.message}`),
            );
        } catch (error) {
            errors.push(`${file}: ${error instanceof Error ? error.message : error}`);
        }
    }
    return {
        ...f,
        blocks,
        docLinks,
        figureFiles: [...figureFiles],
        refs: {
            ...f.refs,
            figures: [...figureFiles].map(figureName),
            terms: [
                ...new Set([
                    ...termFiles,
                    ...terms.filter((term) => isTermFile(term.id)).map((term) => term.id),
                ]),
            ],
        },
        parsed: { ...f.parsed, errors, terms },
    };
};

const toDoc = (
    id: string,
    parent: string | undefined,
    file: string,
    f: ParsedFile,
    defaultLang: string,
): CompiledDoc => ({
    id,
    ...(parent == null ? {} : { parent }),
    file,
    // Keep the doc even if its front-matter is broken (so it can be opened and fixed in the
    // viewer). In that case parsed.errors is set, so it won't be distributed.
    ...(f.parsed.frontmatter ?? ({ title: id } as Frontmatter)),
    lang: f.parsed.frontmatter?.lang ?? defaultLang,
    body: f.parsed.body,
    blocks: f.blocks,
    toc: f.toc,
    refs: f.refs,
});

// Validate the dialect and resolution of visual assets, terms and document links.
const docErrors = (f: ParsedFile, { docs, figures }: DraftContext): string[] => {
    const errors = [...f.parsed.errors];
    for (const file of f.figureFiles) {
        if (figures.get(figureName(file))?.file !== file) {
            errors.push(`"${file.replace(/^figures\//, "")}" is not in figures/`);
        }
    }
    for (const url of f.docLinks) {
        const ref = parseDocLink(url);
        const target = ref && docs.find((doc) => doc.file === ref.file);
        if (ref && !target)
            errors.push(`Document link "${url}" is unresolved (check the file path)`);
        else if (
            ref?.fragment &&
            target?.toc &&
            !target.toc.some((heading) => heading.slug === ref.fragment)
        )
            errors.push(`Document link "${url}" refers to a missing heading`);
    }
    return errors;
};

import { docFile } from "../core/files.js";
import { textfilePath } from "./textfile.js";

export const createCompiler = (root: string, options: CompileOptions = {}): Compiler => {
    if (options.locale && !isContentLanguage(options.locale))
        throw new Error("Expected an ISO 639-3 language code");
    const contentDir = join(root, "content");
    const figuresDir = join(root, "figures");
    let docCache = createFileCache<ParsedFile>();
    let previewKey = "";
    const manifestCache = createFileCache<ReturnType<typeof parseManifestText>>();
    const figuresCache = createSigCache<ReturnType<typeof loadFigures>>();

    const compile = (): Compiled => {
        const manifestPath = join(root, MANIFEST_FILE);
        const manifest = existsSync(manifestPath)
            ? manifestCache.get(manifestPath, parseManifestText)
            : { tree: [], errors: [`${MANIFEST_FILE} is required`] };
        const defaultLang = options.defaultLang ?? manifest.defaultLang ?? DEFAULT_LANG;
        if (
            options.locale &&
            manifest.languages &&
            !siteContentLanguages(root, manifest).includes(options.locale)
        )
            throw new Error(`Language ${options.locale} is not declared in dooc.yaml languages`);
        const themes = siteThemes(root, manifest);
        const paths = projectFiles(root);
        const visualFiles = paths
            .map((file) => file.path)
            .filter((file) => /\.(svg|html|png|webp|gif|mp4|webm|jpe?g)$/.test(file));
        const { figures, errors: figErrors } = figuresCache.get(
            dirSig(figuresDir) +
                visualFiles.map((file) => `${file}:${fileSig(textfilePath(root, file))}`).join("|"),
            () => loadFigures(figuresDir, visualFiles),
        );
        const siteErrors: string[] = figErrors.filter((error) => error.startsWith("figures/"));
        if (!isLangTag(defaultLang)) {
            siteErrors.push("defaultLang must be a BCP 47 language tag");
        }
        const previews = parsePreviewSettings(options.previews ?? defaultPreviewSettings());
        let title: string | undefined;
        let icon: string | undefined;
        let iconVariants: Record<string, string> | undefined;
        let iconFile: string | undefined;
        const files: { doc: CompiledDoc; parsed: ParsedFile }[] = [];
        if (
            !existsSync(contentDir) &&
            !manifest.files &&
            !flattenTree(manifest.tree).some((node) => node.subformat)
        ) {
            siteErrors.push(`${contentDir}: content/ is missing`);
        } else {
            const {
                tree,
                title: manifestTitle,
                icon: manifestIcon,
                errors: manifestErrors,
            } = manifest;
            const nextPreviewKey = JSON.stringify(previews);
            if (nextPreviewKey !== previewKey) {
                docCache = createFileCache<ParsedFile>();
                previewKey = nextPreviewKey;
            }
            title =
                manifest.titles?.[options.locale ?? contentLanguageCode(defaultLang)] ??
                manifestTitle;
            iconFile = manifestIcon;
            if (iconFile) {
                try {
                    icon = squareSvg(readTextfile(root, iconFile));
                    if (!icon)
                        throw new Error("expected an SVG with a viewBox or width and height");
                    const variants = Object.entries(
                        manifest.themeIcons ?? themeVariants(root, iconFile, themes),
                    );
                    if (variants.length)
                        iconVariants = Object.fromEntries(
                            variants.map(([theme, file]) => {
                                const svg = squareSvg(readTextfile(root, file));
                                if (!svg)
                                    throw new Error(
                                        `${file}: expected an SVG with a viewBox or width and height`,
                                    );
                                return [theme, svg];
                            }),
                        );
                } catch (error) {
                    siteErrors.push(
                        `${MANIFEST_FILE}: icon ${iconFile}: ${error instanceof Error ? error.message : error}`,
                    );
                }
            }
            siteErrors.push(...manifestErrors);
            // Directly under content/: flat <id>.md files only (no folders).
            const onDisk = new Set<string>();
            const contentEntries = existsSync(contentDir)
                ? readdirSync(contentDir, { withFileTypes: true })
                : [];
            const ignoredContent = ignoredFiles(
                root,
                contentEntries.map((entry) => `content/${entry.name}`),
            );
            for (const entry of contentEntries) {
                if (ignoredContent.has(`content/${entry.name}`)) continue;
                if (entry.name.startsWith(".")) {
                    continue;
                }
                const id = entry.isFile() ? docIdOfFile(entry.name) : undefined;
                if (id == null) {
                    if (manifest.files) continue;
                    siteErrors.push(
                        `content/${entry.name}: only <id>.md (lowercase alphanumerics and hyphens) are allowed directly under content/`,
                    );
                    continue;
                }
                onDisk.add(id);
            }
            // Manifest pre-order is the display order.
            for (const { id, parent, subformat } of flattenTree(tree)) {
                if (subformat) continue;
                const rel = docFile(id, manifest.files);
                if (rel.startsWith("content/")) {
                    const diskId = docIdOfFile(rel.slice("content/".length));
                    if (diskId) onDisk.delete(diskId);
                }
                let path: string;
                try {
                    path = textfilePath(root, rel);
                    assertNotIgnored(root, rel);
                } catch (error) {
                    siteErrors.push(`${rel}: ${error}`);
                    continue;
                }
                if (!existsSync(path)) {
                    siteErrors.push(`${rel}: listed in ${MANIFEST_FILE} but the file is missing`);
                    continue;
                }
                let parsed = docCache.get(path, (raw) => parseFile(raw, previews, rel));
                let language = defaultLang;
                if (options.locale && options.locale !== contentLanguageCode(defaultLang)) {
                    const file = translationFile(rel, options.locale);
                    try {
                        const translated = textfilePath(root, file);
                        if (existsSync(translated)) {
                            assertNotIgnored(root, file);
                            parsed = docCache.get(translated, (raw) =>
                                parseFile(raw, previews, rel),
                            );
                            language = options.locale;
                        }
                    } catch (error) {
                        siteErrors.push(`${file}: ${error}`);
                    }
                }
                parsed = resolveFiles(parsed, root, undefined, previews, themes);
                files.push({ doc: toDoc(id, parent, rel, parsed, language), parsed });
            }
            for (const id of onDisk) {
                siteErrors.push(`content/${id}.md: not registered in ${MANIFEST_FILE}`);
            }
        }

        for (const file of new Set(files.flatMap(({ parsed }) => parsed.figureFiles)))
            if (!file.startsWith("figures/"))
                siteErrors.push(...figErrors.filter((error) => error.startsWith(`${file}:`)));

        // Icons are small, so read them every time (no cache).
        const { icons, errors: iconErrors } = loadIcons(
            root,
            new Set(files.map((f) => f.doc.id)),
            iconFile,
            manifest.files,
            Object.values(manifest.themeIcons ?? {}),
        );
        siteErrors.push(...iconErrors);
        for (const { doc } of files) {
            const icon = icons.get(doc.id);
            if (icon != null) {
                doc.icon = icon;
            }
        }
        const docs = files.map((f) => f.doc);

        const ctx: DraftContext = {
            docs,
            figures: new Map(figures.map((f) => [f.name, f])),
            defaultLang,
        };
        const sources = new Map<string, DocSource>();
        const errors = [...siteErrors];
        for (const { doc, parsed } of files) {
            const errs = docErrors(parsed, ctx);
            errors.push(...errs.map((e) => `${doc.file}: ${e}`));
            sources.set(doc.file, {
                terms: parsed.parsed.terms,
                referencedFiles: parsed.referencedFiles,
                raw: parsed.raw,
                frontmatter: parsed.parsed.frontmatter,
                lines: parsed.lines,
                errors: errs,
            });
        }
        for (const node of flattenTree(manifest.tree).filter((node) => node.subformat)) {
            const config = manifest.subformats?.find((format) => format.ext === node.subformat);
            if (!config) continue;
            const file = `subformat:${config.ext}`;
            const title = node.title ?? config.ext;
            const pageErrors: string[] = [];
            const collection: NonNullable<CompiledDoc["subformat"]> = {
                ...config,
                fields: [],
                records: [],
            };
            try {
                assertNotIgnored(root, config.schema);
                if (!paths.some((file) => file.path === config.schema))
                    throw new Error("Subformat schema is not available in the workspace");
                const loaded = loadSubformat(root, config);
                collection.fields = loaded.fields;
                collection.template = loaded.template;
                collection.defaultFolder = manifest.defaultSubformatFolder;
                for (const record of paths.filter(
                    (file) => file.extension === config.ext && file.path !== config.schema,
                )) {
                    try {
                        const content = readTextfile(root, record.path);
                        const data = parseSubformatRecord(content, config.format);
                        validateSubformatRecord(loaded, data);
                        collection.records.push({ file: record.path, content, data });
                    } catch (error) {
                        pageErrors.push(
                            `${record.path}: ${error instanceof Error ? error.message : error}`,
                        );
                    }
                }
            } catch (error) {
                pageErrors.push(
                    `${config.schema}: ${error instanceof Error ? error.message : error}`,
                );
            }
            docs.push({
                id: node.id,
                parent: node.parent,
                title,
                file,
                lang: defaultLang,
                subformat: collection,
                body: "",
                blocks: [],
                toc: [],
                refs: { figures: [], terms: [] },
            });
            sources.set(file, {
                terms: [],
                referencedFiles: [],
                raw: "",
                frontmatter: { title },
                lines: [],
                errors: pageErrors,
            });
            errors.push(...pageErrors);
        }
        const order = flattenTree(manifest.tree).map((node) => node.id);
        docs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        if (!docs.length) {
            siteErrors.push(`${contentDir}: no docs`);
            errors.push(`${contentDir}: no docs`);
        }
        return {
            previews,
            subformats: manifest.subformats,
            ...(manifest.languages ? { contentLanguages: manifest.languages } : {}),
            ...(manifest.themes ? { themes: manifest.themes } : {}),
            ...(title === undefined ? {} : { title }),
            ...(icon === undefined ? {} : { icon }),
            ...(iconVariants === undefined ? {} : { iconVariants }),
            docs,
            terms: [...termMap(files.flatMap(({ parsed }) => parsed.parsed.terms)).values()],
            figures,
            sources,
            siteErrors,
            errors,
            defaultLang,
        };
    };

    return { compile };
};

/**
 * Compiles a single unsaved draft (file = `content/<id>.md`) in the site's context.
 * Not cached, since it changes on every keystroke. id / parent are looked up from the ctx.docs
 * entry with the same file ("" for a new doc).
 */
export const compileDraft = (
    ctx: DraftContext,
    file: string,
    raw: string,
): { doc: CompiledDoc; source: DocSource } => {
    const known = ctx.docs.find((d) => d.file === file);
    const previews = ctx.previews;
    const parsed = resolveFiles(parseFile(raw, previews, file), ctx.root, ctx.textfiles, previews);
    return {
        doc: toDoc(known?.id ?? "", known?.parent, file, parsed, ctx.defaultLang ?? DEFAULT_LANG),
        source: {
            terms: parsed.parsed.terms,
            referencedFiles: parsed.referencedFiles,
            raw,
            frontmatter: parsed.parsed.frontmatter,
            lines: parsed.lines,
            errors: docErrors(parsed, ctx),
        },
    };
};

/** One-shot compile (for the build CLI / tests). */
export const compileSite = (root: string, options: CompileOptions = {}): Compiled =>
    createCompiler(root, options).compile();
