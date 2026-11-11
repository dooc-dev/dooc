import { completeFilePaths, filesSnapshot, updateFiles, uploadFile } from "../compiler/files.js";
import { loadProjectFonts, type ProjectFont } from "../compiler/fonts.js";
import { textfilePath, writeTextfile } from "../compiler/textfile.js";
import {
    defaultFilePath,
    docIconFile,
    MAX_FILE_UPLOAD_BYTES,
    parseFileLayout,
    docFile as sourceDocFile,
    suggestDocFileName,
} from "../core/files.js";
// The local server itself (shared by preview / edit). Files are re-read on every request, so a
// change is always reflected on the next request. HMR (hmr.ts) triggers that "next request"
// automatically: content changes are pushed over SSE and preview swaps just the main body, while
// src/*.ts changes cause a tsx watch restart → reconnect → reload (= no manual reload or restart
// needed). Rendering goes through the same "mdast → Block AST → HTML" pipeline as the build.
// Dialect validation errors are shown at the top of the page.
//   preview = read-only view
//   edit    = left = live render of the body / right = front-matter form + insert palette +
//             CodeMirror (`dooc edit`). The save API rewrites content/<id>.md directly,
//             and hierarchy changes (create / move / rename / delete) rewrite
//             dooc.yaml.
//             The client (src/viewer/edit-client.ts) is bundled in memory with esbuild on
//             first request (cached) and served.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageRegistration } from "shiki/core";
import { parseContentSource } from "../compiler/code-blocks.js";
import {
    type Compiled,
    compileDraft,
    createCompiler,
    type DocSource,
    type DraftContext,
} from "../compiler/compile.js";
import { figureName } from "../compiler/figures.js";
import { ICONS_DIR, squareSvg } from "../compiler/icons.js";
import { ignoredFiles, withIgnoredFilesCache } from "../compiler/ignored-files.js";
import {
    contentLanguageCode,
    contentLanguages,
    isContentLanguage,
    webLanguage,
} from "../compiler/language-codes.js";
import {
    setDocTranslation,
    siteContentLanguages,
    translationFile,
    translationFiles,
} from "../compiler/locales.js";
import { readManifest, writeManifest } from "../compiler/manifest.js";
import { assembleDoc, createDocOps, isOpError, type OpResult } from "../compiler/ops.js";
import { subformatResponse, validateSubformatFile } from "../compiler/subformats.js";
import { type Block, type TocEntry, walkBlocks } from "../core/blocks.js";
import { selectCodeGrammars, subformatCodeGrammars } from "../core/code-grammars.js";
import { docIdOfFile, flattenTree } from "../core/content-metadata.js";
import type { CompiledDoc, FigureEntry, TermEntry } from "../core/content-types.js";
import { MAX_EXTENSION_BYTES } from "../core/extension-package.js";
import { figureFrameHtml, mountFigureFrames } from "../core/figure-frame.js";
import { blocksHtml, docHtml, escapeHtml, type RenderCtx, termsHtml } from "../core/html.js";
import { FOLDER_ICON_PATH, PLUGINS_ICON } from "../core/icons.js";
import {
    DEFAULT_LANG,
    isLangTag,
    type LanguageAdapter,
    resolveLanguage,
} from "../core/language.js";
import {
    defaultPreviewSettings,
    type PreviewSettings,
    parsePreviewSettings,
} from "../core/previewers.js";
import { ancestorsOf, childrenOf, docPath, resolveDocPath } from "../core/routing.js";
import { mountTables } from "../core/table-ui.js";
import { CODE_LANGS, docDisplayName, type Frontmatter } from "../core/taxonomy.js";
import { isTermFile, termAnchor, termFileUrl } from "../core/term-reference.js";
import { mountTerms } from "../core/terms-ui.js";
import { isRemoteTextfile, textfileName } from "../core/textfile.js";
import { mountThemeVariants } from "../core/theme-variants.js";
import { mountToc } from "../core/toc-ui.js";
import { mountVideos } from "../core/video-ui.js";
import { parseWorkspaceSource, type WorkspaceSource, workspaceLabel } from "../core/workspace.js";
import { createLocalPluginStorage } from "../plugins/local-storage.js";
import { readViewerAsset, prebuilt as usePrebuiltAssets } from "./assets.js";
import { mountBundleNetwork } from "./bundle-network.js";
import { codeFileResponse } from "./code-file.js";
import {
    isLocalToolRequest,
    runCodeTool,
    validateCodeTools,
    validateTextfileCode,
} from "./editor-tools.js";
import { createExtensionManager, EXTENSIONS_DIR } from "./extensions.js";
import { deferredFigureHtml, mountFigurePreviews } from "./figure-preview.js";
import { type FilePreviewResults, fileReferences } from "./file-references.js";
import { mountFontPickers } from "./font-picker.js";
import { createFontSettings } from "./font-settings.js";
import { fontCss, readFont } from "./fonts.js";
import { createGitHandler, validateGitOrigin } from "./git.js";
import { gitBaseBody, gitBaseText, setSubformatChanges } from "./git-diff.js";
import { createHmrHub, HMR_PATH, hmrClientScript, watchProject } from "./hmr.js";
import { translate } from "./i18n.js";
import { DEFAULT_SITE_LANGUAGES, loadSiteLanguages, type SiteLanguages } from "./languages.js";
import { loadPreviewScript } from "./lazy-preview.js";
import { focusNavTree } from "./nav-focus.js";
import { updateNav } from "./nav-update.js";
import { loadViewerPlugins, type ViewerRuntime } from "./plugin-config.js";
import { PLUGIN_BLOCK_CSS } from "./plugin-style.js";
import { createPluginHandler } from "./plugins.js";
import { mountPanelResize } from "./resize.js";
import { resourceIndex, resourceLibraryHtml, resourceTabs } from "./resource-library.js";
import { mountSearch, SEARCH_LABELS, searchIndex, searchSections } from "./search.js";
import { siteIconResponse } from "./site-icon.js";
import { siteTitleResponse } from "./site-title.js";
import { previewTextfiles, textfileResponse } from "./textfile.js";
import { initializeThemes, mountThemePickers } from "./theme-picker.js";
import { readWorkspaceSource, sourceFileBase } from "./workspace.js";

export type ServeMode = "preview" | "edit";

// pkgRoot = the viewer itself (src/ for the client bundles). docsRoot = the docs folder that
// follows the layout convention (content/ figures/).
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const root = resolve(process.env.DOCS_ROOT ?? process.cwd());

/**
 * One doc in the viewer = a view model combining the compiler's CompiledDoc (rendering) and
 * DocSource (extra info for editing).
 * file is `<id>.md` (= same shape as the save API's file parameter; CompiledDoc.file minus the
 * content/ prefix).
 */
export interface Entry {
    id: string;
    subformat?: CompiledDoc["subformat"];
    translatedLanguages?: string[];
    /** Parent doc id (omitted = top level). */
    parent?: string;
    file: string;
    sourceFile?: string;
    iconFile?: string;
    frontmatter: Frontmatter | undefined;
    /** Resolved language (front-matter `lang`, else the site default). */
    lang: string;
    /** Source md without the front-matter (the editor's initial value). */
    body: string;
    blocks: Block[];
    toc: TocEntry[];
    /**
     * For the editor's correspondence display: body-relative start line of each block (same
     * index as blocks).
     */
    blockLines: number[];
    /**
     * Full source on disk (including front-matter). Used as the base for the editor's
     * external-change detection.
     */
    raw: string;
    /** Validation errors for this doc (the compiler's DocSource.errors). */
    errors: string[];
    /** Icon for the sidebar (full svg, 1:1). */
    icon?: string;
    /** Names of the figures the body references (Resources' "used in"). */
    figureRefs?: string[];
    termRefs?: string[];
    terms?: TermEntry[];
    referencedFiles?: string[];
}

export interface Site {
    sourceBase?: string;
    subformats?: Compiled["subformats"];
    fonts?: readonly ProjectFont[];
    workspace?: WorkspaceSource;
    filePaths?: readonly string[];
    previews?: PreviewSettings;
    title?: string;
    icon?: string;
    iconVariants?: Record<string, string>;
    codeLanguages?: string[];
    codeGrammars?: LanguageRegistration[];
    contentLanguage?: string;
    /** Display order (pre-order traversal of the manifest). */
    entries: Entry[];
    ctx: RenderCtx;
    /** Errors not tied to a doc (the compiler's siteErrors). Shown on every page. */
    errors: string[];
    /** Language adapters (docs.config.mjs + built-ins); each doc renders with its own. */
    languages: readonly LanguageAdapter[];
    /** Site default language. */
    defaultLang: string;
    /** Declared site languages, when the manifest restricts the language picker. */
    contentLanguages?: readonly string[];
    themes?: readonly ("light" | "dark")[];
}

const CONTENT_PREFIX = "content/";

const toEntry = (doc: CompiledDoc, source: DocSource): Entry => ({
    id: doc.id,
    ...(doc.subformat ? { subformat: doc.subformat } : {}),
    ...(doc.parent == null ? {} : { parent: doc.parent }),
    file: `${doc.id}.md`,
    sourceFile: doc.file,
    frontmatter: source.frontmatter,
    lang: doc.lang,
    body: doc.body,
    blocks: doc.blocks,
    toc: doc.toc,
    blockLines: source.lines,
    raw: source.raw,
    errors: source.errors,
    ...(doc.icon == null ? {} : { icon: doc.icon }),
    figureRefs: doc.refs.figures,
    termRefs: doc.refs.terms,
    terms: source.terms,
    referencedFiles: source.referencedFiles,
});

// Recompile source files on every request. The compiler's cache
// skips re-parsing files unchanged on disk, so it stays cheap even when called on every keystroke
// (POST /api/render). Replaced in startServer once docs.config.mjs (language adapters)
// has been loaded.
let siteLanguages = DEFAULT_SITE_LANGUAGES;
let compiler = createCompiler(root);
const ops = createDocOps(root);

/** Compile result → viewer Site (shared by the server's per-request path and one-off publish). */
export const siteFrom = (
    {
        title,
        icon,
        iconVariants,
        docs,
        terms,
        figures,
        sources,
        siteErrors,
        defaultLang,
        previews,
        contentLanguages,
        themes,
        subformats,
    }: Compiled,
    languages: readonly LanguageAdapter[] = DEFAULT_SITE_LANGUAGES.languages,
    code: Pick<SiteLanguages, "codeLanguages" | "codeGrammars"> = {},
): Site => {
    return {
        previews,
        subformats,
        codeLanguages: [
            ...new Set([
                ...(code.codeLanguages ?? CODE_LANGS),
                ...(subformats ?? []).map(({ ext }) => `.${ext}`),
            ]),
        ],
        codeGrammars: subformatCodeGrammars(code.codeGrammars ?? [], subformats),
        ...(contentLanguages ? { contentLanguages } : {}),
        ...(themes ? { themes } : {}),
        ...(title === undefined ? {} : { title }),
        ...(icon === undefined ? {} : { icon }),
        ...(iconVariants === undefined ? {} : { iconVariants }),
        entries: docs.flatMap((doc) => {
            const source = sources.get(doc.file);
            return source ? [toEntry(doc, source)] : [];
        }),
        ctx: {
            docLinks: new Map(docs.map((doc) => [doc.file, docPath(docs, doc.id)])),
            figures: new Map(figures.map((f) => [f.name, f])),
            terms,
            termLinks: new Map([
                ...terms.map(
                    (term) =>
                        [
                            term.id,
                            `/_files/terms#${encodeURIComponent(termAnchor(term.id))}`,
                        ] as const,
                ),
                ...docs.flatMap((doc) =>
                    doc.blocks.flatMap((block) =>
                        block.type === "term"
                            ? [
                                  [
                                      block.entry.id,
                                      `/${doc.id}#${encodeURIComponent(termAnchor(block.entry.id))}`,
                                  ] as const,
                              ]
                            : [],
                    ),
                ),
            ]),
        },
        errors: siteErrors,
        languages,
        defaultLang,
    };
};

const localeCompilers = new Map<string, ReturnType<typeof createCompiler>>();
let workspaceSource: WorkspaceSource | undefined;
let applicationPreviews = defaultPreviewSettings();
let watchTextfiles: ((files: Iterable<string>) => void) | undefined;
const watchEntryTextfiles = (entries: readonly Entry[]): void => {
    watchTextfiles?.(
        entries
            .filter((entry) => !entry.subformat)
            .flatMap((entry) => [
                entry.sourceFile ?? CONTENT_PREFIX + entry.file,
                ...(entry.referencedFiles ?? []),
            ]),
    );
};
const loadSite = (locale?: string): Site =>
    withIgnoredFilesCache(() => {
        const previews = applicationPreviews;
        const manifest = readManifest(root);
        const source = contentLanguageCode(manifest.defaultLang ?? DEFAULT_LANG);
        locale ??= source;
        let selected = compiler;
        if (locale !== source) {
            selected = localeCompilers.get(locale) ?? createCompiler(root, { locale, previews });
            localeCompilers.set(locale, selected);
        }
        const site = siteFrom(selected.compile(), siteLanguages.languages, siteLanguages);
        const sourceLanguage = contentLanguageCode(site.defaultLang);
        for (const entry of site.entries) {
            entry.translatedLanguages = [sourceLanguage];
            entry.iconFile = docIconFile(entry.id, manifest.files);
        }
        try {
            const translated = new Set(translationFiles(root));
            for (const language of siteContentLanguages(root, manifest).filter(
                (language) => language !== sourceLanguage,
            )) {
                for (const entry of site.entries) {
                    if (
                        translated.has(
                            translationFile(sourceDocFile(entry.id, manifest.files), language),
                        )
                    )
                        entry.translatedLanguages?.push(language);
                }
            }
        } catch (error) {
            site.errors.push(String(error));
        }
        watchEntryTextfiles(site.entries);
        watchTextfiles?.(
            [manifest.icon, ...Object.values(manifest.themeIcons ?? {})].filter(
                (file): file is string => !!file,
            ),
        );
        const workspace = workspaceSource ?? readWorkspaceSource(root);
        const subformats = site.entries.flatMap((entry) =>
            entry.subformat ? [entry.subformat] : [],
        );
        if (workspace?.protocol === "git" && subformats.length)
            setSubformatChanges(root, subformats);
        return {
            ...site,
            ctx: { ...site.ctx, figurePreview: deferredFigureHtml },
            fonts: loadProjectFonts(root),
            workspace,
            sourceBase: sourceFileBase(root),
            filePaths: manifest.errors.length
                ? undefined
                : filesSnapshot(root).files.map((file) => file.path),
            contentLanguage: locale,
        };
    });

const draftContext = (site: Site): DraftContext => ({
    previews: site.previews,
    root,
    docs: site.entries
        .filter((e) => !e.subformat)
        .map((e) => ({
            id: e.id,
            ...(e.parent == null ? {} : { parent: e.parent }),
            file: e.sourceFile ?? CONTENT_PREFIX + e.file,
            toc: e.toc,
        })),
    figures: site.ctx.figures,
    defaultLang: site.defaultLang,
});

// fallbackTitle stands in for the h1 when frontmatter is missing. Each doc renders with its own
// language's adapter (term ordering) and `<article lang>`.
const docLinks = (site: Site, html: string): string =>
    html.replace(/href="\/([a-z0-9][a-z0-9-]*)(?=["?#])/g, (whole, id: string) =>
        site.entries.some((entry) => entry.id === id)
            ? `href="${docPath(site.entries, id)}`
            : whole,
    );

const renderEntry = (site: Site, entry: Entry, fallbackTitle: string): string =>
    docLinks(
        site,
        docHtml(
            entry.frontmatter ?? ({ title: fallbackTitle } as Frontmatter),
            entry.blocks,
            [...site.errors, ...entry.errors],
            {
                ...site.ctx,
                terms: entry.terms ?? site.ctx.terms,
                lang: webLanguage(entry.lang),
                tocTitle: translate(entry.lang, "Contents"),
                sectionUrl: `${docPath(site.entries, entry.id)}?lang=${encodeURIComponent(site.contentLanguage ?? entry.lang)}`,
                language: resolveLanguage(entry.lang, site.languages),
            },
            entry.toc,
        ),
    );

/** Compiles one source (unsaved or on disk; file = `<id>.md`) in the site context into an Entry. */
const draftEntry = (
    site: Site,
    file: string,
    raw: string,
    textfiles?: ReadonlyMap<string, string>,
): Entry => {
    const known = site.entries.find((entry) => entry.file === file);
    const { doc, source } = compileDraft(
        { ...draftContext(site), defaultLang: known?.lang ?? site.defaultLang, textfiles },
        known?.sourceFile ?? CONTENT_PREFIX + file,
        raw,
    );
    const entry = toEntry(doc, source);
    watchEntryTextfiles([entry]);
    return entry;
};

export const filePreviewResults = (entry: Entry, site: Site): FilePreviewResults => {
    const results = new Map<string, string[]>();
    const bodyOffset =
        entry.raw.slice(0, entry.raw.length - entry.body.length).split("\n").length - 1;
    for (const { line, file, kind } of fileReferences(entry.body, site.previews)) {
        const errors = results.get(file) ?? [];
        errors.push(...entry.errors.filter((error) => error.startsWith(`L${bodyOffset + line}:`)));
        if (kind === "term") {
            errors.push(...entry.errors.filter((error) => error.startsWith(`${file}:`)));
        } else if (kind === "textfile") {
            errors.push(...entry.errors.filter((error) => error.startsWith(`${file}:`)));
            for (const block of walkBlocks(entry.blocks)) {
                if (block.type !== "code" || block.filename?.replace(/^(\.\/)+/, "") !== file)
                    continue;
                if (block.unavailable)
                    errors.push(
                        block.unavailable === "missing"
                            ? "File not found"
                            : "File could not be loaded",
                    );
                errors.push(
                    ...entry.errors.filter((error) =>
                        error.startsWith(`${block.filename}${block.range ?? ""}:`),
                    ),
                );
            }
        } else {
            if (site.ctx.figures.get(figureName(file))?.file !== file)
                errors.push("File not found");
            errors.push(...site.errors.filter((error) => error.startsWith(`${file}:`)));
        }
        results.set(file, [...new Set(errors)]);
    }
    return Object.fromEntries(results);
};

// Render the raw being edited (unsaved draft) to body html — shared by the save / render APIs.
const entryGitBase = (entry: Entry, site: Site): string | null =>
    site.workspace?.protocol === "git"
        ? gitBaseBody(root, entry.sourceFile ?? CONTENT_PREFIX + entry.file)
        : null;

const renderDraft = (
    site: Site,
    file: string,
    raw: string,
    textfiles?: ReadonlyMap<string, string>,
): {
    gitBase: string | null;
    html: string;
    errors: string[];
    toc: TocEntry[];
    blockLines: number[];
    filePreviews: FilePreviewResults;
    previews?: PreviewSettings;
    sourceFile?: string;
} => {
    const entry = draftEntry(site, file, raw, textfiles);
    return {
        gitBase: entryGitBase(entry, site),
        sourceFile: entry.sourceFile,
        html: renderEntry(site, entry, ""),
        errors: [...site.errors, ...entry.errors],
        toc: entry.toc,
        blockLines: entry.blockLines,
        filePreviews: filePreviewResults(entry, site),
        previews: site.previews,
    };
};

// Render result cache — opening the same doc repeatedly (page GET / nav switch) doesn't re-render.
// The compiler's cache returns the same blocks reference while disk is unchanged, so check that,
// plus that the id list (affects document file link resolution) / terms / figures / errors haven't
// changed. Rebuild if any of them did.
const renderSignature = (site: Site, entry: Entry): string =>
    JSON.stringify([site.ctx.terms, site.errors, entry.errors, entry.frontmatter, entry.lang]) +
    site.entries
        .map((e) => [e.sourceFile ?? CONTENT_PREFIX + e.file, docPath(site.entries, e.id)])
        .sort()
        .join("\n");

const entryHtmlCache = new Map<
    string,
    {
        blocks: Block[];
        sig: string;
        figures: RenderCtx["figures"];
        figurePreview: RenderCtx["figurePreview"];
        value: { html: string; errors: string[] };
    }
>();

/** Renders only the requested doc, not every doc in site.entries. */
export const renderEntryHtml = (site: Site, entry: Entry): { html: string; errors: string[] } => {
    if (entry.subformat)
        return {
            html: `<article class="res-page resource-library subformat-page">${resourceLibraryHtml(
                {
                    codeblocks: [],
                    urls: [],
                    urlPreviews: [],
                    subformats: [entry.subformat],
                    errors: [...site.errors, ...entry.errors],
                },
                "subformats",
                docDisplayName(entry.frontmatter, entry.id),
            )}</article>`,
            errors: [...site.errors, ...entry.errors],
        };
    const sig = renderSignature(site, entry);
    const cached = entryHtmlCache.get(entry.file);
    if (
        cached &&
        cached.blocks === entry.blocks &&
        cached.sig === sig &&
        cached.figures === site.ctx.figures &&
        cached.figurePreview === site.ctx.figurePreview
    ) {
        return cached.value;
    }
    const value = {
        html: renderEntry(site, entry, entry.id),
        errors: [...site.errors, ...entry.errors],
    };
    entryHtmlCache.set(entry.file, {
        blocks: entry.blocks,
        sig,
        figures: site.ctx.figures,
        figurePreview: site.ctx.figurePreview,
        value,
    });
    return value;
};

/** Compiles + renders one source (its current content on disk) (implements `/api/doc`). */
export const renderDocFile = (
    site: Site,
    file: string,
    raw: string,
): {
    gitBase: string | null;
    raw: string;
    frontmatter: Frontmatter | undefined;
    body: string;
    html: string;
    errors: string[];
    toc: TocEntry[];
    blockLines: number[];
    filePreviews: FilePreviewResults;
    previews?: PreviewSettings;
    sourceFile?: string;
} => {
    const entry = draftEntry(site, file, raw);
    return {
        gitBase: entryGitBase(entry, site),
        sourceFile: entry.sourceFile,
        raw,
        frontmatter: entry.frontmatter,
        body: entry.body,
        html: renderEntry(site, entry, ""),
        errors: [...site.errors, ...entry.errors],
        toc: entry.toc,
        blockLines: entry.blockLines,
        filePreviews: filePreviewResults(entry, site),
        previews: site.previews,
    };
};

/** Response for `GET /api/doc?file=<id>.md` (status + body). mode === "edit" only. */
export const docQueryResponse = (site: Site, file: unknown): { status: number; body: unknown } => {
    const target = resolveContentFile(file);
    if (!target) {
        return { status: 400, body: { error: "file must be <id>.md" } };
    }
    if (!existsSync(target.abs)) {
        return { status: 404, body: { error: `${target.name} not found` } };
    }
    return {
        status: 200,
        body: renderDocFile(
            site,
            target.name,
            site.entries.find((entry) => entry.file === target.name)?.raw ??
                readFileSync(target.abs, "utf8"),
        ),
    };
};

export { assembleDoc };

const asString = (v: unknown): string => (typeof v === "string" ? v : "");

/** Client JSON → Frontmatter (keeps supported fields and drops empty optional values). */
export const sanitizeFrontmatter = (v: unknown): Frontmatter => {
    const o = (typeof v === "object" && v != null ? v : {}) as Record<string, unknown>;
    const lang = asString(o.lang).trim();
    return { title: asString(o.title).trim(), ...(lang ? { lang } : {}) };
};

/**
 * Compares the base the editor started from (the disk source the client last read) with the
 * current disk source to tell whether it was rewritten externally (direct edit / git etc.)
 * without the editor knowing.
 * A client that sends no base (no baseRaw) can't be judged, so false (= overwrite).
 */
export const isExternallyModified = (baseRaw: unknown, currentRaw: string): boolean =>
    typeof baseRaw === "string" && baseRaw !== currentRaw;

/**
 * Validates the write target path — rejects anything other than `<id>.md` (directly under
 * content/), including traversal.
 */
export const resolveContentFile = (
    rel: unknown,
): { id: string; name: string; abs: string } | undefined => {
    const id = typeof rel === "string" ? docIdOfFile(rel) : undefined;
    if (flattenTree(readManifest(root).tree).some((node) => node.id === id && node.subformat))
        return undefined;
    const file = id == null ? undefined : sourceDocFile(id, readManifest(root).files);
    return id == null || !file || ignoredFiles(root, [file]).has(file)
        ? undefined
        : {
              id,
              name: `${id}.md`,
              abs: textfilePath(root, file),
          };
};

// Default palette — resolves the figures' var(--doc-*) and color-mix() following the theme. The
// theme has 3 states: default = follow the OS (prefers-color-scheme), explicitly overridden via
// <html data-theme="light|dark">.
// Maps the viewer's --c-* palette onto the body's --doc-* tokens. Unmapped tokens use defaults.
const DARK_C = `
  color-scheme: dark;
  --c-bg0:#101316; --c-bg1:#16191d; --c-surface:#1b1f24; --c-raised:#22272d;
  --c-line:#2a3037; --c-line-soft:#22272c;
  --c-fg:#f5f6f7; --c-fg-muted:#b4bac0; --c-fg-faint:#8a939b; --fw-body:400;
  --c-accent:#e65100; --c-ok:#4f9e6a; --c-danger:#c65b52; --c-warn:#c99a3a; --c-info:#6b8fbf;
  --c-shadow:rgba(0,0,0,.4);
  --doc-fg-4:#525a66; --doc-accent-2:#4a8bff; --doc-accent-fg:#ffffff;
  --doc-ok-2:#56d364; --doc-warn-2:#ffc14d; --doc-danger-2:#ff7a7a; --doc-info-2:#79b0ff;`;
const LIGHT_C = `
  color-scheme: light;
  --c-bg0:#ffffff; --c-bg1:#f5f7f9; --c-surface:#fbfcfd; --c-raised:#e9edf2;
  --c-line:#d5dae0; --c-line-soft:#e4e8ec;
  --c-fg:#1a1e23; --c-fg-muted:#5a636c; --c-fg-faint:#687079; --fw-body:300;
  --c-accent:#c24800; --c-ok:#2f7d4f; --c-danger:#b23c31; --c-warn:#8a6516; --c-info:#3a6ea5;
  --c-shadow:rgba(15,23,32,.14);
  --doc-fg-4:#9099a8; --doc-accent-2:#0277bd; --doc-accent-fg:#ffffff;
  --doc-ok-2:#2ea043; --doc-warn-2:#f59f00; --doc-danger-2:#f04848; --doc-info-2:#4a8bff;`;
const DOC_FROM_C = `
  --doc-bg:var(--c-bg0); --doc-bg-2:var(--c-bg1); --doc-bg-3:var(--c-surface);
  --doc-panel:var(--c-surface); --doc-panel-2:var(--c-raised); --doc-rail:var(--c-bg1);
  --doc-border:var(--c-line-soft); --doc-border-2:var(--c-line);
  --doc-fg:var(--c-fg); --doc-fg-2:var(--c-fg-muted); --doc-fg-3:var(--c-fg-faint);
  --doc-accent:var(--c-accent); --doc-ok:var(--c-ok); --doc-warn:var(--c-warn);
  --doc-danger:var(--c-danger); --doc-info:var(--c-info);`;

// Default for code and editing; browser display settings can override each independently.
const MONO_FONT = `"UDEV Gothic", monospace`;
const SANS_FONT = `"IBM Plex Sans JP", -apple-system, "Segoe UI", "Noto Sans JP", sans-serif`;

// Viewer icons (20x20 stroke glyphs).
const icon = (paths: string, size = 18): string =>
    `<svg class="nav-icon" viewBox="0 0 20 20" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const SIDEBAR_ICON = icon('<rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M8 4v12"/>');
const DOCS_ICON = icon(
    '<path d="M10 5.2c-1.2-1-2.9-1.5-4.7-1.5-.7 0-1.3.6-1.3 1.3v9c0 .7.6 1.3 1.3 1.3 1.8 0 3.5.5 4.7 1.5"/><path d="M10 5.2c1.2-1 2.9-1.5 4.7-1.5.7 0 1.3.6 1.3 1.3v9c0 .7-.6 1.3-1.3 1.3-1.8 0-3.5.5-4.7 1.5Z"/><path d="M10 5.2v11.6"/>',
);
const CHEVRON_ICON = icon('<path d="M8 5.5 12.5 10 8 14.5"/>', 14);
const GLOBE_ICON = icon(
    '<circle cx="10" cy="10" r="7"/><ellipse cx="10" cy="10" rx="3" ry="7"/><path d="M3 10h14"/>',
);
const BOX_ICON = icon(
    '<path d="M3.5 6.5 10 3l6.5 3.5v7L10 17l-6.5-3.5v-7Z"/><path d="M3.5 6.5 10 10l6.5-3.5M10 10v7"/>',
);
const STATICS_ICON = icon('<path d="M3 3v14h14M7 13V9m4 4V5m4 8V7"/>');
const SUBFORMATS_ICON = icon(
    '<rect x="3" y="3" width="14" height="14" rx="1"/><rect x="6" y="8" width="6" height="6" rx="1"/>',
);
const GIT_ICON = icon(
    '<path d="M5.5 6.5v7M14.5 6.5v1a4 4 0 0 1-4 4h-5"/><circle cx="5.5" cy="4.5" r="2"/><circle cx="5.5" cy="15.5" r="2"/><circle cx="14.5" cy="4.5" r="2"/>',
);
const STORAGE_ICON = icon(
    '<path d="m3 12 2-8h10l2 8"/><rect x="3" y="12" width="14" height="5" rx="1"/><path d="M13 14.5h1"/>',
);
const FOLDER_ICON = icon(`<path d="${FOLDER_ICON_PATH}"/>`);
const workspaceName = (site: Site): string =>
    site.workspace?.protocol === "storage" ? workspaceLabel(site.workspace) : "Files";
const workspaceText = (site: Site): string =>
    `<span${site.workspace?.protocol === "storage" ? "" : ' data-i18n="Files"'}>${escapeHtml(workspaceName(site))}</span>`;
const workspaceIcon = (site: Site): string => {
    if (site.workspace?.protocol === "git") return FOLDER_ICON;
    return site.workspace?.icon
        ? svgImg(site.workspace.icon, "nav-icon workspace-icon")
        : STORAGE_ICON;
};
const UPLOAD_ICON = icon(
    '<path d="M11.5 3H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6.5L11.5 3Z"/><path d="M11.5 3v3.5H15M10 14V9M7.8 11.2 10 9l2.2 2.2"/>',
    24,
);
const svgDataUri = (svg: string): string =>
    `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
/**
 * Full svg → <img> (data URI; inline svgs would let the ids / styles of multiple icons collide,
 * so each is confined to an img).
 */
const svgImg = (svg: string, cls: string): string => {
    const uri = svgDataUri(svg);
    const img = `<img class="${cls}" alt="" src="${uri}">`;
    return cls.includes("doc-icon")
        ? `<span class="doc-icon-frame" style="--doc-icon:url('${uri}')">${img}</span>`
        : img;
};
const GEAR_ICON = icon(
    '<path d="M4 6h7M15 6h1M4 14h1M9 14h7"/><circle cx="13" cy="6" r="2"/><circle cx="7" cy="14" r="2"/>',
    16,
);
const DELETE_ICON = icon(
    '<path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6M8.7 9v4M11.3 9v4"/>',
    15,
);
const PLUS_ICON = icon('<path d="M10 4.5v11M4.5 10h11"/>', 15);
const THEME_ICONS = {
    "": icon(
        '<circle cx="10" cy="10" r="6.5"/><path d="M10 3.5a6.5 6.5 0 0 0 0 13Z" fill="currentColor" stroke="none"/>',
    ),
    light: icon(
        '<circle cx="10" cy="10" r="3.4"/><path d="M10 2.6v1.8M10 15.6v1.8M2.6 10h1.8M15.6 10h1.8M4.8 4.8l1.3 1.3M13.9 13.9l1.3 1.3M15.2 4.8l-1.3 1.3M6.1 13.9l-1.3 1.3"/>',
    ),
    dark: icon('<path d="M15.5 12.4A6.2 6.2 0 0 1 7.6 4.5a6.5 6.5 0 1 0 7.9 7.9Z"/>'),
};
const FONT_ICON = icon(
    '<path d="M2.5 15 7 4l4.5 11M4 11h6M13 10.5c0-2.5 5-2.5 5 0V15M18 12h-2.5c-3.5 0-3.5 4 0 3L18 13.5"/>',
);
const SELECT_ICON = icon('<path d="m5 7 5 5 5-5"/>', 12);

const fontButton = (target: "editor" | "viewer"): string => {
    const label = target === "editor" ? "Editor font" : "Viewer font";
    return `<button class="pbtn font-control${target === "editor" ? " setting-picker" : ""}" type="button" data-font-picker="${target}" aria-haspopup="menu" aria-expanded="false" aria-label="${label}" title="${label}" disabled>${target === "editor" ? `<span data-picker-value></span>${SELECT_ICON}` : FONT_ICON}</button>`;
};

const CSS = `
:root { ${DARK_C} ${DOC_FROM_C} --doc-mono: ${MONO_FONT}; --font-sans: ${SANS_FONT}; }
html[data-theme] iframe[data-doc-figure-frame]:not([data-theme-ready]) { visibility: hidden; }
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { ${LIGHT_C} } }
:root[data-theme="light"] { ${LIGHT_C} }
body.edit :is(#sidebar, #panel, .resources-pane, .subformat-toast), .preview-pane[data-theme], .theme-picker[data-theme] { ${DARK_C} ${DOC_FROM_C} }
@media (prefers-color-scheme: light) {
  :root:not([data-editor-theme="dark"]) body.edit :is(#sidebar, #panel, .resources-pane, .subformat-toast),
  :is(.preview-pane, .theme-picker)[data-theme="auto"] { ${LIGHT_C} }
}
:root[data-editor-theme="light"] body.edit :is(#sidebar, #panel, .resources-pane, .subformat-toast),
:is(.preview-pane, .theme-picker)[data-theme="light"] { ${LIGHT_C} }
.preview-pane { background: var(--c-bg0); color: var(--c-fg); }
.theme-picker { position: fixed; margin: 0; padding: 5px; width: 148px; border: 1px solid var(--c-line);
  border-radius: 6px; background: var(--c-bg1); color: var(--c-fg); box-shadow: 0 8px 24px var(--c-shadow); }
.theme-picker button { display: flex; align-items: center; gap: 9px; width: 100%; padding: 7px 8px;
  border: 0; border-radius: 4px; background: transparent; color: inherit; font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.theme-picker button:hover, .theme-picker button:focus-visible { background: var(--c-raised); }
.theme-picker [aria-checked="true"]::after { content: "✓"; margin-left: auto; color: var(--c-accent); }
.font-control:focus:not(:focus-visible), .font-picker button:focus:not(:focus-visible) { outline: none; }
.font-control:focus-visible, .font-picker button:focus-visible { outline: 1px solid var(--c-accent); outline-offset: 1px; }
.font-control:disabled { opacity: .5; cursor: wait; }
.font-picker { width: min(240px, calc(100vw - 16px)); overflow-y: auto; }
.font-picker button { overflow-wrap: anywhere; }
.font-picker [aria-checked="true"]::after { flex: none; }
.font-status { padding: 8px; font-size: 11px; color: var(--c-danger); }
main { --doc-mono: var(--viewer-font, ${MONO_FONT}); }
.resources-pane { --doc-mono: var(--editor-font, ${MONO_FONT}); background: var(--c-bg1); color: var(--c-fg); font-family: var(--doc-mono); }
.page-actions, .pane-actions { position: sticky; display: flex; align-items: center; justify-content: flex-end;
  gap: 2px; height: 36px; padding: 0 24px; pointer-events: none; z-index: 5; }
:is(.page-actions, .pane-actions) > .pbtn { pointer-events: auto; background: var(--c-bg0); }
.page-actions { top: 0; margin: -20px -24px -36px; }
.pbtn { flex: none; display: flex; align-items: center; justify-content: center; width: 28px; height: 28px;
  padding: 0; color: var(--c-fg-faint); background: none; border: none; border-radius: 5px; cursor: pointer;
  transition: color 120ms ease, background 120ms ease; }
.pbtn:hover, .pbtn:focus-visible, #gear.open > .pbtn { color: var(--c-fg); background: var(--c-raised); }
* { box-sizing: border-box; scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--c-fg-muted) 42%, transparent) transparent; }
::-webkit-scrollbar { width: 7px; height: 7px; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--c-fg-muted) 42%, transparent); border: 2px solid transparent; border-radius: 999px; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background-color: color-mix(in srgb, var(--c-fg-muted) 68%, transparent); }
@supports selector(::-webkit-scrollbar) { * { scrollbar-width: auto; scrollbar-color: auto; } }
input[type="checkbox"] { appearance: none; position: relative; display: inline-block; flex: none; width: 15px; height: 15px; margin: 0; vertical-align: middle; border: 1px solid var(--c-fg-muted); border-radius: 4px; background: transparent; cursor: pointer; }
input[type="checkbox"]:checked { border-color: var(--c-accent); }
input[type="checkbox"]:checked::after { content: ""; position: absolute; left: 4px; top: 1px; width: 4px; height: 8px; border: solid var(--c-accent); border-width: 0 2px 2px 0; transform: rotate(45deg); }
input[type="checkbox"]:indeterminate::after { content: ""; position: absolute; left: 3px; top: 6px; width: 7px; border-top: 2px solid var(--c-accent); }
input[type="checkbox"]:focus-visible { outline: 2px solid var(--c-accent); outline-offset: 3px; }
input[type="checkbox"]:disabled { opacity: .5; cursor: default; }
@media (forced-colors: active) { input[type="checkbox"] { appearance: auto; } input[type="checkbox"]::after { display: none; } }
body { margin: 0; display: flex; min-height: 100vh; background: var(--c-bg0); color: var(--c-fg);
  font-family: var(--font-sans); font-weight: var(--fw-body); font-size: 13px; line-height: 1.55;
  overflow-x: hidden; }
button { font-family: inherit; font-size: inherit; font-weight: var(--fw-body); }
:focus-visible { outline: 1px solid var(--c-accent); outline-offset: 1px; }

#doc-search { position: fixed; top: 12px; left: 0; right: 0; z-index: 20;
  width: min(420px, calc(100vw - 24px)); min-height: 44px; max-height: min(420px, calc(100dvh - 24px)); margin: 0 auto;
  padding: 0 8px 6px; color: var(--c-fg); background: color-mix(in srgb, var(--c-bg1) 82%, transparent);
  border: 1px solid color-mix(in srgb, var(--c-fg-muted) 55%, transparent);
  backdrop-filter: blur(16px); border-radius: 8px; box-shadow: 0 8px 24px #0003; overflow: hidden; }
#doc-search[open] { display: flex; flex-direction: column; }
#doc-search :focus-visible { outline-color: var(--c-fg-muted); }
.search-grip { position: relative; flex: none; height: 8px; margin: 0 -8px; cursor: grab; touch-action: none; }
.search-grip:active { cursor: grabbing; }
.search-grip::after { content: ""; position: absolute; top: 50%; left: 50%; width: 36px; height: 4px;
  margin: -2px 0 0 -18px; border-radius: 2px; background: var(--c-line); }
.search-grip:hover::after, .search-grip:focus-visible::after { background: var(--c-fg-muted); }
.search-head { display: flex; flex: none; align-items: center; gap: 8px; padding: 0 0 0 4px;
  color: var(--c-fg-muted); }
.search-head svg { flex: none; }
#doc-search.search-filled .search-head > svg { display: none; }
.search-head button, .search-copy { display: grid; place-items: center; width: 24px; height: 24px; padding: 0;
  color: var(--c-fg-muted); background: none; border: 0; border-radius: 4px; cursor: pointer; }
.search-head button { flex: none; }
.search-head button + button { margin-left: -8px; }
.search-head button:hover, .search-copy:hover { color: var(--c-fg); background: color-mix(in srgb, var(--c-fg-muted) 18%, transparent); }
#doc-search-input { width: 100%; min-width: 0; padding: 3px 0; font: inherit; font-size: 14px;
  color: var(--c-fg); background: none; border: 0; outline: none; }
#doc-search-input::-webkit-search-cancel-button { appearance: none; }
.search-status { padding: 6px 8px; color: var(--c-fg-muted); font-size: 12px; }
.search-status:empty { display: none; }
.search-count { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap; }
#doc-search-results { position: relative; z-index: 1; overflow-y: auto; overscroll-behavior: contain;
  scrollbar-gutter: stable; margin-right: -8px; padding-right: 8px;
  min-height: 0; display: flex; flex-direction: column; gap: 8px; }
#doc-search-results:not(:empty) { margin-top: 6px; }
#doc-search-results a { display: flex; flex: none; flex-direction: column; gap: 6px;
  border: 1px solid var(--c-line); border-radius: 5px; color: var(--c-fg); text-decoration: none;
  background: color-mix(in srgb, var(--c-bg0) 50%, transparent); overflow-wrap: anywhere; }
#doc-search-results a:hover, #doc-search-results a[aria-selected="true"] { border-color: var(--c-fg-muted); }
#doc-search-results mark { color: inherit; background: color-mix(in srgb, var(--c-accent) 32%, transparent);
  border-radius: 2px; }
.search-meta { display: flex; align-items: center; gap: 6px;
  padding: 5px 10px; border-bottom: 1px solid var(--c-line); color: var(--c-fg-muted); }
.search-kind { display: grid; flex: none; }
.search-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#doc-search-results strong { margin: 2px 10px 0; font-weight: 500; }
#doc-search-results strong:last-child { margin-bottom: 10px; }
.search-snippet { margin: 0 10px 10px; color: var(--c-fg-muted); }
.search-hit { position: relative; flex: none; }
.search-name + .search-name { margin-top: -4px; }
.search-name .search-meta { padding-right: 40px; border-bottom: 0; }
.search-name .search-path { color: var(--c-fg); }
.search-copy { position: absolute; top: 50%; right: 6px; margin-top: -12px; }
.search-flash { animation: search-flash 2.6s ease-out; }
@keyframes search-flash {
  0%, 35% { background-color: color-mix(in srgb, var(--c-accent) 18%, transparent);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--c-accent) 18%, transparent); }
  100% { background-color: transparent; box-shadow: 0 0 0 4px transparent; } }
/* Docked, the panel is a right sidebar like #panel. */
#doc-search.search-docked { position: sticky; top: 0; left: auto; right: auto; z-index: auto; flex: 0 1 auto;
  align-self: flex-start; width: 320px; min-width: 240px; height: 100vh; min-height: 0; max-height: none; margin: 0;
  padding: 8px 10px 10px; border: 0; border-left: 1px solid var(--c-line); border-radius: 0;
  background: var(--c-bg1); box-shadow: none; backdrop-filter: none; }
.search-docked #doc-search-results { margin-right: -10px; padding-right: 10px; }
/* Keep the preview readable; the editor panel gives up width before the search sidebar does. */
body:has(#doc-search.search-docked[open]) main { min-width: 240px; }
body:has(#doc-search.search-docked[open]) #panel { flex-shrink: 100; min-width: 240px; }
.search-docked :is(.search-grip, .search-resize-x, .search-resize-y, .search-resize-xy),
#doc-search:not(.search-docked) .search-resize-w { display: none; }
/* Invisible edges: the right and bottom borders resize the window. */
.search-resize { position: absolute; touch-action: none; }
.search-resize:focus-visible { outline-offset: -2px; }
.search-resize-x { top: 0; right: 0; bottom: 0; width: 6px; cursor: ew-resize; }
.search-resize-y { left: 0; right: 0; bottom: 0; height: 6px; cursor: ns-resize; }
.search-resize-xy { right: 0; bottom: 0; width: 12px; height: 12px; cursor: nwse-resize; }
.search-resize-w { top: 0; left: 0; bottom: 0; width: 6px; cursor: ew-resize; }

/* ── sidebar ── */
#sidebar { width: var(--sidebar-width, 260px); height: 100vh; position: sticky; top: 0; flex: none;
  display: flex; flex-direction: column; background: var(--c-bg1);
  border-right: 1px solid var(--c-line); overflow: hidden; }
body.sidebar-closed #sidebar { width: 52px; }
body.sidebar-closed #sidebar-resize { display: none; }
.panel-resize { position: absolute; top: 0; bottom: 0; width: 8px; cursor: col-resize; z-index: 6;
  touch-action: none; }
.panel-resize::before { content: ""; position: absolute; top: 0; bottom: 0; width: 2px; border-radius: 1px;
  transition: background 120ms ease; }
#sidebar-resize { right: 0; }
#sidebar-resize::before { right: -1px; }
#resize { left: 0; }
#resize::before { left: -1px; }
.panel-resize:hover::before, .panel-resize:focus-visible::before, .panel-resize.drag::before {
  background: color-mix(in srgb, var(--c-accent) 60%, transparent); }
.panel-resize.drag { outline: none; }
body.resizing, body.resizing * { cursor: col-resize !important; user-select: none !important; }
body.sidebar-closed .site-title { display: none; }
#sidebar-head { position: relative; flex: none; display: flex; align-items: center; min-width: 0; min-height: 36px;
  border-bottom: 1px solid var(--c-line); }
#sidebar-toggle { flex: none; display: flex; align-items: center; padding: 8px 16px;
  background: transparent; border: none; color: var(--c-fg-muted); cursor: pointer; }
#sidebar-toggle:hover { color: var(--c-fg); }
#site-icon-slot { position: relative; flex: none; width: 24px; height: 24px; margin: 0 8px 0 16px; color: var(--c-fg-muted); }
#site-icon, #site-icon-slot > .nav-icon, .site-icon-variants > img { display: block; width: 100%; height: 100%; object-fit: contain; }
.site-icon-variants, .site-icon-variants > span { display: contents; }
#site-icon[hidden], .site-icon-variants > [hidden], #site-icon-slot:has(#site-icon:not([hidden])) > .nav-icon { display: none; }
body.sidebar-closed #site-icon-slot { margin: 0 auto; }
body.sidebar-closed #sidebar-toggle { position: absolute; inset: 0; width: 100%; justify-content: center; padding: 0; }
body.sidebar-closed #sidebar-toggle svg { visibility: hidden; }
.site-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  padding-right: 12px; color: var(--c-fg); white-space: nowrap; }
#sidebar-content { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden;
  scrollbar-gutter: stable;
  padding: 10px 0 8px; }
.nav-link { position: relative; display: flex; align-items: center; gap: 14px; padding: 10px 16px;
  color: var(--c-fg-muted); text-decoration: none; background: transparent; border: none;
  font: inherit; text-align: left; cursor: pointer; min-width: 0; }
.nav-link::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
  background: transparent; transition: background 120ms ease-out; }
.nav-link:hover { color: var(--c-fg); background: var(--c-raised); }
.nav-link:hover::before { background: var(--c-line); }
.nav-link.cur { color: var(--c-fg); }
.nav-link.cur::before { background: var(--c-accent); }
.nav-icon { flex: none; }
.nav-row :is(svg.nav-icon, .doc-icon-frame) { translate: 0 1px; }
.workspace-icon { width: 18px; height: 18px; object-fit: contain; }
.nav-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* The doc tree. Top-level docs are .nav-link with an icon,
   descendants are .nav-tree. --nav-depth is set on the children list (top level's children = 2),
   --nav-pad = where that level's label starts, --nav-line = x of that level's guide line. Each
   item draws a vertical line (the vertical of ├), and only the last item stops it at the row's
   middle to form └. The path down to the current doc is accented.
   The data has no root / child distinction (any doc can have children) — only the look changes
   per level. */
.nav-row { position: relative; display: flex; align-items: center; min-width: 0; }
.nav-row > .nav-link { flex: 1; min-width: 0; padding: 9px 16px; }
.nav-row > .nav-link.cur { background: var(--c-raised); }
.nav-item:not(.open) > .nav-list { display: none; }
.nav-tree-toggle { flex: none; display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; margin-right: 6px; padding: 0; background: transparent; border: none;
  border-radius: 4px; color: var(--c-fg-faint); cursor: pointer; }
.nav-tree-toggle:hover { color: var(--c-fg); background: var(--c-raised); }
.nav-tree-toggle svg { transition: transform 120ms ease-out; }
.nav-item.open > .nav-row > .nav-tree-toggle svg { transform: rotate(90deg); }
.nav-tree { --nav-pad: calc(48px + (var(--nav-depth, 2) - 2) * 29px);
  --nav-line: calc(var(--nav-pad) - 23px); margin: 0; padding-bottom: 4px; }
.nav-tree:empty { padding-bottom: 0; }
.nav-tree > .nav-item { position: relative; }
.nav-tree > .nav-item:not(:last-child)::before, .nav-tree > .nav-item > .nav-row::before,
.nav-tree > .nav-item:last-child > .nav-row::after, .nav-tree > .nav-item:has(.cur) > .nav-row::after {
  content: ""; position: absolute; z-index: 1; pointer-events: none; left: var(--nav-line);
  background: var(--c-line); }
/* vertical of ├ / └ */
.nav-tree > .nav-item:not(:last-child)::before { top: 0; bottom: 0; width: 1px; z-index: 2; }
.nav-tree > .nav-item:last-child > .nav-row::after, .nav-tree > .nav-item:has(.cur) > .nav-row::after {
  top: 0; height: calc(50% + 1px); width: 1px; z-index: 3; }
/* ─ (up to 6px before the label) */
.nav-tree > .nav-item > .nav-row::before { top: 50%; width: 17px; height: 1px; }
.nav-tree > .nav-item:has(~ .nav-item .cur)::before, .nav-tree > .nav-item:has(.cur) > .nav-row::before,
.nav-tree > .nav-item:has(.cur) > .nav-row::after { background: var(--c-accent); }
.nav-ancestor { --nav-pad: 12px; --nav-line: var(--nav-rail, 21px); }
.nav-list:has(> .nav-ancestor) > .nav-item:not(.nav-ancestor) { height: 0; opacity: 0; overflow: hidden; visibility: hidden; }
#nav-groups { --nav-motion: 260ms cubic-bezier(.2, .8, .2, 1); }
#nav-groups :is(.nav-tree-link, .nav-doc-row) { transition: padding-left var(--nav-motion); }
#nav-groups :is(.nav-create, .nav-new) { transition: margin-left var(--nav-motion); }
#nav-groups .nav-item::before, #nav-groups .nav-row::before, #nav-groups .nav-row::after {
  transition: left var(--nav-motion), width var(--nav-motion), height var(--nav-motion), top var(--nav-motion); }
/* A connector changing orientation must stay 1px thick instead of morphing into a rectangle. */
#nav-groups .nav-row::before { transition-property: left, top; }
@media (prefers-reduced-motion: reduce) { #nav-groups { --nav-motion: 0s; } }
.nav-ancestor > .nav-tree > .nav-item::before,
.nav-ancestor > .nav-tree > .nav-item > .nav-row::before,
.nav-ancestor > .nav-tree > .nav-item > .nav-row::after { display: none; }
/* One rail reaches the next ancestor, then stops at the selected row. */
.nav-ancestor > .nav-tree > .nav-item:has(~ .nav-item .cur)::before {
  display: block; left: var(--nav-rail, 21px); background: var(--c-accent); }
.nav-root > .nav-ancestor.open > .nav-row::after,
.nav-ancestor > .nav-tree > .nav-ancestor.open > .nav-row::after {
  content: ""; display: block; position: absolute; left: var(--nav-rail, 21px); top: calc(50% + var(--nav-icon-half, 10px)); bottom: 0;
  width: 1px; height: auto; background: var(--c-accent); pointer-events: none; }
.nav-ancestor > .nav-tree > .nav-ancestor > .nav-row::before {
  display: block; left: var(--nav-rail, 21px); top: 0; width: 1px; height: calc(50% - var(--nav-icon-half, 10px)); background: var(--c-accent); }
.nav-ancestor > .nav-tree > .nav-item:has(> .nav-row > a.cur) { --nav-line: var(--nav-rail, 21px); }
.nav-ancestor > .nav-tree > .nav-item:has(> .nav-row > a.cur) > .nav-row::before { display: block; width: calc(42px - var(--nav-rail, 21px)); }
.nav-ancestor > .nav-tree > .nav-item:has(> .nav-row > a.cur) > .nav-row::after { display: block; }
.nav-tree-link { position: relative; flex: 1; min-width: 0; display: flex; align-items: center;
  padding: 6px 8px 6px var(--nav-pad); color: var(--c-fg-muted); font-size: 13px; text-decoration: none; }
.nav-tree-link:hover:not(.cur) { color: var(--c-fg); background: var(--c-raised); }
/* The accented guide line marks the current doc, so no left-edge vertical bar (the top-level
   marker). */
.nav-tree-link.cur { color: var(--c-fg); background: var(--c-raised); }
/* Doc-specific icon (icons/<id>.svg, 1:1). Top level: in place of the book icon; descendants:
   before the label */
img.doc-icon { flex: none; width: 18px; height: 18px; object-fit: contain; }
.doc-icon-frame { position: relative; display: inline-flex; flex: none; width: 18px; height: 18px; }
.doc-icon-frame > img { width: 100%; height: 100%; }
.nav-tree-link > .doc-icon-frame, .nav-tree-link > .nav-icon { width: 15px; height: 15px; margin-right: 7px; }
.nav-row > a.cur :is(.nav-icon, .doc-icon-frame), .nav-doc-row:has(> a.cur) > .nav-doc-icon { color: var(--c-accent); }
.nav-row > a.cur .doc-icon-frame > img, .nav-doc-row:has(> a.cur) > .nav-doc-icon .doc-icon-frame > img { visibility: hidden; }
.nav-row > a.cur .doc-icon-frame::after, .nav-doc-row:has(> a.cur) > .nav-doc-icon .doc-icon-frame::after {
  content: ""; position: absolute; inset: 0; background: currentColor; mask: var(--doc-icon) center / contain no-repeat; }
body.sidebar-closed :is(#sidebar-content, #nav-docs) { scrollbar-width: none; scrollbar-gutter: auto; }
body.sidebar-closed #nav-groups { --nav-rail: 8px; }
body.sidebar-closed #nav-groups .nav-label, body.sidebar-closed #nav-status { opacity: 0; pointer-events: none; }
body.sidebar-closed #nav-groups .nav-placeholder { visibility: hidden; pointer-events: none; }
body.sidebar-closed #nav-groups :is(.nav-tree-toggle, .nav-tree-spacer, .new, .nav-delete, .files-upload-status, .files-drop-hint, .extensions-drop-hint, input, .nav-icon-clear) { display: none; }
body.sidebar-closed #nav-groups .nav-tree { --nav-pad: 18px; --nav-line: 8px; }
body.sidebar-closed #nav-groups .nav-tree > .nav-item:not(.nav-ancestor) > .nav-row::before { width: calc(var(--nav-pad) - var(--nav-line) - 2px); }
body.sidebar-closed #nav-groups .nav-ancestor.open > .nav-row::after { top: 50%; }
body.sidebar-closed #nav-groups .nav-ancestor > .nav-tree > .nav-ancestor > .nav-row::before { height: 50%; }
body.sidebar-closed #nav-groups :is(.nav-row > .nav-link, .nav-tree-link) { padding-left: 0; padding-right: 0; gap: 0; }
body.sidebar-closed #nav-groups .nav-doc-row { padding-left: 0; gap: 0; }
body.sidebar-closed #nav-groups .nav-doc-row > a { padding-left: 0; }
body.sidebar-closed #nav-groups :is(.nav-doc-icon, .nav-row > a > .nav-icon, .nav-row > a > .doc-icon-frame) { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); margin: 0; }
body.sidebar-closed #nav-groups .nav-doc-icon { z-index: 1; pointer-events: none; }
body.edit #sidebar-content { display: flex; flex-direction: column; overflow: hidden; scrollbar-gutter: auto; }
body.edit #nav-groups { flex: 1; min-height: 0; display: flex; flex-direction: column; }
#nav-docs { flex: 1; min-height: 0; overflow: auto; scrollbar-gutter: stable; }
#nav-tools { position: relative; flex: none; margin: 10px 8px 4px; padding: 12px 4px 4px; border: 1px solid var(--c-line); border-radius: 8px; background: var(--c-bg1); }
.nav-tool-cards { max-height: max(36px, calc(50dvh - 40px)); overflow: auto; }
#nav-tools .nav-resources { height: 36px; margin: 0; border: 0; border-radius: 4px; }
.workspace-location { position: absolute; top: -1px; left: 10px; right: 6px; z-index: 3; transform: translateY(-50%); display: flex; align-items: center; gap: 4px; padding: 0 2px; color: var(--c-fg-muted); font: 600 10px/16px var(--font-sans); cursor: pointer; list-style: none; border-radius: 4px; }
#nav-tools:not([open]) { padding-bottom: 0; border-color: transparent; border-top-color: var(--c-line); border-radius: 0; }
.workspace-location::-webkit-details-marker { display: none; }
.workspace-location:hover { color: var(--c-fg); }
.workspace-location > .nav-icon { flex: none; width: 14px; height: 14px; background: var(--c-bg1); }
.workspace-location > .nav-icon:last-child { margin-left: auto; }
#nav-tools[open] > .workspace-location > .nav-icon:last-child { transform: rotate(90deg); }
.workspace-address { min-width: 0; padding: 0 2px; background: var(--c-bg1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
body.sidebar-closed #nav-tools { margin-left: 4px; margin-right: 4px; padding-left: 0; padding-right: 0; }
body.sidebar-closed .workspace-location { left: 2px; right: 2px; min-height: 16px; }
body.sidebar-closed .workspace-address { display: none; }
.nav-resources { position: relative; container-type: size; flex: none; height: 42px; margin: 8px 8px 4px;
  border: 1px solid var(--c-line); border-radius: 8px; overflow: hidden;
  background: var(--c-bg1); font-family: var(--font-sans); }
.nav-resources > .nav-item, .nav-resources .nav-row { height: 100%; }
.nav-resources .nav-row > .nav-link { height: 100%; padding: 8px 10px; gap: 8px; }
.nav-resources .nav-row { cursor: default; }
.nav-resources .nav-link::before { display: none; }
.files-upload-status { flex: none; margin-right: 10px; color: var(--c-fg-muted); font: 10px var(--doc-mono); }
.files-upload-status:empty { display: none; }
.files-upload-status[data-state="error"] { color: var(--c-danger); }
.files-upload-status[data-state="done"] { color: var(--doc-ok); }
.files-drop-hint, .extensions-drop-hint { position: absolute; inset: 0; display: none; align-items: center;
  justify-content: center; gap: 6px; padding: 6px; pointer-events: none; text-align: center; }
.files-drop-hint > svg { width: 28px; height: 28px; }
.files-drop-hint ul { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px 8px;
  margin: 0; padding: 0; list-style: none; font: 11px var(--doc-mono); color: var(--c-fg-muted); }
@container (max-height: 140px) { .files-drop-hint ul { display: none; } }
body.files-dragging #nav-files { border-color: var(--c-accent); }
body.files-dragging :is(#nav-files, #nav-extensions) > .nav-item { opacity: .15; }
body.files-dragging :is(.files-drop-hint, .extensions-drop-hint) { display: flex; }
body.files-over #nav-files { background: color-mix(in srgb, var(--c-accent) 10%, var(--c-bg1)); }
#nav-status { min-height: 16px; margin: 6px 16px 0; color: var(--c-fg-faint); font-size: 11px;
  line-height: 1.35; }
#nav-status.err { color: var(--c-danger); }

/* ── main (document body) ── */
main { flex: 1; min-width: 0; padding: 20px 24px 50vh; }
main:not(.editor-workspace) { height: 100vh; overflow: auto; overscroll-behavior: contain; }
article { max-width: 860px; margin: 0 auto; font-family: var(--viewer-font, system-ui, sans-serif); }
.external-embed { margin: 18px 0; overflow-wrap: anywhere; }
.plugin { position: relative; min-width: 0; border: 2px solid var(--doc-border); border-top: 0; }
.plugin-toolbar { position: absolute; top: 0; left: -2px; right: -2px; transform: translateY(-50%);
  display: flex; align-items: center; gap: 4px; }
.plugin-toolbar::before, .plugin-toolbar::after { content: ""; border-top: 2px solid var(--doc-border); }
.plugin-toolbar::before { flex: 1; min-width: 12px; }
.plugin-toolbar::after { flex: 0 0 8px; }
.plugin-action[data-state="copied"] { color: var(--doc-ok); }
.plugin-action .ic-ok, .plugin-action[data-state="copied"] svg:not(.ic-ok) { display: none; }
.plugin-action[data-state="copied"] .ic-ok { display: block; }
.plugin.collapsed [data-plugin-action="fold"] svg { transform: rotate(-90deg); }
.plugin.collapsed [data-plugin-result], .plugin.collapsed [data-plugin-controls],
.plugin.collapsed [data-plugin-status], .plugin[data-ready="true"]:not(.collapsed) .plugin-info,
.plugin[data-ready="true"]:not(.collapsed) .plugin-header:has([data-plugin-controls][hidden]) { display: none; }
.plugin:not(.collapsed) [data-plugin-collapsed],
.plugin.collapsed:has([data-plugin-collapsed]:not(:empty)) .plugin-header { display: none; }
.plugin-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap;
  gap: 8px; padding: 12px; }
.plugin-info { flex: 1 1 240px; min-width: 0; }
.plugin-info h2 { margin: 0; padding: 0; border: 0; font-size: 12px; overflow-wrap: anywhere; }
[data-plugin-status] { margin: 6px 0 0; color: var(--doc-fg-3); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
[data-plugin-status] a { color: var(--doc-accent); text-underline-offset: 3px; }
[data-plugin-controls] { display: flex; flex-wrap: wrap; gap: 6px; }
[data-plugin-controls][hidden], [data-plugin-status]:empty { display: none; }
[data-plugin-controls] button { min-height: 26px; padding: 3px 8px; border: 1px solid var(--doc-border);
  border-radius: 4px; background: var(--doc-bg); color: var(--doc-fg); font: inherit; font-size: 11px; cursor: pointer; }
[data-plugin-controls] button[data-plugin-action="read"] { background: var(--doc-accent); border-color: transparent; color: var(--doc-accent-fg); }
[data-plugin-controls] button[data-plugin-action="disconnect"] { background: transparent; border-color: transparent; color: var(--doc-fg-3); }
[data-plugin-controls] button:hover { box-shadow: inset 0 0 0 1px currentColor; }
[data-plugin-controls] button:focus-visible { outline: 2px solid var(--doc-accent); outline-offset: 3px; }
[data-plugin-controls] button:disabled { opacity: .55; cursor: wait; }
.plugin-content { padding: 12px; overflow: auto; }
.plugin-content:empty { display: none; }
.plugin-resize { display: none; height: 12px; align-items: center; justify-content: center;
  cursor: row-resize; touch-action: none; user-select: none; }
.plugin[data-ready="true"]:not(.collapsed) > .plugin-resize { display: flex; }
.plugin-resize::before { content: ""; width: 32px; height: 2px; border-radius: 1px; background: var(--doc-border); }
.plugin-resize:hover::before, .plugin-resize:focus-visible::before, .plugin-resize.drag::before { background: var(--doc-accent); }
.plugin-resize:focus-visible { outline: 2px solid var(--doc-accent); outline-offset: -2px; }
.plugin-resize.drag { outline: none; }
body:has(.plugin-resize.drag), body:has(.plugin-resize.drag) * { cursor: row-resize !important; user-select: none !important; }
body:has(.plugin-resize.drag) iframe { pointer-events: none; }

.plugin { container-type: inline-size; background: var(--doc-bg); color: var(--doc-fg); }
.plugin .plugin-content { padding: 12px 14px; }
.plugin .plugin-header { padding: 0 16px; }
.plugin[data-ready="true"] .plugin-info { display: block; flex-basis: auto; }
.plugin[data-ready="true"] .plugin-info h2 { display: none; }
.plugin[data-ready="true"] .plugin-header:has([data-plugin-status]:not(:empty)) { display: flex; padding-top: 12px; }
.plugin [data-plugin-status] { margin: 0; }
.plugin[data-operation-error="true"] [data-plugin-status] { color: var(--doc-danger); }
.plugin-heading { order: -1; display: flex; align-items: center; gap: 8px; min-width: 0; max-width: calc(100% - 156px); font: inherit; font-size: 11px; line-height: 20px; }
.plugin-heading::before { content: ""; border-top: 2px solid var(--doc-border); width: 8px; flex: none; }
.plugin-heading a { display: flex; align-items: center; gap: 6px; color: var(--doc-fg-2); text-decoration: none; flex: none; }
.plugin-heading img { display: block; width: 16px; height: 16px; }
.plugin-heading-context { color: var(--doc-fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.plugin-heading button { font: inherit; color: var(--doc-fg-2); background: transparent; border: 0; padding: 0; cursor: pointer; white-space: nowrap; }
${PLUGIN_BLOCK_CSS}

article, article * { font-weight: 400; }
h1, h2, h3 { font-weight: 400; }
article h1 { font-size: 26px; margin: 0 0 2px; }
article :is(h1, h2, h3, h4, h5, h6):has(> .section-copy) { position: relative; padding-right: 32px; }
.section-copy { position: absolute; right: 0; top: 0; display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; border: 0; border-radius: 4px; background: transparent;
  color: var(--c-fg-faint); cursor: pointer; }
.section-copy:hover, .section-copy:focus-visible { background: var(--c-raised); color: var(--c-fg); }
.section-copy svg { flex: none; width: 16px; height: 16px; }
.section-copy .ic-ok, .section-copy.ok svg:not(.ic-ok), .section-copy.error svg { display: none; }
.section-copy.ok .ic-ok { display: block; color: var(--doc-ok); }
.section-copy.error::after { content: "!"; color: var(--c-danger); }
article h2 { font-size: 20px; margin-top: 24px; margin-bottom: 8px; border-bottom: 1px solid
  color-mix(in srgb, currentColor 20%, transparent); padding-bottom: 3px; }
article h3 { font-size: 16px; margin-top: 16px; margin-bottom: 4px; }
h2[id], h3[id] { scroll-margin-top: 12px; }
p { margin: 8px 0; }
ul, ol { margin: 4px 0; }
li { margin: 0; }
li > ul, li > ol { margin: 0; }
.fullname { opacity: .7; margin-bottom: 8px; }
code { background: color-mix(in srgb, currentColor 10%, transparent);
  padding: 1px 5px; border-radius: 4px; font-size: .9em; font-family: var(--doc-mono); }
:not(pre) > code { white-space: break-spaces; }
pre { background: color-mix(in srgb, currentColor 6%, transparent);
  padding: 10px 14px; overflow-x: auto; line-height: 1.5; font-family: var(--doc-mono); }
pre code { background: none; padding: 0; font-size: 13.5px; }
pre code.code-foldable { display: block; padding-left: 18px; }
.code-line { position: relative; }
.code-line[hidden] { display: none; }
.code-section-fold { position: absolute; left: -17px; top: 1px; display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 16px; padding: 0; border: 0; border-radius: 3px; background: transparent; color: var(--doc-fg-3); cursor: pointer; }
.code-section-fold:hover { color: var(--doc-accent); background: var(--doc-bg-2); }
.code-section-fold:focus-visible { outline: 2px solid var(--doc-accent); }
.code-section-fold[aria-expanded="false"] svg { transform: rotate(-90deg); }
.code-line-folded > .code-line-text::after { content: " …"; color: var(--doc-fg-3); }
.fig { margin: 10px 0; }
/* Only direct svg / img children (= figures) follow the width; icon svgs inside html fragments
   are left alone */
.fig > svg, .fig > img, .fig > video { max-width: 100%; height: auto; display: block; }
.video-player { container-type: inline-size; width: 100%; min-width: 0; color: var(--doc-fg-2); }
.video-player > video { display: block; width: 100%; height: auto; border-radius: 8px; background: #000; }
.video-player > video:fullscreen { max-height: none; border-radius: 0; object-fit: contain; }
.video-controls { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.video-controls > button { display: grid; place-items: center; flex: none; width: 28px; height: 28px; padding: 0;
  border: 0; border-radius: 5px; color: inherit; background: transparent; cursor: pointer; }
.video-controls > button:hover, .video-controls > button[aria-expanded="true"] { color: var(--doc-fg); background: var(--doc-bg-3); }
.video-controls > button:disabled { opacity: .4; cursor: default; }
.video-controls :is(button, input):focus-visible, .video-settings input:focus-visible { outline: 2px solid var(--doc-accent); outline-offset: 2px; }
:is(.video-controls, .video-settings) input { appearance: none; height: 24px; padding: 0; margin: 0; border: 0; background: transparent; cursor: pointer; }
:is(.video-controls, .video-settings) input:disabled { opacity: .4; cursor: default; }
:is(.video-controls, .video-settings) input::-webkit-slider-runnable-track { height: 2px; border-radius: 1px;
  background: linear-gradient(to right, var(--doc-accent) var(--video-progress, 0%), var(--doc-border-2) var(--video-progress, 0%)); }
:is(.video-controls, .video-settings) input::-webkit-slider-thumb { appearance: none; width: 8px; height: 8px; margin-top: -3px;
  border: 0; border-radius: 50%; background: var(--doc-accent); }
:is(.video-controls, .video-settings) input::-moz-range-track { height: 2px; border-radius: 1px; background: var(--doc-border-2); }
:is(.video-controls, .video-settings) input::-moz-range-progress { height: 2px; border-radius: 1px; background: var(--doc-accent); }
:is(.video-controls, .video-settings) input::-moz-range-thumb { width: 8px; height: 8px; border: 0; border-radius: 50%; background: var(--doc-accent); }
.video-controls .video-seek { flex: 1; min-width: 24px; width: 0; }
.video-controls .video-volume { flex: 0 0 60px; width: 60px; }
.video-time { flex: none; font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.video-settings { position: fixed; inset: auto; box-sizing: border-box; width: min(240px, calc(100vw - 16px)); margin: 0;
  padding: 12px; border: 1px solid var(--doc-border); border-radius: 8px; color: var(--doc-fg);
  background: var(--doc-bg-2); box-shadow: 0 8px 24px var(--c-shadow); }
.video-settings label { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8px 12px; font-size: 12px; }
.video-speed-value { color: var(--doc-fg-2); font-variant-numeric: tabular-nums; }
.video-settings .video-speed { grid-column: 1 / -1; width: 100%; }
.video-status { color: var(--doc-danger); font-size: 12px; margin: 6px 0; }
.video-player [hidden] { display: none; }
@container (max-width: 420px) { .video-controls .video-volume { display: none; } }
.fig-frame { display: block; max-width: 100%; border: 0; background: transparent; }
.figure-placeholder { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; min-height: 120px; padding: 20px; border: 1px solid var(--doc-border); background: var(--doc-bg-2); color: var(--doc-fg-2); overflow-wrap: anywhere; }
.figure-placeholder button { font: inherit; padding: 6px 12px; border: 1px solid var(--doc-border); border-radius: 4px; background: var(--doc-bg); color: var(--doc-fg); cursor: pointer; }
.figure-placeholder button:focus-visible { outline: 2px solid var(--doc-accent); outline-offset: 2px; }
.figure-placeholder button:disabled { cursor: wait; }
/* Code and file blocks share a border label; clicking it collapses the content. */
.codeblk { position: relative; margin: 12px 0; border: 2px solid var(--doc-border); border-top: 0; }
.codeblk > pre { margin: 0; background: transparent; padding: 8px 12px 6px; }
.codeblk-head { position: absolute; top: 0; left: -2px; right: -2px; transform: translateY(-50%);
  display: flex; align-items: center; gap: 4px; cursor: pointer; }
.codeblk-head::before, .codeblk-head::after, .codeblk-lang::before { content: ""; border-top: 2px solid var(--doc-border); }
.codeblk-head::before { flex: 1; min-width: 12px; }
.codeblk-head::after { order: 2; flex: 0 0 8px; }
.codeblk-lang { order: -1; display: flex; align-items: center; gap: 4px;
  font-family: var(--doc-mono); font-size: 11px; color: var(--doc-fg-2); }
.codeblk-lang::before { flex: 0 0 8px; }
.codeblk-filename { margin: 0; min-width: 0; max-width: 70%;
  font-family: var(--doc-mono); font-size: 11px; color: var(--doc-fg-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.codefold svg { transition: transform 150ms ease; }
.codeblk.collapsed .codefold svg { transform: rotate(-90deg); }
@media (prefers-reduced-motion: reduce) { .codefold svg { transition: none; } }
.codeblk.collapsed > pre { display: none; }
.codeblk.collapsed { min-height: 1px; border-bottom: 0; margin-bottom: 18px; }
.codeblk :is(.codecopy, .codefold), .plugin-action { display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; width: 16px; height: 16px; padding: 0; border: none; border-radius: 6px; background: none;
  color: var(--doc-fg-3); cursor: pointer; }
.codeblk :is(.codecopy, .codefold):hover, .codeblk :is(.codecopy, .codefold):focus-visible,
.plugin-action:hover, .plugin-action:focus-visible { color: var(--doc-accent);
  background: color-mix(in srgb, currentColor 8%, transparent); }
.codeblk .codecopy .ic-ok { display: none; }
.codeblk .codecopy.ok .ic-copy { display: none; }
.textfile-unavailable { margin: 0; padding: 12px; color: var(--doc-fg-2); font-size: 12px; }
.textfile.unavailable .codeblk-head { cursor: default; }
.codeblk .codecopy.ok .ic-ok { display: block; color: var(--doc-ok); }
table { border-collapse: collapse; }
th, td { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); padding: 4px 10px; }
th { text-align: start; }
article thead th { background: var(--doc-bg-2); color: var(--doc-fg-2); font-weight: 500; }
.data-table { position: relative; min-width: 0; width: 100%; margin: 12px 0; }
.data-table button { color: inherit; background: transparent; font: inherit; cursor: pointer; }
.data-table button:focus-visible, .data-table-scroll:focus-visible { outline: 2px solid var(--doc-accent); outline-offset: -2px; }
.data-table-scroll { overflow: auto; max-height: min(480px, 65vh); border: 1px solid var(--doc-border); border-radius: 8px; box-sizing: border-box; }
.data-table-resize { position: absolute; bottom: -5px; left: 8px; right: 8px; height: 10px; z-index: 3; cursor: ns-resize; touch-action: none; }
.data-table-resize::after { content: ""; position: absolute; top: 4px; left: calc(50% - 14px); width: 28px; height: 2px; background: var(--doc-border-2); border-radius: 2px; }
.data-table-resize:hover::after, .data-table-resize:focus-visible::after { background: var(--doc-accent); }
.data-table-resize:focus-visible { outline: 2px solid var(--doc-accent); border-radius: 4px; }
.data-table table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; line-height: 1.4; }
.data-table :is(th, td) { border: 0; border-bottom: 1px solid color-mix(in srgb, var(--doc-border) 65%, transparent); padding: 5px 12px; text-align: left; white-space: pre-wrap; min-width: 90px; max-width: 480px; overflow-wrap: anywhere; }
.data-table thead th { position: sticky; top: 0; z-index: 2; background: var(--doc-bg-2, var(--doc-bg)); color: var(--doc-fg-2); font-size: 12px; font-weight: 500; }
.data-table[data-table-mode="header"] thead th { border-bottom: 3px double var(--doc-border-2); }
.data-table thead th:has(button) { padding: 0; }
.data-table thead button { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; text-align: left; padding: 5px 12px; border: 0; font-weight: inherit; }
.data-table th:first-child { min-width: 24px; width: 24px; color: var(--doc-fg-3); font-size: 11px; font-weight: 400; text-align: right; font-variant-numeric: tabular-nums; }
.data-table-sort-mark { flex: none; opacity: 0; }
.data-table thead button:is(:hover, :focus-visible) .data-table-sort-mark { opacity: .5; }
.data-table th[aria-sort] { color: var(--doc-accent); }
.data-table th[aria-sort] .data-table-sort-mark { opacity: 1; }
.data-table tbody tr:last-child > * { border-bottom: 0; }
.data-table tbody tr:hover { background: color-mix(in srgb, var(--doc-fg) 3%, transparent); }

article a { color: var(--doc-accent); }
.ph { border: 1px dashed color-mix(in srgb, currentColor 40%, transparent);
  border-radius: 8px; padding: 18px; text-align: center; margin: 16px 0; }
.ph span { opacity: .5; font-size: 13px; }
.cap { opacity: .7; font-size: 13px; margin-top: 6px; white-space: pre-line; }
.callout { border: 1px solid var(--doc-border); border-radius: 8px; padding: 8px 14px; margin: 10px 0;
  background: color-mix(in srgb, var(--doc-accent) 3%, var(--doc-bg-2)); overflow-wrap: anywhere; }
.callout-title { display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
  color: var(--doc-fg); font-size: 13px; font-weight: 650; line-height: 1.5; }
.callout-title::before { content: ""; flex: none; width: 18px; height: 2px; background: var(--doc-accent); }
.callout-body { color: var(--doc-fg-2); font-size: 14px; line-height: 1.5; }
.callout-body > p { margin: 6px 0; }
.callout-body > p:first-child { color: var(--doc-fg); font-size: 15px; }
.callout-body > :is(ul, ol) { display: grid; gap: 2px; margin: 6px 0; padding-left: 20px; }
.callout-body > :is(ul, ol) > li { padding-left: 4px; }
.callout-body > :is(ul, ol) > li::marker { color: var(--doc-accent); }
.callout-body > :first-child { margin-top: 0; }
.callout-body > :last-child { margin-bottom: 0; }
.errors { border: 1px solid var(--doc-danger); border-radius: 8px; padding: 10px 16px;
  margin-bottom: 16px; color: var(--doc-danger); font-size: 13px; }
.doc-title { display: flex; align-items: baseline; gap: 12px; max-width: calc(100% - 100px); padding-top: 8px; margin-bottom: 2px; }
.doc-title > h1 { min-width: 0; margin: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.in-toc { min-width: 28px; max-width: 100%; }
.toc-current { position: relative; display: block; max-width: min(240px, 100%); padding: 4px 20px 4px 6px;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis; border: 0; border-radius: 4px;
  background: transparent; color: var(--doc-fg-2); font: 12px/20px var(--font-sans); text-align: left; cursor: pointer; }
.toc-current::after { content: ""; position: absolute; right: 6px; top: 10px; width: 5px; height: 5px;
  border-right: 1px solid currentColor; border-bottom: 1px solid currentColor; transform: rotate(45deg); }
.toc-current:hover, .toc-current[aria-expanded="true"] { background: var(--c-raised); color: var(--doc-accent); }
.toc-options { position: fixed; margin: 0; padding: 6px; max-height: min(420px, calc(100dvh - 60px)); overflow: auto;
  list-style: none; border: 1px solid var(--doc-border); border-radius: 6px; background: var(--doc-bg); color: var(--doc-fg);
  box-shadow: 0 8px 24px var(--c-shadow); }
.in-toc a { display: block; padding: 7px 10px; border-radius: 4px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  text-decoration: none; font: 12px/1.5 var(--font-sans); color: var(--doc-fg-2); }
.in-toc .lvl2 a { padding-left: 20px; }
.in-toc .lvl3 a { padding-left: 30px; }
.in-toc a:hover, .in-toc a[aria-current] { color: var(--doc-accent); background: color-mix(in srgb, var(--doc-accent) 8%, transparent); }
.doc-title:has(.toc-card) { display: block; max-width: none; }
.doc-title:has(.toc-card) > h1 { max-width: calc(100% - 100px); }
.toc-card { margin: 10px 0 14px; padding: 10px; border: 1px solid var(--doc-border); border-radius: 6px; }
.toc-card::before { content: attr(aria-label); display: block; margin: 0 10px 6px; color: var(--doc-fg-3); font: 12px/1.5 var(--font-sans); }
.toc-card .toc-current { display: none; }
.toc-card .toc-options { position: static; padding: 0; border: 0; background: transparent; box-shadow: none; }
main :is(h1, h2, h3)[id] { scroll-margin-top: 52px; }
article strong { font-weight: 700; }
article em { font-style: italic; }
article blockquote { margin: 16px 0; padding: 4px 16px; border-left: 3px solid var(--doc-border-2); color: var(--doc-fg-2); }
article blockquote > :first-child { margin-top: 0; }
article blockquote > :last-child { margin-bottom: 0; }
ul.idx { list-style: none; padding: 0; }
ul.idx li { margin: 10px 0; }
details summary { cursor: pointer; opacity: .8; }
/* Figure and term file links show previews on hover. */
.figref, .dictref { color: var(--doc-accent-2); text-decoration: none;
  border-bottom: 1px dotted currentColor; position: relative; cursor: pointer; }
.figref .figpop, .dictref .dictpop { display: none; position: absolute; left: 50%;
  transform: translateX(-50%); top: calc(100% + 6px); z-index: 5;
  width: min(560px, 78vw); padding: 12px 14px;
  background: var(--doc-panel); border: 1px solid var(--doc-border);
  border-radius: 8px; box-shadow: 0 4px 16px color-mix(in srgb, var(--doc-fg) 18%, transparent);
  color: var(--doc-fg); font-size: 13px; line-height: 1.7; }
.figref:hover .figpop, .figref:focus-visible .figpop, .dictref:hover .dictpop { display: block; }
.figpop svg { max-width: 100%; height: auto; display: block; }
.figpop .fig-frame { width: 100% !important; }
.dictref .dictpop { width: min(420px, 70vw); }
.dictpop-description { display: block; margin-top: 8px; padding-top: 8px;
  border-top: 1px solid var(--doc-border); color: var(--doc-fg-3); font-size: 12px; }
.dictref:focus-visible .dictpop { display: block; }
.terms { margin: 18px 0; }
.terms .dict-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; color: var(--doc-fg-3); font-size: 12px; }
.terms .dict-toolbar label { display: flex; align-items: center; gap: 8px; }
.terms select { font: inherit; color: var(--doc-fg); background: var(--doc-panel); border: 1px solid var(--doc-border); border-radius: 4px; padding: 4px 8px; }
.terms .dict { display: grid; gap: 8px; margin: 0; }
.terms .dict-card { margin: 0; padding: 0 12px 6px; border: 1px solid var(--doc-border);
  border-radius: 4px; min-width: 0; overflow-wrap: anywhere; }
.terms legend { display: flex; align-items: center; gap: 6px; max-width: 100%; padding: 0 4px; font-size: 15px; font-weight: 600;
  line-height: 1.5; color: var(--doc-fg); scroll-margin-top: 16px; }
.terms .term-definition { margin: 2px 0 0; font-size: 13.5px;
  line-height: 1.6; white-space: pre-line; }
.terms .dict-card:has(:target) { border-color: var(--doc-accent-2); }
.terms .term-icon { flex: none; color: var(--doc-fg-3); }
.terms .term-name { position: relative; min-width: 0; text-decoration: none; overflow-wrap: anywhere; }
.terms .term-name:hover { text-decoration: underline; text-underline-offset: 3px; }
.terms .term-description { display: none; position: absolute; left: 0; top: 100%; z-index: 6;
  width: max-content; max-width: min(360px, calc(100vw - 96px)); box-sizing: border-box;
  padding: 10px 14px; margin-top: 8px; border: 1px solid var(--doc-border); border-radius: 6px;
  background: var(--doc-panel); color: var(--doc-fg); font-family: var(--font-sans);
  font-size: 13px; font-weight: 400; line-height: 1.7; white-space: pre-line;
  box-shadow: 0 4px 16px color-mix(in srgb, var(--doc-fg) 12%, transparent); }
.terms .term-description::before { content: ""; position: absolute; left: 0; right: 0; top: -9px; height: 9px; }
.terms .term-name:hover .term-description,
.terms .term-name:focus .term-description { display: block; }

.extensions-header { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 12px 0 6px; }
.extensions-header h1 { margin: 0 auto 0 0; font-size: 18px; }
.extensions-description, .extension-info small { color: var(--c-fg-muted); font-size: 12px; }
.extensions-description { margin: 0 0 12px; }
.extensions-notice { color: var(--c-danger); white-space: pre-wrap; font-size: 12px; }
.extensions-notice:empty { display: none; }
.extension-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 0; border-top: 1px solid var(--c-line); }
.extension-info { flex: 1; min-width: 180px; overflow-wrap: anywhere; }
.extension-info strong { font-size: 13px; font-weight: 500; }
.extension-version { margin-left: 8px; color: var(--c-fg-muted); font-size: 11px; }
.extension-info small { display: block; margin-top: 3px; }
.extension-accounts { width: 100%; display: grid; gap: 4px; font-size: 12px; color: var(--c-fg-muted); }
.extension-accounts .extension-actions { align-items: center; }
.extension-actions { display: flex; gap: 6px; }
.extension-button, .extension-editor select { padding: 4px 8px; border: 1px solid var(--c-line); border-radius: 4px; color: var(--c-fg); background: var(--c-bg1); font: inherit; font-size: 12px; cursor: pointer; }
.extension-button:hover { background: var(--c-raised); }
.extension-button:disabled { opacity: .5; cursor: default; }
.extension-editor { border-top: 1px solid var(--c-line); margin-top: 12px; padding-top: 4px; }
.extension-editor .extensions-header { font-size: 12px; }
.extension-editor select { min-width: 0; max-width: 100%; margin-left: auto; }
.extension-editor textarea { display: block; box-sizing: border-box; width: 100%; min-height: 320px; margin: 8px 0; padding: 10px; border: 1px solid var(--c-line); border-radius: 4px; background: var(--c-bg1); color: var(--c-fg); font: 12px/1.6 var(--font-mono); tab-size: 2; resize: vertical; }
.extension-icon { position: relative; flex: none; display: grid; place-items: center; width: 40px; height: 40px; color: var(--c-fg-muted); }
.extension-icon > :is(svg, img) { width: 32px; height: 32px; object-fit: contain; }
.extension-icon > img { position: absolute; inset: 4px; }
.extension-icon:has(img) > svg { visibility: hidden; }
.extensions-dropzone { position: relative; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 28px 16px; margin: 16px 0; border: 1px dashed var(--c-fg-faint); border-radius: 8px; color: var(--c-fg-muted); font-size: 12px; cursor: pointer; }
.extensions-dropzone strong { color: var(--c-fg); font-size: 14px; font-weight: 500; }
.extensions-dropzone input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.extensions-dropzone:focus-within { outline: 2px solid var(--c-accent); outline-offset: 2px; }
.extensions-dropzone:has(input:disabled) { opacity: .5; }
body.extensions-over #nav-extensions, body.extensions-over .extensions-dropzone { outline: 1px solid var(--c-accent); outline-offset: -1px; background: var(--c-raised); }


.resource-library { width: 100%; max-width: none; }
.git-page { padding-top: 8px; font: 12px/1.55 var(--font-sans); }
.git-controls { min-width: 0; margin: 0; padding: 0; border: 0; }
.git-toolbar, .git-actions, .git-branches { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-height: 30px; }
.git-toolbar { border-bottom: 1px solid var(--c-line); margin: 4px 0 8px; padding-inline: 6px; }
.git-toolbar strong { font-size: 13px; font-weight: 500; }
.git-branches { gap: 12px; margin-bottom: 8px; }
.git-branches > form { flex: 1; }
.git-branches input { width: 150px; flex: 1; }
.git-actions { margin: 6px 0; }
.git-page :is(input:not([type=checkbox]), textarea, select) { box-sizing: border-box; min-width: 0; max-width: 100%; border: 1px solid var(--c-line); border-radius: 4px; padding: 4px 8px; background: var(--c-bg1); color: var(--c-fg); font: inherit; }
.git-page :is(input:not([type=checkbox]), select) { height: 28px; }
.git-branches :is(input, select), .git-actions select { border-color: transparent; background: transparent; }
.git-page :is(input, textarea, select):focus-visible { outline: 1px solid var(--c-fg-muted); outline-offset: -1px; }
.git-page select option { background: var(--c-bg1); color: var(--c-fg); }
.git-page .git-text-button { width: auto; padding: 0 8px; font: inherit; }
.git-page .pbtn:disabled { opacity: .45; cursor: default; }
.git-page .pbtn:disabled:hover { background: transparent; color: var(--c-fg-muted); }
.git-page .resource-item > summary .pbtn { width: 24px; height: 24px; }
.git-field { display: flex; flex-direction: column; gap: 4px; color: var(--c-fg-muted); }
.git-field textarea { resize: vertical; }
.git-form { display: flex; flex-direction: column; gap: 8px; }
.git-form > button { align-self: flex-start; }
.git-commit { margin: 10px 0 18px; }
.git-commit textarea { height: 54px; }
.git-caption, .git-notice { margin: 6px 0; font-size: 11px; color: var(--c-fg-muted); white-space: pre-wrap; overflow-wrap: anywhere; }
.git-notice:empty { display: none; }
.git-status { width: 2ch; flex: none; white-space: pre; color: var(--c-fg-muted); }
.git-diff { max-height: 320px; overflow: auto; padding: 8px; background: var(--c-surface); font: 11px/1.6 var(--editor-font, ${MONO_FONT}); }
.git-checkbox { display: flex; align-items: center; gap: 6px; }
.resource-tabs { display: flex; gap: 4px; overflow-x: auto; border-bottom: 1px solid var(--doc-border); margin-bottom: 18px; }
.resource-tabs a { padding: 9px 15px; color: var(--doc-fg-3); text-decoration: none; white-space: nowrap; font-size: 13px; border-bottom: 2px solid transparent; }
.resource-tabs a:hover { color: var(--doc-fg); background: color-mix(in srgb, var(--doc-fg) 4%, transparent); }
.resource-tabs a[aria-current] { color: var(--doc-accent); border-bottom-color: currentColor; }
.resource-toolbar { position: relative; display: flex; align-items: center; gap: 10px; height: 30px; padding: 0 6px;
  border-bottom: 1px solid var(--c-line); color: var(--c-fg-muted); font-size: 11px; }
.resource-toolbar > span { flex: none; }
.resource-search {display:flex;align-items:center;gap:5px;flex:0 1 140px;min-width:0;height:24px;border-bottom:1px solid transparent;color:var(--c-fg-faint);}
.resource-search > svg {flex:none;width:13px;height:13px;}
.resource-search input {min-width:0;width:100%;height:22px;padding:0;border:0;border-radius:0;background:transparent;color:var(--c-fg);font:inherit;}
.resource-search input::placeholder {color:var(--c-fg-faint);}
.resource-search:focus-within {border-bottom-color:var(--c-accent);color:var(--c-fg-muted);}
.resource-search input:focus-visible {outline:none;}
.resource-toolbar select { flex: 0 1 auto; min-width: 50px; max-width: 110px; height: 24px; padding: 0 4px;
  border: 0; border-radius: 0; background: transparent; color: var(--c-fg-muted); font: inherit; }
.resource-toolbar select option { background: var(--c-bg1); color: var(--c-fg); }
.resource-count { margin-left: auto; color: var(--doc-fg-3); font-variant-numeric: tabular-nums; }
.resource-items { display: flex; flex-direction: column; }
.resource-items[hidden], [data-subformat-board][hidden] { display: none; }
.resource-results:has([data-subformat-board]:not([hidden])) { min-width: 0; font-family: var(--font-sans); }
.resource-results:has([data-subformat-board]:not([hidden])) .resource-toolbar { position: relative; height: auto; flex-wrap: wrap; gap: 8px 12px; padding: 8px 0 12px; }
.resource-results:has([data-subformat-board]:not([hidden])) .resource-toolbar > [data-i18n="Name"] { display: none; }
.resource-results:has([data-subformat-board]:not([hidden])) .resource-search { flex: 1 1 160px; max-width: 260px; height: 30px; box-sizing: border-box; gap: 8px; padding: 0 8px; border: 1px solid var(--c-line); border-radius: 4px; background: var(--c-bg0); }
.resource-results:has([data-subformat-board]:not([hidden])) .resource-search:focus-within { border-color: var(--c-accent); }
.resource-results:has([data-subformat-board]:not([hidden])) .resource-count { display: none; }
.resources-pane:has([data-subformat-board]:not([hidden])) :is(.preview-content, .resource-library, .resource-results, [data-subformat-board]) { display: flex; flex-direction: column; flex: 1; }
.resources-pane:has([data-subformat-board]:not([hidden])) .preview-content { min-height: 100%; }
.resource-results:has(> .resource-empty:not([hidden])) [data-subformat-board] { flex: none; }
.resource-results:has(> .resource-empty:not([hidden])) .subformat-columns { display: none; }
.resource-query { display: flex; align-items: center; gap: 8px; flex: 0 1 auto; min-width: 0; max-width: 400px; }
.resource-query > select { flex: 0 1 auto; min-width: 64px; max-width: 140px; height: 30px; padding: 4px 8px; border: 1px solid var(--c-line); border-radius: 4px; background: var(--c-bg1); color: var(--c-fg); cursor: pointer; }
.resource-query > select:focus-visible { outline-color: var(--c-fg-muted); }
.subformat-picker { flex: 0 1 auto; min-width: 0; max-width: 220px; }
[data-subformat-trigger] { display: block; max-width: 100%; height: 32px; padding: 0 2px; border: 0; border-bottom: 1px solid var(--c-line); background: transparent; color: var(--c-fg); font: 500 18px/30px var(--font-sans); text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
[data-subformat-trigger]:is(:hover, :focus-visible) { border-bottom-color: var(--c-fg-muted); outline: none; }
[data-subformat-trigger]:disabled { cursor: default; }
.subformat-picker-menu { position: fixed; margin: 0; box-sizing: border-box; width: min(260px, calc(100vw - 16px)); padding: 4px; border: 1px solid var(--c-line); border-radius: 4px; background: var(--c-bg1); color: var(--c-fg); overflow-y: auto; font: 15px/1.6 var(--font-sans); }
.subformat-picker-menu button { display: block; width: 100%; padding: 7px 10px; border: 0; background: transparent; color: var(--c-fg); font: inherit; text-align: left; overflow-wrap: anywhere; cursor: pointer; }
.subformat-picker-menu button:is(:hover, :focus-visible, [aria-checked="true"]) { background: var(--c-raised); outline: none; }
.subformat-picker-menu [data-subformat-add] { margin-top: 4px; border-top: 1px solid var(--c-line); font-size: 13px; }
.subformat-picker-option { display: flex; }
.subformat-picker-option > button:first-child { flex: 1; min-width: 0; }
.subformat-picker-option > [data-subformat-action] { flex: none; display: grid; place-items: center; width: 32px; padding: 0; }
.subformat-picker-option > [data-subformat-action="delete"] { color: var(--c-danger); }
.subformat-picker-option > button:disabled { opacity: .55; cursor: default; }

.resource-results [data-subformat-change="added"] { color: var(--c-ok); }
.resource-results [data-subformat-change="modified"] { color: var(--c-accent); }
.subformat-controls { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 12px; min-width: 0; max-width: 100%; margin-left: auto; }
.subformat-control { position: relative; min-width: 80px; max-width: 160px; margin-top: 6px; }
.subformat-control-label { position: absolute; z-index: 1; top: -7px; left: 7px; padding: 0 4px; background: var(--c-bg1); color: var(--c-fg-muted); font: 11px/14px var(--font-sans); white-space: nowrap; pointer-events: none; }
.subformat-control > button { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; min-height: 34px; padding-top: 6px; text-align: left; }
.subformat-control > button > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.subformat-control > button > svg { flex: none; }
.subformat-setting-menu { font-size: 13px; }
.subformat-setting-option { display: flex; align-items: stretch; }
.subformat-setting-option > button:first-child { flex: 1; min-width: 0; max-width: none; border: 0; border-radius: 0; text-align: left; background: transparent; }
.subformat-setting-option > button[aria-checked="true"] { background: var(--c-raised); }
.subformat-setting-option > .subformat-default { display: grid; flex: none; place-items: center; width: 32px; padding: 0; border: 0; border-radius: 0; background: transparent; color: var(--c-fg-muted); }
.subformat-default[data-is-default="false"] svg { opacity: .25; }
.subformat-default[data-is-default="true"], .subformat-default:is(:hover, :focus-visible) { color: var(--c-fg); }
.subformat-setting-option > .subformat-default[data-layout-changed="true"] { color: var(--c-ok); }
.subformat-default:is(:hover, :focus-visible) svg { opacity: 1; }
.subformat-default:disabled { cursor: default; }
.subformat-controls label { display: flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; white-space: nowrap; }
.subformat-card label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--c-fg-muted); }
.subformat-controls select, .subformat-controls button, .subformat-create-form select, .subformat-create-form button, .subformat-card select { box-sizing: border-box; min-width: 0; max-width: 100%; min-height: 30px; padding: 4px 8px; border: 1px solid var(--c-line); border-radius: 4px; background: var(--c-bg1); color: var(--c-fg); font: inherit; }
.subformat-controls select { max-width: 140px; }
.subformat-controls [data-subformat-direction] { display: grid; place-items: center; flex: none; width: 30px; height: 30px; padding: 0; }
.subformat-controls :is(select, button) { cursor: pointer; }
.subformat-controls :is(select, button):hover, .subformat-card select:enabled:hover { background: var(--c-raised); }
.subformat-controls :is(select, button):focus-visible, .subformat-card select:focus-visible { outline-color: var(--c-fg-muted); }
.subformat-card select:disabled { opacity: .55; cursor: default; }
.subformat-toast { position: fixed; z-index: 1000; right: 20px; bottom: 20px; box-sizing: border-box;
  max-width: min(420px, calc(100vw - 40px)); max-height: 40vh; overflow: auto; padding: 12px 16px;
  border: 1px solid var(--c-danger); border-radius: 6px; background: var(--c-bg1); color: var(--c-danger);
  font: 13px/1.5 var(--font-sans); white-space: pre-wrap; overflow-wrap: anywhere; }
.subformat-columns { display: flex; flex: 1; gap: 20px; min-width: 0; overflow-x: auto; padding: 16px 2px 12px; scrollbar-width: thin; scrollbar-color: var(--c-line) transparent; }
.subformat-column { display: flex; flex-direction: column; flex: 1 0 248px; min-width: 0; }
.subformat-cards { flex: 1; min-height: 100px; border-radius: 6px; transition: background-color 100ms ease-out; }
.subformat-cards.is-drop-target { background: var(--c-raised); }
.subformat-column > h2 { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; padding: 0 2px 10px; border-bottom: 1px solid var(--c-line); color: var(--c-fg); font: 500 12px/20px var(--font-sans); overflow-wrap: anywhere; }
.subformat-count > span { flex: none; min-width: 10px; padding: 0 5px; border-radius: 4px; background: var(--c-raised); color: var(--c-fg-muted); font-size: 11px; line-height: 18px; text-align: center; font-variant-numeric: tabular-nums; }
.subformat-card { max-width: none; margin: 0 0 12px; padding: 14px; border: 1px solid var(--c-line); border-radius: 6px; background: transparent; color: var(--c-fg); font-family: var(--font-sans); overflow-wrap: anywhere; }
.subformat-card:hover, .subformat-card:focus-within { border-color: var(--c-fg-faint); }
.subformat-count { display: inline-flex; align-items: center; gap: 4px; }
.resource-results [data-record-change="added"] { --record-color: var(--c-ok); }
.resource-results [data-record-change="modified"] { --record-color: var(--c-accent); }
.resource-results span[data-record-change] { color: var(--record-color); }
.subformat-card[data-record-change] { border-color: var(--record-color); }
.subformat-controls [data-subformat-create] { height: 30px; padding-inline: 12px; }
.subformat-create-form { position: absolute; z-index: 5; top: calc(100% + 8px); right: 0; box-sizing: border-box; width: min(420px, 100%); max-height: 70vh; overflow: auto; padding: 16px; border: 1px solid var(--c-line); border-radius: 6px; background: var(--c-bg1); }
.subformat-create-form fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
.subformat-create-form label { display: flex; flex-direction: column; align-items: stretch; gap: 6px; margin-bottom: 12px; }
.subformat-create-form :is(input, textarea) { box-sizing: border-box; width: 100%; min-width: 0; padding: 8px; border: 1px solid var(--c-line); border-radius: 4px; background: var(--c-bg0); color: var(--c-fg); font: 12px/1.6 var(--doc-mono); }
.subformat-create-form :is(input, textarea, select, button):focus-visible { outline-color: var(--c-fg-muted); }
.subformat-create-form textarea { resize: vertical; }
.subformat-create-actions { display: flex; justify-content: flex-end; gap: 8px; }
.subformat-card[draggable="true"] { cursor: grab; user-select: none; }
.subformat-card[draggable="true"] :is(.subformat-card-open, .subformat-card-toggle) { cursor: inherit; }
.subformat-card.is-dragging { visibility: hidden; }
.subformat-card-tools { display: flex; align-items: center; justify-content: flex-end; gap: 8px; box-sizing: border-box; width: fit-content; max-width: 100%; height: 20px; margin: -25px -4px 8px auto; padding: 0 6px; background: var(--c-bg1); }
.subformat-card h3 { min-width: 0; margin: 0; font-size: 13px; line-height: 1.55; }
.subformat-card-open, .subformat-card-toggle, .subformat-card-copy { padding: 0; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
.subformat-card :focus-visible { outline-color: var(--c-fg-muted); }
.subformat-card .subformat-card-open:focus { outline: none; }
.subformat-card-open:focus-visible { text-decoration: underline; text-underline-offset: 3px; }
.subformat-card-open { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; text-align: left; font-weight: 500; overflow-wrap: anywhere; }
.subformat-card-toggle, .subformat-card-copy { flex: none; display: grid; place-items: center; width: 20px; height: 20px; margin: 0; border-radius: 4px; color: var(--c-fg-muted); }
.subformat-card-toggle:hover, .subformat-card-copy:hover { background: var(--c-raised); color: var(--c-fg); }
.subformat-card-copy .ic-ok, .subformat-card-copy[data-copied] svg:not(.ic-ok) { display: none; }
.subformat-card-copy[data-copied] .ic-ok { display: block; }
.subformat-card-toggle[aria-expanded="true"] svg { transform: rotate(180deg); }
.subformat-card .subformat-card-file { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-fg-faint); font-family: var(--doc-mono); font-size: 11px; }
.subformat-card-tools .subformat-card-file { flex: 1; max-width: 170px; }
.subformat-card-references { padding: 2px 0; border: 0; background: none; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; flex: none; color: var(--record-color, var(--c-fg-faint)); font-size: 11px; font-variant-numeric: tabular-nums; }
.subformat-card-references:disabled { cursor: default; }
.subformat-reference-list { position: fixed; margin: 0; box-sizing: border-box; width: min(320px, calc(100vw - 16px)); padding: 4px; border: 1px solid var(--c-line); border-radius: 4px; background: var(--c-bg1); color: var(--c-fg); overflow-y: auto; font: 12px/1.6 var(--font-sans); }
.subformat-reference-list ul { margin: 0; padding: 0; list-style: none; }
.subformat-reference-list a { display: flex; align-items: baseline; gap: 12px; padding: 7px 8px; color: inherit; text-decoration: none; }
.subformat-reference-list a > span:first-child { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.subformat-reference-list a > span:last-child { flex: none; color: var(--c-fg-muted); font-variant-numeric: tabular-nums; }
.subformat-reference-list a:is(:hover, :focus-visible) { background: var(--c-raised); outline-color: var(--c-fg-muted); }
.subformat-card dl { margin: 12px 0 0; font-size: 12px; }
.subformat-card dt, .subformat-detail dt { color: var(--c-fg-muted); font-size: 11px; }
.subformat-card dd, .subformat-detail dd { margin: 4px 0 0; }
.subformat-card-meta { display: flex; flex-wrap: wrap; gap: 12px 16px; padding-top: 12px; border-top: 1px solid var(--c-line-soft); }
.subformat-card-meta:empty { display: none; }
.subformat-card-meta > div { flex: 1 1 auto; min-width: 0; max-width: 100%; }
.subformat-card-meta dd { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.subformat-card-details { margin-top: 12px; border-top: 1px solid var(--c-line-soft); }
.subformat-card-details dl { display: grid; gap: 12px; }
.subformat-card-details dd, .subformat-detail dd { white-space: pre-wrap; overflow-wrap: anywhere; }
.subformat-card-details label { margin-top: 12px; }
.subformat-card [hidden] { display: none; }
.subformat-drag-preview { position: fixed; z-index: 1000; box-sizing: border-box; pointer-events: none; background: var(--c-bg1); will-change: transform; }
.app-dialog { width: min(460px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 22px;
  color: var(--c-fg); background: color-mix(in srgb, var(--c-bg1) 90%, transparent);
  border: 1px solid var(--c-fg-faint); border-radius: 10px; box-shadow: 0 16px 48px #0004; backdrop-filter: blur(16px); }
.app-dialog::backdrop { background: #0005; backdrop-filter: blur(2px); }
.app-dialog h2 { margin: 0 0 14px; font-size: 16px; overflow-wrap: anywhere; }
.app-dialog p { margin: 0 0 22px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--c-fg-muted); }
.dialog-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.app-dialog button { padding: 7px 14px; color: inherit; background: var(--c-bg0); border: 1px solid var(--c-line); border-radius: 5px; cursor: pointer; }
.app-dialog button:hover { background: var(--c-raised); border-color: var(--c-fg-muted); }
.app-dialog button:focus-visible { outline-color: var(--c-fg-muted); }
.app-dialog button.danger { color: var(--c-danger); }
.subformat-page-name { display: block; box-sizing: border-box; width: 100%; margin: 8px 0 20px; padding: 8px; color: var(--c-fg); background: var(--c-bg0); border: 1px solid var(--c-line); border-radius: 4px; font: inherit; }
.subformat-page .resource-query { flex-wrap: wrap; max-width: none; }
.subformat-page-title { flex: 1 1 100%; margin: 0 0 12px; color: var(--c-fg); font: 500 24px/1.3 var(--font-sans); overflow-wrap: anywhere; }
.subformat-page .resource-toolbar { align-items: flex-end; }
.subformat-page .subformat-columns { padding-top: 20px; }
body:not(.edit) .subformat-page { padding-top: 64px; }
.subformat-detail-path { color: var(--c-fg-muted); font: 11px var(--doc-mono); overflow-wrap: anywhere; }
.subformat-detail dl { display: grid; gap: 14px; margin: 20px 0; }
.subformat-detail dt { font-size: 12px; }
.resource-item { min-width: 0; margin: 0; padding: 0; border: 0; }
.resource-item[hidden], .resource-empty[hidden] { display: none; }
.resource-item > summary { display: flex; align-items: center; gap: 8px; min-width: 0; height: 28px; padding: 0 6px;
  list-style: none; color: var(--doc-fg); font-size: 13px; cursor: pointer; }
.resource-item > summary::-webkit-details-marker { display: none; }
.resource-item > summary::before { content: ""; flex: none; width: 5px; height: 5px; margin: 0 4px 0 2px;
  border-right: 1px solid var(--c-fg-faint); border-bottom: 1px solid var(--c-fg-faint); transform: rotate(-45deg); }
.resource-item[open] > summary::before { transform: rotate(45deg); }
.resource-item > summary:hover { background: var(--c-surface); }
.resource-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.resource-item a.resource-name { color: inherit; text-decoration: none; }
.resource-item a.resource-name:hover { color: var(--doc-accent); text-decoration: underline; }
.resource-body { min-width: 0; padding: 6px 8px 10px 24px; }
.resource-source { display: inline-flex; align-items: baseline; gap: 6px; min-width: 0; max-width: 100%;
  overflow: hidden; white-space: nowrap; color: var(--doc-fg-3); font-family: var(--doc-mono); font-size: 11px; text-decoration: none; }
.resource-item > summary > .resource-source { margin-left: auto; max-width: 50%; }
.resource-source:hover { color: var(--doc-accent); text-decoration: underline; }
.resource-source span { flex: none; opacity: .7; }
.resource-source .resource-source-file { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; opacity: 1; }
.resource-badge { flex: none; color: var(--doc-fg-2); font: 11px var(--doc-mono); }
.resource-item .codeblk { margin: 0; }
.resource-item .codeblk > pre { max-height: 260px; overflow: auto; }
.resource-usage { flex: none; margin-left: auto; color: var(--doc-fg-3); font-size: 11px; font-variant-numeric: tabular-nums; }
.resource-sources { display: flex; flex-direction: column; gap: 4px; }
.resource-empty { padding: 20px 6px; color: var(--doc-fg-3); font-size: 12px; }
.resource-errors { margin: 0 0 16px; color: var(--doc-danger); font-size: 12px; overflow-wrap: anywhere; }
.resource-errors summary { cursor: pointer; }
.resource-library .resource-tabs { margin-bottom: 8px; }
.resource-library .files-viewport { max-height: calc(100dvh - 76px); min-height: 0; }
.resource-library .files-table :is(th, td) { border: 0; }
.resource-library .files-table thead th { position: sticky; top: 0; z-index: 1; border-bottom: 1px solid var(--c-line); background: var(--c-bg1); font-size: 11px; color: var(--c-fg-muted); font-weight: 500; }
@media(max-width:600px) { .resource-tabs a { padding-inline: 10px; } .resource-toolbar { gap: 8px; } }
`;

// edit mode only (right panel / new doc form). Uses the viewer's shared background / rules and
// button / input styles. To keep CM as wide as possible the fm is compact, and the toggles
// (autosave / correspondence display / fm visibility) are gathered in the header gear's hover
// menu. Width is drag-resizable.
const EDIT_CSS = `
body.line-wrap-off .cm-content { white-space: pre; }
body.git-diff-hidden .cm-lineNumbers :is(.cm-git-added, .cm-git-modified, .cm-git-deleted-start, .cm-git-deleted-end) { box-shadow: none; }
body.git-diff-hidden .cm-line:is(.cm-git-added, .cm-git-modified, .cm-git-deleted-start, .cm-git-deleted-end) { background-color: transparent; }
#site-title[role="button"] { cursor: text; position: relative; }
#site-title:focus-visible { outline: 1px solid var(--c-line); }
#site-title .nav-rename-form { inset: 0; padding: 0; }
#site-icon-slot input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
#site-icon-slot:hover, #site-icon-slot:focus-within, #sidebar-head.over #site-icon-slot { background: var(--c-line); border-radius: 3px; }
#site-icon-slot:focus-within, #sidebar-head.over #site-icon-slot { outline: 1px solid var(--c-fg-muted); outline-offset: 2px; }
body.sidebar-closed #site-icon-slot input { display: none; }
/* Right panel = header / properties / editor stacked on one surface, separated by rules (no
   nested frames). */
#panel { width: var(--panel-width, min(760px, 52vw)); flex-shrink: 0; position: sticky; top: 0; height: 100vh;
  display: flex; flex-direction: column; font-size: 12.5px; line-height: 1.6;
  border-left: 1px solid var(--c-line); background: var(--c-bg1); }
body.textfile-open #phead :is(.fm-language, #status, #validate, #save, #split-preview) { display: none; }
#file-editor { display: flex; flex-direction: column; flex: 1; min-height: 0; color: var(--doc-fg); background: var(--doc-bg); }
.file-editor-heading { display: flex; align-items: center; flex: 1; min-width: 0; gap: 6px; margin-left: 6px; color: var(--c-fg-muted); }
.file-editor-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--doc-mono); }
.file-editor-heading .cm-textfile-controls { display: inline-flex; align-items: center; flex: none; gap: 2px; }
.file-editor-heading .cm-textfile-save-status { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-editor-heading .cm-inline-fold { display: none; }
.file-editor-heading [hidden] { display: none; }
#file-editor > .cm-textfile { display: flex; flex-direction: column; flex: 1; min-height: 0; }
#file-editor .cm-textfile-editor { flex: 1; min-height: 0; }
#file-editor .cm-editor { height: 100%; }
#file-editor .cm-scroller { overflow: auto; }
#file-editor .cm-textfile-status { padding: 8px 12px; white-space: pre-wrap; }
#file-editor .cm-textfile-status[hidden] { display: none; }
#file-editor .cm-textfile-status.error { color: var(--doc-danger); }
#file-editor:is([data-subformat-register], [data-subformat-record]) { position: static; width: auto; max-height: none; padding: 0; border: 0; border-radius: 0; overflow: hidden; }
#file-editor:is([data-subformat-register], [data-subformat-record]) fieldset { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.subformat-register-fields { display: grid; flex: 1; min-width: 0; grid-template-columns: minmax(36px, .5fr) 60px minmax(50px, 1.5fr); gap: 6px; margin: 0; padding: 0; border: 0; }
.subformat-register-fields :is(input, select) { width: 100%; min-width: 0; height: 28px; padding: 4px; background: transparent; color: var(--c-fg); border: 0; border-bottom: 1px solid var(--c-line); border-radius: 0; font: 12px/18px var(--font-sans); }
.subformat-register-fields input:hover, .subformat-register-fields input:focus-visible { background: transparent; outline: none; border-bottom-color: var(--c-fg-muted); }
.subformat-register-fields .language-select { min-width: 0; }
.subformat-register-fields .subformat-control { align-self: center; min-width: 0; max-width: none; margin: 3px 0 0; }
.subformat-register-fields .subformat-control-label { top: -5px; left: 5px; padding: 0 3px; font-size: 9px; line-height: 10px; }
.subformat-register-fields .language-select-input { height: 24px; padding: 4px 18px 1px 6px; border: 1px solid var(--c-line); border-radius: 4px; background: var(--c-bg1); font-size: 11px; line-height: 16px; }
.subformat-register-fields .language-select::after { right: 6px; top: 9px; width: 4px; height: 4px; }
.subformat-register-fields :disabled { opacity: .5; }
.subformat-register-fields > input[name="file"] { grid-column: 1 / -1; }
.subformat-register-fields input::placeholder { color: var(--c-fg-muted); opacity: 1; }
.subformat-register-fields input[name="schema"]:not([placeholder="path"])::placeholder { opacity: .55; }
#phead:has(.subformat-register-fields) { padding-inline: 6px; }
.file-editor-heading:has(.subformat-register-fields) { gap: 4px; margin-left: 2px; }
[data-subformat-schema-editor] { flex: 1; min-height: 0; }
#file-editor:is([data-subformat-register], [data-subformat-record]) .subformat-create-actions { flex: none; padding: 10px 14px; border-top: 1px solid var(--c-line); }
#file-editor:is([data-subformat-register], [data-subformat-record]) [hidden] { display: none; }
.schema-editor-host { display: flex; flex-direction: column; min-height: 0; }
.schema-editor-host > .cm-editor { flex: 1; min-height: 0; }
.schema-editor-host > [hidden] { display: none !important; }
.schema-mode-switch:focus-visible { outline: 1px solid var(--c-fg-muted); outline-offset: 1px; }
.schema-builder { flex: 1; min-height: 0; overflow: auto; container-type: inline-size; padding: 8px 12px 24px; color: var(--c-fg); font: 12px/1.6 var(--font-sans); }
.schema-builder label { display: flex; align-items: stretch; flex-direction: column; gap: 4px; min-width: 0; margin: 0; color: var(--c-fg-muted); font-size: 11px; }
.schema-builder :is(input, select, textarea, button) { box-sizing: border-box; min-width: 0; min-height: 0; max-width: 100%; padding: 6px 7px; border: 1px solid var(--c-line); border-radius: 4px; background: var(--c-bg0); color: var(--c-fg); font: 12px/1.5 var(--font-sans); }
.schema-builder :is(input:not([type="checkbox"]), select, textarea) { padding: 4px 6px; border: 0; border-radius: 3px; background: var(--c-bg1); }
.schema-builder :is(input:not([type="checkbox"]), select, textarea):hover { background: var(--c-raised); }
.schema-builder :is(input:not([type="checkbox"]), select, textarea):focus-visible { outline: 1px solid var(--c-fg-muted); outline-offset: 1px; }
.schema-builder .schema-type-control { display: block; min-width: 0; max-width: none; margin: 0; }
.schema-builder .schema-type-control .language-select-input { height: 28px; padding: 5px 22px 2px 8px; border: 1px solid var(--c-line); border-radius: 4px; background: var(--c-bg1); }
.schema-type-control .language-select::after { right: 8px; top: 10px; width: 5px; height: 5px; }
.schema-builder .schema-type-control > .subformat-control-label { padding: 0 4px; }
.schema-builder :is(input, textarea) { width: 100%; }
.schema-builder textarea { resize: vertical; }
.schema-builder input[type="checkbox"] { flex: none; width: 14px; height: 14px; margin: 0; padding: 0; border-color: var(--c-fg-muted); border-radius: 3px; background: transparent; }
.schema-builder input[type="checkbox"]:checked { border-color: var(--c-fg-muted); }
.schema-builder input[type="checkbox"]:checked::after { left: 4px; top: 1px; width: 3px; height: 7px; border-color: var(--c-fg); border-width: 0 1.5px 1.5px 0; }
.schema-builder input[type="checkbox"]:focus-visible { outline: 1px solid var(--c-fg-muted); outline-offset: 3px; }
.schema-builder button { cursor: pointer; }
.schema-builder button:hover { background: var(--c-raised); }
.schema-builder button:disabled { opacity: .45; cursor: default; }
.schema-field { position: relative; min-width: 0; }
.schema-builder > :is(.schema-field, .schema-add-field, .schema-draft-details) { max-width: 560px; }
.schema-builder > .schema-field { margin-bottom: 12px; }
.schema-root-settings { max-width: 560px; margin-block: 12px; }
.schema-root-settings > summary { cursor: pointer; }
.schema-field-row, .schema-add-field { position: relative; display: grid; grid-template-columns: minmax(0, 260px) 112px minmax(128px, 1fr); align-items: center; gap: 8px; padding: 6px 0 2px; }
.schema-field-name { display: flex; align-items: center; gap: 2px; min-width: 0; }
.schema-field-name > :first-child { flex: 1; min-width: 0; }
.schema-field-name > label:first-child > span, .schema-add-field > label:first-child > span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.schema-builder .schema-required { flex: none; display: flex; flex-direction: row-reverse; align-items: center; gap: 4px; padding-inline: 4px; white-space: nowrap; cursor: pointer; }
.schema-field-row .language-select, .schema-add-field .language-select { flex: 1; min-width: 0; }
.schema-children { container-type: inline-size; margin: 2px 0 0 8px; padding-left: 13px; }
.schema-children > .schema-field::before { content: ""; position: absolute; left: -13px; top: 0; height: 20px; border-left: 1px solid var(--c-line-soft); }
.schema-children > .schema-field:has(~ .schema-field, ~ .schema-add-field)::before { height: auto; bottom: 0; }
.schema-children > .schema-field > .schema-field-row::before { content: ""; position: absolute; left: -13px; top: 20px; width: 9px; border-top: 1px solid var(--c-line-soft); }
.schema-children > .schema-add-field::before { content: ""; position: absolute; left: -13px; top: 0; width: 8px; height: 22px; border-left: 1px solid var(--c-line-soft); border-bottom: 1px solid var(--c-line-soft); }
.schema-builder .schema-extra-fields { flex-direction: row-reverse; align-items: center; justify-content: flex-end; gap: 8px; min-height: 28px; width: fit-content; cursor: pointer; }
.schema-expand[aria-expanded="true"] svg { transform: rotate(180deg); }
.schema-field-details { container-type: inline-size; }
.schema-field-details[hidden] { display: none; }
.schema-field-actions { justify-self: end; display: flex; gap: 2px; }
.schema-field-actions button, .schema-field-name button { display: grid; place-items: center; width: 24px; height: 28px; padding: 0; border: 0; border-radius: 3px; background: transparent; color: var(--c-fg-muted); }
.schema-field-name > button, .schema-field-name > div { flex: none; }
.schema-expand:disabled { visibility: hidden; }
.schema-item-name { padding-left: 6px; height: 28px; line-height: 28px; color: var(--c-fg-muted); }
.schema-parameter-menu { width: 184px; overflow-y: auto; }
.schema-parameter-menu .language-options button { height: auto; min-height: 28px; width: 100%; display: block; padding: 5px 8px; text-align: left; }
.schema-parameter-menu .language-options button:focus-visible { background: var(--c-raised); outline: none; }
.schema-parameter-group { margin: 10px 0 16px 24px; }
.schema-parameter { display: grid; grid-template-columns: minmax(0, 1fr) 24px; align-items: center; gap: 2px; min-width: 0; grid-column: 1 / -1; }
.schema-parameter[data-schema-bound="min"] { grid-column: 1; }
.schema-parameter[data-schema-bound="max"] { grid-column: 2; }
.schema-parameter label { display: grid; grid-template-columns: 100px minmax(0, 1fr); align-items: center; gap: 8px; }
.schema-parameter label > span { overflow-wrap: anywhere; }
.schema-parameter-help { grid-column: 1 / -1; color: var(--c-fg-muted); overflow-wrap: anywhere; }
.schema-parameter label:has(> textarea) { align-items: start; }
.schema-parameter label:has(> input[type="checkbox"]) { display: flex; flex-direction: row-reverse; align-items: center; justify-content: flex-end; gap: 8px; min-height: 28px; cursor: pointer; }
.schema-parameter > button { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; background: transparent; color: var(--c-fg-muted); }
.schema-parameter:has(textarea) > button { align-self: start; }
.schema-builder [hidden] { display: none; }
.schema-parameters { display: grid; gap: 6px; }
.schema-parameter-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.schema-parameter-row:not(.schema-range) > .schema-parameter { grid-column: 1 / -1; }
.schema-range { grid-template-columns: minmax(0, 1fr) minmax(48px, .7fr) minmax(0, 1fr); align-items: center; }
.schema-range .schema-parameter { grid-row: 1; }
.schema-range [data-schema-bound="max"] { grid-column: 3; }
.schema-range .schema-parameter label { grid-template-columns: minmax(0, 1fr) 60px; gap: 4px; }
.schema-range .schema-parameter input { font-variant-numeric: tabular-nums; }
.schema-range-track { position: relative; grid-column: 1 / -1; height: 24px; }
.schema-range > .schema-range-track { grid-column: 2; grid-row: 1; }
.schema-range-track::before, .schema-range-track > span { content: ""; position: absolute; top: 11px; left: 5px; right: 5px; height: 2px; background: var(--c-line); }
.schema-range-track > span { left: calc(5px + (100% - 10px) * var(--range-min)); right: calc(5px + (100% - 10px) * (1 - var(--range-max))); background: var(--c-fg-muted); }
.schema-builder .schema-range-track input { appearance: none; position: absolute; inset: 0; width: 100%; height: 24px; margin: 0; padding: 0; border: 0; background: transparent; pointer-events: none; }
.schema-range-track input::-webkit-slider-runnable-track { height: 2px; background: transparent; }
.schema-range-track input::-webkit-slider-thumb { appearance: none; width: 10px; height: 10px; margin-top: -4px; border: 0; border-radius: 50%; background: var(--c-fg-muted); pointer-events: auto; cursor: ew-resize; }
.schema-range-track input::-moz-range-track { height: 2px; background: transparent; }
.schema-range-track input::-moz-range-thumb { width: 10px; height: 10px; border: 0; border-radius: 50%; background: var(--c-fg-muted); pointer-events: auto; cursor: ew-resize; }
.schema-range-track input:focus-visible { z-index: 1; }
.schema-range-track input:disabled { opacity: .45; }
.schema-range-track input:disabled::-webkit-slider-thumb { pointer-events: none; }
.schema-range-track input:disabled::-moz-range-thumb { pointer-events: none; }
.schema-add-field { padding: 8px 0 4px; }
.schema-add-actions { justify-self: end; display: flex; align-items: center; }
.schema-add-actions > button { min-height: 28px; padding: 4px; white-space: nowrap; }
.schema-add-actions > button + button { margin-left: 4px; border: 0; background: transparent; color: var(--c-fg-muted); }
.schema-builder input[aria-invalid="true"], .schema-builder input[aria-invalid="true"]:focus-visible, .subformat-register-fields input:user-invalid { outline: 1px solid var(--c-danger); outline-offset: 1px; }
.schema-json-note { margin: 8px 0 0; color: var(--c-fg-muted); font-size: 11px; }
.schema-builder .schema-extra-fields { margin: 6px 0; }
.subformat-value-form > label, .subformat-value-form fieldset > label { margin-block: 12px; }
.subformat-value-form fieldset { min-width: 0; margin: 12px 0; padding: 0 12px; border: 1px solid var(--c-line); }
.subformat-value-form legend { padding-inline: 4px; }
.subformat-value-form small { overflow-wrap: anywhere; }
.date-control { position: relative; }
.schema-builder .date-control > input { padding-right: 34px; font-variant-numeric: tabular-nums; }
.schema-builder .date-trigger { position: absolute; top: 0; right: 0; display: grid; place-items: center; width: 30px; height: 100%; padding: 0; border: 0; background: transparent; color: var(--c-fg-muted); }
.schema-builder .date-picker { box-sizing: border-box; width: min(272px, calc(100vw - 16px)); padding: 10px; overflow-y: auto; }
.date-picker-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.date-picker-header > span { color: var(--c-fg); font-weight: 500; }
.schema-builder .date-picker button { display: grid; place-items: center; height: 32px; padding: 0; border: 0; border-radius: 3px; background: transparent; color: var(--c-fg); font: inherit; font-variant-numeric: tabular-nums; }
.schema-builder .date-picker button:is(:hover, :focus-visible) { background: var(--c-raised); }
.schema-builder .date-picker button:focus-visible { outline: 1px solid var(--c-accent); outline-offset: -1px; }
.date-picker-header button { width: 32px; }
.date-picker table { width: 100%; margin: 0; border: 0; border-collapse: collapse; table-layout: fixed; }
.date-picker :is(th, td) { padding: 0; border: 0; text-align: center; }
.date-picker th { height: 28px; color: var(--c-fg-muted); font-size: 11px; font-weight: inherit; }
.date-picker td button { position: relative; width: 100%; }
.schema-builder .date-picker [data-outside="true"] { color: var(--c-fg-muted); }
.schema-builder .date-picker [aria-selected="true"] button { background: var(--c-raised); box-shadow: inset 0 0 0 1px var(--c-accent); }
.date-picker [aria-current="date"]::after { content: ""; position: absolute; bottom: 3px; width: 3px; height: 3px; border-radius: 50%; background: var(--c-accent); }
.date-picker-footer { display: flex; justify-content: space-between; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--c-line); }
.schema-builder .date-picker-footer button { padding-inline: 8px; color: var(--c-fg-muted); }
@container(max-width:440px) { .schema-field-row, .schema-add-field { grid-template-columns: minmax(0, 1fr) 128px; } .schema-field-row > :first-child, .schema-add-field > :first-child { grid-column: 1 / -1; } }
@container(max-width:440px) { .schema-add-field { grid-template-columns: minmax(0, 1fr) auto; } }
@container(max-width:440px) { .schema-range { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 8px; } .schema-range [data-schema-bound="max"] { grid-column: 2; } .schema-range > .schema-range-track { grid-column: 1 / -1; grid-row: 2; } .schema-range .schema-parameter label { grid-template-columns: minmax(0, 1fr); gap: 0; } }

/* header band (same height and rule as sidebar-head) */
#phead { flex: none; display: flex; align-items: center; gap: 2px; height: 36px; padding: 0 10px 0 14px;
  border-bottom: 1px solid var(--c-line); }
/* Document metadata is edited in the tree, without changing the row's size. */
body.edit #nav-groups { --nav-rail: 22px; --nav-icon-half: 9px; }
.nav-doc-row { padding-left: 12px; gap: 3px; min-height: 38px; }
.nav-tree .nav-doc-row { padding-left: var(--nav-pad); }
.nav-doc-row:has(> a.cur) { background: var(--c-raised); }
.nav-row.nav-doc-row > a { padding: 4px 2px; background: transparent; }
.nav-doc-row > a::before { display: none; }
.nav-doc-name { display: flex; flex-direction: column; min-width: 0; line-height: 17px; }
.nav-doc-icon { position: relative; flex: none; display: flex; align-items: center; justify-content: center;
  width: 20px; height: 24px; cursor: pointer; border-radius: 3px; color: var(--c-fg-faint); }
.nav-doc-icon:hover, .nav-doc-icon.over, .nav-doc-icon:focus-within { background: var(--c-line); color: var(--c-fg); }
.nav-doc-icon input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.nav-doc-icon > :is(.nav-icon, .doc-icon-frame) { width: 18px; height: 18px; }
.nav-icon-clear { position: absolute; right: -4px; top: -4px; width: 13px; height: 13px; padding: 0;
  border: 1px solid var(--c-line); border-radius: 50%; font: 10px/11px sans-serif;
  color: var(--c-fg); background: var(--c-surface); cursor: pointer; visibility: hidden; }
.nav-doc-icon:hover .nav-icon-clear, .nav-doc-icon:focus-within .nav-icon-clear { visibility: visible; }
.nav-icon-clear:hover { color: var(--c-danger); }
.nav-rename-form { position: absolute; top: 0; bottom: 0; z-index: 4; display: flex; flex-direction: column; justify-content: center;
  background: var(--c-bg0); }
.nav-rename-form input { width: 100%; min-width: 0; box-sizing: border-box; color: var(--c-fg);
  background: transparent; border: 0; border-radius: 2px; padding: 0 2px; font: inherit; line-height: 17px; }
.nav-rename-form input[name="name"] { font: 10px/12px var(--doc-mono); color: var(--c-fg-faint); }
.nav-rename-form input:invalid { outline: 1px solid var(--c-danger); }
.nav-rename-form input:focus, .nav-new input:focus { outline: 1px solid var(--c-line); }
@media (forced-colors: active) { .nav-rename-form input:focus, .nav-new input:focus { outline: 1px solid CanvasText; } }
.nav-doc-row.renaming > a { visibility: hidden; }
.nav-delete:hover, .nav-delete:focus-visible { color: var(--c-danger); }
#status { flex: 1; min-width: 0; padding: 0 8px; text-align: right; color: var(--c-fg-faint);
  font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#status.err { color: var(--c-danger); }
.cm-file-preview { display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; margin-left: 4px; vertical-align: middle; color: var(--c-fg-faint); }
.cm-file-preview[data-state="valid"] { color: var(--c-ok); }
.cm-file-preview[data-state="error"] { color: var(--c-danger); }
.cm-file-preview[data-state="loading"] { color: var(--c-accent); }
.cm-file-preview[data-state="loading"] svg { animation: preview-spin 1s linear infinite; }
@keyframes preview-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .cm-file-preview[data-state="loading"] svg { animation: none; } }
.app-dialog:has(.conflict-columns) { width: min(1000px, calc(100vw - 32px)); }
.conflict-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; }
.conflict-columns h3 { font-size: 13px; margin: 0; }
.conflict-columns pre { max-height: 45vh; overflow: auto; font-size: 12px; padding: 10px; border: 1px solid var(--c-line); }
@media (max-width: 600px) { .conflict-columns { grid-template-columns: 1fr; } .conflict-columns pre { max-height: 25vh; } }
#gear { position: relative; flex: none; }
#gearmenu { display: none; position: absolute; right: 0; top: calc(100% + 6px); z-index: 8;
  min-width: 220px; padding: 4px; flex-direction: column; gap: 1px; color: var(--c-fg);
  background: var(--c-surface); border: 1px solid var(--c-line); border-radius: 6px;
  box-shadow: 0 10px 28px var(--c-shadow); font-size: 12.5px; }
#gear:hover #gearmenu, #gear:focus-within #gearmenu, #gear.open #gearmenu, #gear:has([aria-expanded="true"]) #gearmenu { display: flex; }
#gearmenu label { display: flex; gap: 10px; align-items: center; cursor: pointer;
  padding: 7px 10px; border-radius: 4px; }
#gearmenu label:hover { background: var(--c-raised); }
#gearmenu input { accent-color: var(--c-accent); margin: 0; }
.editor-setting { display: grid; grid-template-columns: 20px minmax(0, 1fr); align-items: center; gap: 8px; padding: 8px 8px 4px; }
.editor-setting > .nav-icon, .editor-setting-icon { color: var(--c-fg-muted); }
.editor-setting-icon { display: grid; place-items: center; }
.editor-setting .subformat-control { min-width: 0; max-width: none; margin: 0; }
.editor-setting .subformat-control-label { background: var(--c-surface); }
.editor-setting .setting-picker, .editor-setting .language-select-input { box-sizing: border-box; width: 100%; min-width: 0; height: 30px; min-height: 30px; padding: 4px 8px; border: 1px solid var(--c-line); border-radius: 4px; background: var(--c-surface); color: var(--c-fg); font: 12px/18px var(--font-sans); }
.editor-setting .setting-picker { display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer; }
.editor-setting .setting-picker > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.editor-setting .setting-picker > svg { flex: none; }
.editor-setting .language-select-input { padding-right: 26px; }
.editor-setting .setting-picker:hover { background: var(--c-raised); }

.fm-language { display: flex; align-items: center; flex: 0 1 220px; min-width: 0; gap: 4px; }
.fm-language > .language-select { flex: 1; width: 0; min-width: 0; }
.language-select, .language-picker { font: 13px/18px var(--font-sans); font-weight: var(--fw-body); }
.language-select { position: relative; }
.language-select-input { width: 100%; min-width: 0; height: 28px; padding: 4px 26px 4px 8px;
  border: 1px solid var(--c-line); border-radius: 5px; color: var(--c-fg);
  background: var(--c-surface); font: inherit; text-overflow: ellipsis; }
.language-select::after { content: ""; position: absolute; right: 10px; top: 9px; width: 6px; height: 6px; pointer-events: none;
  border-right: 1px solid currentColor; border-bottom: 1px solid currentColor; transform: rotate(45deg); }
.language-select-input:hover { background: var(--c-raised); }
.language-select-input:focus-visible, .language-picker :focus-visible { outline: 1px solid var(--c-fg-muted); outline-offset: 1px; }
.language-select-input[aria-disabled="true"] { opacity: .5; cursor: wait; }
.fm-language > .nav-icon { color: var(--c-fg-muted); }
.fm-language .language-select::after { display: none; }
.fm-language .language-select-input { padding: 4px; border: 0; border-bottom: 1px solid var(--c-line);
  border-radius: 0; background: transparent; }
.fm-language .language-select-input:hover { border-bottom-color: var(--c-fg-muted); }
.fm-language .language-select-input:focus-visible { outline: none; border-bottom-color: var(--c-accent); }
.language-picker { position: fixed; margin: 0; padding: 0; overflow: hidden; border: 1px solid var(--c-line);
  border-radius: 5px; color: var(--c-fg); background: var(--c-surface); box-shadow: 0 8px 24px var(--c-shadow); }
.language-picker:popover-open { display: flex; flex-direction: column; }
.language-options { overflow-y: auto; min-height: 0; }
.language-options button { display: block; width: 100%; padding: 6px 8px; border: 0;
  color: inherit; background: transparent; font: inherit; text-align: left;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.language-options button:hover, .language-options button[data-active="true"] { background: var(--c-raised); }
.language-options button[aria-selected="true"] { color: var(--c-fg); }
.language-toggle { display: inline-block; width: 24px; margin: -6px 0 -6px -8px; padding: 6px 0; text-align: center; }
.language-toggle:hover { color: var(--c-accent); background: var(--c-line); }
.language-options button:disabled { opacity: .5; cursor: wait; }
.language-empty { padding: 8px; color: var(--c-fg-muted); }

main.editor-workspace { padding: 0; height: 100vh; display: flex; flex-direction: column; position: sticky; top: 0; }
#split-preview[aria-pressed="true"] { color: var(--c-accent); background: var(--c-raised); }
.pane-actions { top: -20px; margin: -20px -24px -36px; }
#preview-panes { display: flex; flex: 1; min-height: 0; }
#preview-panes[hidden] { display: none; }
.preview-pane.resources-pane { min-height: 0; padding-bottom: 24px; }
.preview-pane.resources-pane:has(.resource-library) { padding-top: 0; }
.resources-pane .resource-tabs { margin-inline: -24px; padding: 0 12px; }
.preview-pane { flex: 1; min-width: 0; overflow: auto; padding: 20px 24px 50vh; border-top: 2px solid transparent; }
#preview-panes.split .preview-pane { padding: 16px; }
#preview-panes.split .pane-actions { top: -16px; margin: -16px -16px -36px; padding-inline: 10px; }
#preview-panes.split .preview-pane + .preview-pane { border-left: 1px solid var(--c-line); }
#preview-panes.split .preview-pane.active { border-top-color: var(--c-accent); }
.preview-pane:focus-visible { outline: 2px solid var(--c-accent); outline-offset: -2px; }
#preview-language-menu { position: fixed; z-index: 9; min-width: 180px; max-height: min(360px, calc(100vh - 64px)); overflow-y: auto; padding: 6px; background: var(--c-surface); border: 1px solid var(--c-line); border-radius: 10px; box-shadow: 0 10px 28px var(--c-shadow); transform-origin: top right; }
.language-option { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px; border: 0; border-radius: 5px; background: transparent; color: var(--c-fg); text-align: left; font: inherit; font-size: 13px; cursor: pointer; }
.language-option::before { content: ""; width: 14px; flex: none; }
.language-option[aria-checked="true"] { color: var(--c-accent); }
.language-option[aria-checked="true"]::before { content: "✓"; }
.language-option:hover, .language-option:focus-visible { background: var(--c-raised); outline: none; }
.language-option:disabled { opacity: .5; cursor: wait; }
#language-setting { padding-bottom: 8px; margin-bottom: 4px; border-bottom: 1px solid var(--c-line); }
#language-setting .language-select { width: 100%; }
.cm-code-diagnostic { text-decoration:underline wavy var(--c-warn); text-underline-offset:3px; }
#validate[data-state="error"], .cm-textfile-validate[data-state="error"] { color:var(--c-danger); }
#validate[data-state="valid"], .cm-textfile-validate[data-state="valid"] { color:var(--c-ok); }
#validate[data-state="pending"], .cm-textfile-validate[data-state="pending"] { color:var(--c-fg-faint); }
#validate[data-state="checking"], .cm-textfile-validate[data-state="checking"] { color:var(--c-info); }
#save[data-state="error"], .cm-textfile-save-status[data-state="error"] { color:var(--c-danger); }
#save[data-state="saved"] { color:var(--c-ok); }
#save[data-state="pending"] { color:var(--c-accent); }
.cm-textfile-save-status { font-size: 10px; color: var(--c-fg-faint); margin-left: 4px; }
.cm-textfile-save-status[hidden], .cm-textfile-retry[hidden] { display: none; }
.cm-textfile-retry { width: auto; padding: 0 5px; font-size: 11px; }
#cm { flex: 1; min-height: 200px; overflow: hidden; }
#cm .cm-inline-fold { display:inline-flex; align-items:center; justify-content:center; vertical-align:middle; width:16px; height:16px; margin-left:2px; padding:0; border:0; border-radius:3px; background:transparent; color:var(--c-fg-faint); cursor:pointer; }
#cm .cm-inline-fold:hover, #cm .cm-inline-fold:focus-visible { color:var(--c-fg); background:var(--c-raised); }
#cm .cm-inline-fold:focus-visible { outline:1px solid var(--c-accent); outline-offset:1px; }
#cm .cm-inline-fold[aria-expanded="false"] svg { transform:rotate(-90deg); }
#cm .cm-editor { height: 100%; }
#cm .cm-editor.cm-focused { outline: none; }
#cm .cm-textfile-controls { display: inline-flex; align-items: center; gap: 1px;
  vertical-align: middle; margin-left: 4px; user-select: none; }
#cm .cm-textfile-controls .pbtn { width: 20px; height: 20px; border-radius: 3px; }
#cm .cm-textfile-controls .pbtn[hidden] { display: none; }
#cm .cm-textfile-controls .pbtn svg { width: 14px; height: 14px; }
#cm .cm-textfile-controls .pbtn:disabled { opacity: .45; cursor: default; }
#cm .cm-textfile { margin: 2px 6px 8px; border: 1px solid var(--c-line);
  border-radius: 4px; min-width: 0; overflow: hidden; }
#cm .cm-textfile-status { padding: 4px 8px; color: var(--c-fg-muted); font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; }
#cm .cm-textfile-status.error { color: var(--c-danger); }
#cm .cm-textfile-editor > .cm-editor { height: auto; max-height: 360px; background: transparent; }
#cm .cm-textfile-editor .cm-content { padding: 6px 0; }
#cm .cm-textfile-editor .cm-gutters { background: transparent; border: 0; }
#cm .cm-textfile-editor .cm-scroller { overflow: auto; }
#cm.dropping { box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--c-accent) 70%, transparent);
  background: color-mix(in srgb, var(--c-accent) 5%, transparent); }

/* Correspondence display (body element ↔ source line) — body.corr when enabled in the gear menu */
body.corr main article > [data-ln] { cursor: pointer; }
body.corr main article > [data-ln].corr-hi {
  background: color-mix(in srgb, var(--c-accent) 12%, transparent);
  box-shadow: -6px 0 0 color-mix(in srgb, var(--c-accent) 55%, transparent); border-radius: 2px; }

.files-toolbar {display:flex;gap:10px;align-items:center;min-width:0;}
.files-toolbar > span {flex:none;}
.files-toolbar button {flex:none;position:relative;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;margin-left:auto;cursor:pointer;}
.files-toolbar button:disabled {opacity:.5;cursor:default;}.files-toolbar button[data-state=loading] {color:transparent;opacity:1;}
.files-toolbar button[data-state=loading]:after {content:"";position:absolute;left:calc(50% - 6px);top:calc(50% - 6px);width:12px;height:12px;border:1px solid var(--c-line);border-top-color:var(--c-accent);border-radius:50%;animation:files-spin .8s linear infinite;}
@keyframes files-spin {to{transform:rotate(360deg);}}
@media(prefers-reduced-motion:reduce){.files-toolbar button[data-state=loading]:after{animation:none;}}
.files-toolbar button[data-state=error] {color:var(--c-danger);}
.files-viewport {overflow:auto;min-height:360px;max-height:70vh;}
.files-table {width:100%;border-collapse:collapse;table-layout:fixed;font-size:13px;}
.files-table th,.files-table td {height:26px;padding:0 6px;text-align:left;}
.files-table th {height:30px;border-bottom:1px solid var(--c-line);}
.files-table th:nth-child(2) {width:76px;}.files-table th:last-child {width:28px;}
.files-table th:nth-child(2),.files-table td:nth-child(2) {text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;}
.files-table td:nth-child(2) {font-size:11px;color:var(--c-fg-faint);}
.files-table tbody tr:hover {background:var(--c-surface);}
.files-table tbody {user-select:none;}
.files-table tr.selected {background:var(--c-raised);}
.files-table button {border:0;background:none;color:inherit;cursor:pointer;padding:3px;}
.files-name {display:flex;min-width:0;}
.files-name a,.files-name .files-folder {position:relative;display:flex;align-items:center;gap:6px;min-width:0;white-space:nowrap;width:100%;height:26px;padding:0 0 0 16px;color:var(--c-fg);font:inherit;text-align:left;text-decoration:none;}
.files-folder:before {content:"";position:absolute;left:3px;top:9px;width:5px;height:5px;border-right:1px solid var(--c-fg-faint);border-bottom:1px solid var(--c-fg-faint);transform:rotate(45deg);}
.files-folder[aria-expanded=false]:before {transform:rotate(-45deg);}
.files-name span {display:flex;flex:none;}
.files-name svg {width:15px;height:15px;color:var(--c-fg-muted);}
.files-name .files-basename {display:block;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;}
.files-copy {display:flex;opacity:0;}
.files-copy svg {width:14px;height:14px;color:var(--c-fg-faint);}
.files-table tr:hover .files-copy,.files-table tr:focus-within .files-copy {opacity:1;}
@media(hover:none){.files-copy{opacity:1;}}
.files-table [data-drop=into], .files-viewport[data-drop=into] {outline:2px solid var(--c-accent);outline-offset:-2px;}
.files-table .files-placeholder {height:96px;text-align:center;vertical-align:middle;}
.app-dialog textarea {display:block;box-sizing:border-box;width:100%;min-height:64px;max-height:65vh;resize:both;font:inherit;}
@media(max-width:600px){.files-table {min-width:0;}.files-table th:nth-child(2){width:65px;}.files-name{max-width:100%;}}

@media(max-width:400px){.files-table th:nth-child(2),.files-table td:nth-child(2){display:none;}}

/* Files pages */
.res-page h1 { margin-bottom: 6px; }
.files-page h1 { display: flex; align-items: center; gap: 10px; overflow-wrap: anywhere; }
.res-crumbs { color: var(--c-fg-faint); font-size: 12.5px; margin: 0 0 20px; }
.res-crumbs a { color: var(--c-fg-muted); text-decoration: none; }
.res-crumbs a:hover { color: var(--c-fg); }
.res-sub { color: var(--c-fg-faint); font-size: 11.5px; font-weight: 400; }
.res-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.res-card { display: flex; flex-direction: column; border: 1px solid var(--c-line); border-radius: 6px;
  overflow: hidden; color: inherit; text-decoration: none; background: var(--c-bg1);
  transition: border-color 120ms ease; }
.res-card:hover { border-color: var(--c-fg-faint); }
.res-thumb { aspect-ratio: 4 / 3; display: flex; align-items: center; justify-content: center; padding: 10px;
  background: var(--c-bg0); overflow: hidden; }
.res-thumb .res-img { max-width: 100%; max-height: 100%; object-fit: contain; }
.res-thumb .res-icon { width: 48px; height: 48px; }
.res-thumb .fig-frame { width: 100% !important; height: 100% !important; aspect-ratio: auto !important;
  pointer-events: none; }
.res-preview .res-svg { max-height: 480px; }
.res-preview .res-html { width: 100% !important; }
.res-meta { display: flex; flex-direction: column; gap: 1px; padding: 7px 10px; border-top: 1px solid var(--c-line); }
.res-name { font-family: var(--doc-mono); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.res-preview { display: flex; align-items: center; justify-content: center; min-height: 160px; padding: 16px;
  border: 1px solid var(--c-line); border-radius: 6px; background: var(--c-bg0); }
.res-preview .res-img { max-width: 100%; max-height: 480px; }
.res-preview.square .res-img { width: 160px; height: 160px; outline: 1px dashed var(--c-line); }
.res-markdown { width: 100%; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.res-thumb .res-markdown { max-height: 100%; overflow: hidden; font-size: 11px; }
.res-preview .res-markdown { max-height: 480px; overflow: auto; }
.res-dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 16px 0 0; font-size: 13px; }
.res-dl dt { color: var(--c-fg-faint); }
.res-dl dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.resources-pane .preview-content, .res-file-page { min-width: 0; width: 100%; max-width: none; }
.resources-pane .res-file-page > h1 { margin: 8px 0 14px; font-size: 17px; overflow-wrap: anywhere; }
.res-file-page .res-preview { display: block; min-width: 0; padding: 0; border: 0; background: transparent; }
.res-file-page .res-preview > :is(img, video) { display: block; max-width: 100%; max-height: calc(100vh - 160px); margin: auto; object-fit: contain; }
.res-file-page .video-player > video:not(:fullscreen) { max-height: calc(100vh - 210px); object-fit: contain; }
.res-file-page .res-preview > :is(.codeblk, .data-table, pre) { margin-top: 0; width: 100%; min-width: 0; box-sizing: border-box; }
.res-file-page .res-preview .codeblk > pre { max-height: calc(100vh - 180px); overflow: auto; }
.res-file-page .res-preview .fig-frame { max-width: 100%; min-height: 300px; }
.res-details { border-top: 1px solid var(--c-line); margin-top: 16px; padding-top: 8px; font-size: 12px; }
.res-details > summary { cursor: pointer; color: var(--c-fg-muted); }


/* Draft placeholders, the in-sidebar create form, and drag moves */
.nav-row :is(.new, .nav-delete, .nav-create) { flex: none; width: 20px; height: 24px; display: flex;
  align-items: center; justify-content: center; border: none; border-radius: 4px; padding: 0;
  background: transparent; color: var(--c-fg-muted); cursor: pointer; opacity: 0; }
.nav-row:hover :is(.new, .nav-delete), .nav-row:focus-within :is(.new, .nav-delete),
.nav-row.renaming :is(.new, .nav-delete) { opacity: 1; }
.nav-row :is(.new, .nav-delete, .nav-create):is(:hover, :focus-visible) { background: var(--c-line); }
.nav-doc-row .nav-tree-toggle, .nav-tree-spacer { width: 18px; margin-right: 3px; }
.nav-tree-spacer { flex: none; height: 28px; }
@media (hover: none) { .nav-row :is(.new, .nav-delete) { opacity: 1; } }
.nav-row > .nav-create { margin: 7px 12px; opacity: 1; }
#sidebar .nav-list:has(> .nav-new-item) > .nav-placeholder { display: none; }
.nav-page-menu { position: fixed; inset: auto; margin: 0; padding: 4px; width: 200px;
  max-width: calc(100vw - 16px); box-sizing: border-box; overflow: auto;
  border: 1px solid var(--c-line); border-radius: 6px; background: var(--c-surface); color: var(--c-fg);
  box-shadow: 0 8px 24px var(--c-shadow); font: 12px/1.5 var(--font-sans); }
.nav-page-menu > button { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 36px;
  padding: 7px 10px; border: 0; border-radius: 4px; background: transparent; color: inherit;
  font: inherit; text-align: left; cursor: pointer; }
.nav-page-menu > button svg { width: 16px; height: 16px; flex: none; color: var(--c-fg-muted); }
.nav-page-menu > button:not(:disabled):hover { background: var(--c-raised); }
.nav-page-menu :focus-visible { outline: 1px solid var(--c-fg-muted); outline-offset: -2px; }
.nav-page-menu button:disabled { color: var(--c-fg-muted); cursor: default; }
.nav-page-menu .nav-page-chevron { display: flex; margin-left: auto; transform: rotate(90deg); }
.nav-page-menu .nav-page-chevron svg { width: 12px; height: 12px; }
.nav-page-menu .subformat-setting-option > button:is(:hover, :focus-visible) { background: var(--c-raised); }
.nav-page-menu .err { margin: 0; padding: 4px 10px; color: var(--c-danger); overflow-wrap: anywhere; }
.nav-page-menu .err:empty { display: none; }
/* Keep the title and filename together in a compact create form. */
.nav-row > .nav-new { position: relative; display: flex; flex: 1; min-width: 0;
  flex-direction: column; justify-content: center; align-items: stretch; cursor: auto;
  margin: 4px 0; gap: 10px; padding: 12px;
  border: 1px solid var(--c-line); border-radius: 6px; background: var(--c-raised); }
.nav-new-heading { margin: 0; color: var(--c-fg-muted); font-size: 11px; }
.nav-new :is(input, button):focus-visible { outline: 1px solid var(--c-fg-muted); outline-offset: 2px; }
.nav-new [hidden] { display: none; }
.nav-tree .nav-new { margin-left: calc(var(--nav-pad) - 12px); }
.nav-new > .nav-icon { position: absolute; left: 12px; top: 10px; color: var(--c-fg-faint); }
.nav-new input { font: inherit; color: var(--c-fg); background: transparent; border: none;
  padding: 0; min-width: 0; outline: none; }
.nav-new input::placeholder { color: var(--c-fg-faint); }
.nav-new input[name="title"] { font-size: 13px; line-height: 17px; }
.nav-new-file { display: flex; align-items: center; color: var(--c-fg-faint);
  font: 10px/12px var(--doc-mono); }
.nav-new-file input { flex: 1; font-family: inherit; font-size: inherit; color: var(--c-fg-muted); }
.nav-new-actions { display: flex; justify-content: flex-end; gap: 8px; }
.nav-new-cancel { padding: 4px 8px; color: var(--c-fg-muted); background: none; border: 0; border-radius: 4px; font: inherit; cursor: pointer; }
.nav-new-go { flex: none; display: flex; align-items: center; justify-content: center;
  min-height: 30px; padding: 4px 10px; font: inherit; color: var(--c-fg); background: var(--c-bg0);
  border: 1px solid var(--c-line); border-radius: 4px; cursor: pointer; }
.nav-new-go:hover { color: var(--c-accent); border-color: var(--c-accent); }
.nav-new .err { position: absolute; top: 100%; left: 0; right: 0; z-index: 5; padding: 4px;
  background: var(--c-surface); color: var(--c-danger); font-size: 11px; line-height: 1.4; }
.nav-new .err:empty { display: none; }
.nav-tree > .nav-new-item > .nav-row::before { width: calc(var(--nav-pad) - 12px - var(--nav-line)); }
.nav-ancestor > .nav-tree > .nav-new-item { --nav-line: var(--nav-rail, 21px); }
.nav-ancestor > .nav-tree > .nav-new-item > .nav-row::before,
.nav-ancestor > .nav-tree > .nav-new-item > .nav-row::after { display: block; }
.nav-ancestor > .nav-tree > .nav-item:has(~ .nav-new-item)::before {
  display: block; left: var(--nav-rail, 21px); background: var(--c-line); }
body.edit .nav-row { cursor: grab; }
.nav-item.dragging { opacity: .35; }
.nav-row.drop-before { box-shadow: inset 0 2px 0 var(--c-accent); }
.nav-row.drop-after { box-shadow: inset 0 -2px 0 var(--c-accent); }
.nav-row.drop-into > a { background: color-mix(in srgb, var(--c-accent) 18%, transparent); }
`;

interface PageOpts {
    title: string;
    main: string;
    currentId?: string;
    /** Current location among the Resources pages (the part after `/_files`). */
    currentRes?: string;
    /** edit-mode doc pages only: right-panel html + client boot data. */
    aside?: string;
    boot?: unknown;
    /**
     * When writing out a single static HTML file (publishHtml). Replaces every server-served
     * script with an inline one.
     */
    publish?: {
        graphJs: string;
        codeJs: string;
        pages: string;
        first: string;
        network: boolean;
        pluginJs?: string;
        subformatJs?: string;
    };
}

// Contents of #nav-groups (the doc tree). Used by both page()'s initial render and
// `GET /api/nav` (edit mode; the client reconciles changed nodes after an md change)
// (= the same value isn't declared in two places).
// Each item is a page row and its children list, emitted even when empty
// (it's the insertion target for the sidebar create form / drag).
export const navGroupsHtml = (
    mode: ServeMode,
    site: Site,
    currentId?: string,
    currentRes?: string,
): string => {
    const open = new Set(
        currentId == null
            ? []
            : [...ancestorsOf(site.entries, currentId).map((e) => e.id), currentId],
    );
    const list = (parent: string | undefined, depth: number): string => {
        const items = childrenOf(site.entries, parent)
            .map((e) => {
                const label = escapeHtml(docDisplayName(e.frontmatter, e.id));
                const cur = e.id === currentId ? " cur" : "";
                // Top level = nav-link with an icon, descendants = nav-tree-link with guide lines.
                // A doc-specific icon (icons/<id>.svg), if any, replaces the book icon at top
                // level and goes before the label below that.
                let link =
                    depth === 0
                        ? `<a class="nav-link${cur}" href="/${e.id}" title="${label}">${e.icon ? svgImg(e.icon, "nav-icon doc-icon") : e.subformat ? SUBFORMATS_ICON : DOCS_ICON}<span class="nav-label">${label}</span></a>`
                        : `<a class="nav-tree-link${cur}" href="/${e.id}" title="${label}">${e.icon ? svgImg(e.icon, "doc-icon") : e.subformat ? SUBFORMATS_ICON : DOCS_ICON}<span class="nav-label">${label}</span></a>`;
                let actions = "";
                let editableIcon = "";
                if (mode === "edit") {
                    link = `<a class="${depth === 0 ? "nav-link" : "nav-tree-link"}${cur}" href="/${e.id}" title="${label}" aria-keyshortcuts="F2"><span class="nav-doc-name"><span class="nav-label">${label}</span></span></a>`;
                    editableIcon = `<span class="nav-doc-icon" title="icon" data-i18n-title="icon">${e.icon ? svgImg(e.icon, "doc-icon") : e.subformat ? SUBFORMATS_ICON : DOCS_ICON}<input type="file" accept=".svg,image/svg+xml" aria-label="icon" data-i18n-aria-label="icon">${e.icon ? '<button class="nav-icon-clear" type="button" title="Remove icon" data-i18n-title="Remove icon" aria-label="Remove icon" data-i18n-aria-label="Remove icon">×</button>' : ""}</span>`;
                    actions = `<button class="new" type="button" data-parent="${escapeHtml(e.id)}" popovertarget="nav-page-menu" aria-haspopup="menu" title="Add doc" data-i18n-title="Add doc" aria-label="Add doc" data-i18n-aria-label="Add doc">${PLUS_ICON}</button><button class="nav-delete" type="button" data-doc-action="delete" title="Delete doc" data-i18n-title="Delete doc" aria-label="Delete doc" data-i18n-aria-label="Delete doc">${DELETE_ICON}</button>`;
                }
                const branch = childrenOf(site.entries, e.id).length > 0;
                const toggle = branch
                    ? `<button class="nav-tree-toggle" type="button" aria-label="Toggle ${label}">${CHEVRON_ICON}</button>`
                    : mode === "edit"
                      ? '<span class="nav-tree-spacer" aria-hidden="true"></span>'
                      : "";
                return `<div class="nav-item${open.has(e.id) ? " open" : ""}" data-doc-id="${escapeHtml(e.id)}"${e.subformat ? " data-subformat-nav" : ""}><div class="nav-row${mode === "edit" ? " nav-doc-row" : ""}"${mode === "edit" ? ' draggable="true"' : ""}>${editableIcon}${link}${actions}${toggle}</div>${list(e.id, depth + 1)}</div>`;
            })
            .join("");
        const placeholder =
            mode === "edit" && depth === 0
                ? `<div class="nav-item nav-placeholder"><div class="nav-row"><button class="nav-create" type="button" data-parent="" popovertarget="nav-page-menu" aria-haspopup="menu" title="Add doc" data-i18n-title="Add doc" aria-label="Add doc" data-i18n-aria-label="Add doc">${PLUS_ICON}</button></div></div>`
                : "";
        return depth === 0
            ? `<div class="nav-list nav-root" data-parent=""${mode === "edit" ? ' id="nav-docs"' : ""}>${items}${placeholder}</div>`
            : `<div class="nav-list nav-tree" data-parent="${escapeHtml(parent ?? "")}" style="--nav-depth:${depth + 1}">${items}${placeholder}</div>`;
    };
    const html =
        list(undefined, 0) +
        (mode === "edit"
            ? `<template data-page-subformats>${escapeHtml(JSON.stringify((site.subformats ?? []).filter((format) => !site.entries.some((entry) => entry.subformat?.ext === format.ext))))}</template>${navFilesHtml(site, currentRes)}`
            : "");
    return docLinks(site, site.contentLanguage ? languageLinks(html, site.contentLanguage) : html);
};

// ── Resources (file management in edit mode; linked figures and terms also in preview) ──
// Structure: Resources (list page of everything) › kind (list pages for figures / html / icons) › individual file.
// Route is `/_files[/<kind>[/<file>]]` (doc ids can't start with `_`, so no collision).
const RESOURCE_KINDS = ["markdown", "figures", "html", "icons", "terms"] as const;
type ResourceKind = (typeof RESOURCE_KINDS)[number];
interface Resource {
    kind: ResourceKind;
    /** Key within the kind (the end of the route). */
    file: string;
    /** Path relative to the docs root. */
    path: string;
}
const siteResources = (site: Site): Resource[] => [
    ...site.entries
        .filter((entry) => !entry.subformat)
        .map((entry) => ({
            kind: "markdown" as const,
            file: entry.file,
            path: entry.sourceFile ?? CONTENT_PREFIX + entry.file,
        })),
    ...site.ctx.terms.map((term) => ({
        kind: "terms" as const,
        file: term.id,
        path: isTermFile(term.id)
            ? term.id
            : CONTENT_PREFIX +
              (site.entries.find((entry) =>
                  entry.blocks.some((block) => block.type === "term" && block.entry.id === term.id),
              )?.file ?? ""),
    })),
    ...[...site.ctx.figures.values()].map((f) => ({
        kind: f.kind === "html" ? ("html" as const) : ("figures" as const),
        file: f.file.replace(/^figures\//, ""),
        path: f.file,
    })),
    ...site.entries
        .filter((e) => e.icon != null)
        .map((e) => ({
            kind: "icons" as const,
            file: `${e.id}.svg`,
            path: e.iconFile ?? `${ICONS_DIR}/${e.id}.svg`,
        })),
];
const resourceHref = (kind?: ResourceKind, file?: string): string =>
    `/_files${kind ? `/${kind}` : ""}${file ? `/${encodeURIComponent(file)}` : ""}`;

const navFilesHtml = (site: Site, currentRes?: string): string => {
    const source = site.workspace;
    const statics =
        currentRes?.startsWith("_statics") ||
        ["codeblocks", "urls", "url-previews", "dictionary", "code"].includes(currentRes ?? "");
    const hint = `<div class="files-drop-hint" aria-hidden="true">${UPLOAD_ICON}<span data-i18n="Upload files">Upload files</span></div>`;
    const location =
        source?.protocol === "git"
            ? `<summary class="workspace-location" aria-label="Workspace tools" data-i18n-aria-label="Workspace tools" data-workspace-protocol="git" title="${escapeHtml(`${source.repo ?? "repo"}[${source.branch}]`)}">${GIT_ICON}<span class="workspace-address"><span class="git-repo-name">${escapeHtml(source.repo ?? "repo")}</span><span class="git-branch-caption">[${escapeHtml(source.branch)}]</span></span>${CHEVRON_ICON}</summary>`
            : `<summary class="workspace-location" aria-label="Workspace tools" data-i18n-aria-label="Workspace tools" id="nav-storage" data-workspace-protocol="storage" title="${escapeHtml(workspaceName(site))}">${workspaceIcon(site)}<span class="workspace-address">${escapeHtml(source?.folder ?? "Files")} / ${escapeHtml(source?.service ?? "Local")}</span>${CHEVRON_ICON}</summary>`;
    const git =
        source?.protocol === "git"
            ? `<div class="nav-resources" id="nav-git"><div class="nav-item" data-node-id="_git"><div class="nav-row"><a class="nav-link${currentRes === "_git" ? " cur" : ""}" href="/_git" title="Git controls" data-i18n-title="Git controls">${GIT_ICON}<span class="nav-label">Git</span></a></div></div></div>`
            : "";
    const extensions = `<div class="nav-resources" id="nav-extensions" data-scope="${createHash("sha256").update(root).digest("hex")}"><div class="nav-item" data-node-id="_extensions"><div class="nav-row"><a class="nav-link${currentRes === "_extensions" ? " cur" : ""}" href="/_extensions" title="Plugins" data-i18n-title="Plugins">${PLUGINS_ICON}<span class="nav-label" data-i18n="Plugins">Plugins</span></a></div></div><div class="extensions-drop-hint" aria-hidden="true">${PLUGINS_ICON}<span data-i18n="Add plugins">Add plugins</span></div></div>`;
    const subformats = `<div class="nav-resources" id="nav-subformats"><div class="nav-item" data-node-id="_subformats"><div class="nav-row"><a class="nav-link${currentRes === "_subformats" ? " cur" : ""}" href="/_subformats" title="Subformats" data-i18n-title="Subformats">${SUBFORMATS_ICON}<span class="nav-label" data-i18n="Subformats">Subformats</span></a></div></div></div>`;
    return `<details id="nav-tools" open>${location}<div class="nav-tool-cards"><div class="nav-resources" id="nav-files"><div class="nav-item" data-node-id="_files"><div class="nav-row"><a class="nav-link${currentRes !== undefined && currentRes !== "_git" && currentRes !== "_extensions" && currentRes !== "_subformats" && !statics ? " cur" : ""}" href="/_files" title="Files" data-i18n-title="Files">${FOLDER_ICON}<span class="nav-label" data-i18n="Files">Files</span></a><span class="files-upload-status" role="status"></span></div></div>${hint}</div><div class="nav-resources" id="nav-statics"><div class="nav-item" data-node-id="_statics"><div class="nav-row"><a class="nav-link${statics ? " cur" : ""}" href="/_statics" title="Statics" data-i18n-title="Statics">${STATICS_ICON}<span class="nav-label" data-i18n="Statics">Statics</span></a></div></div></div>${subformats}${git}${extensions}</div></details>`;
};

const formatSize = (bytes: number): string =>
    bytes < 1024
        ? `${bytes} B`
        : bytes < 1024 * 1024
          ? `${(bytes / 1024).toFixed(1)} KB`
          : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const sizeOf = (path: string): string => {
    try {
        return formatSize(statSync(join(root, path)).size);
    } catch {
        return "—";
    }
};

// Thumbnail in the lists / preview on the individual page. svg is confined to an img (avoids id
// collisions), raster is already <img data:>, and html figures are shown
// isolated in a sandboxed iframe.
const resourcePreview = (site: Site, r: Resource): string => {
    if (r.kind === "markdown") {
        const entry = site.entries.find((e) => e.file === r.file);
        return `<pre class="res-markdown">${escapeHtml(entry?.raw ?? "")}</pre>`;
    }
    if (r.kind === "terms") return termsHtml(site.ctx.terms.filter((term) => term.id === r.file));
    if (r.kind === "figures" || r.kind === "html") {
        const f = site.ctx.figures.get(figureName(r.path));
        if (!f) {
            return "";
        }
        // svg figures are inline, as in the body (figures.ts has already namespaced the ids and
        // embedded the theme).
        return f.kind === "image"
            ? f.markup.replace("<img ", '<img class="res-img" ')
            : (site.ctx.figurePreview ?? figureFrameHtml)(f, `fig-frame res-${f.kind}`);
    }
    const e = site.entries.find((x) => `${x.id}.svg` === r.file);
    return e?.icon ? svgImg(e.icon, "res-img res-icon") : "";
};

const resourceUsage = (site: Site, r: Resource): Entry[] =>
    r.kind === "markdown"
        ? site.entries.filter((e) => e.file === r.file)
        : r.kind === "figures" || r.kind === "html"
          ? site.entries.filter((e) => e.figureRefs?.includes(figureName(r.path)))
          : r.kind === "icons"
            ? site.entries.filter((e) => `${e.id}.svg` === r.file)
            : site.entries.filter((e) => e.termRefs?.includes(r.file));

const resourceCards = (site: Site, list: Resource[]): string =>
    list.length === 0
        ? ""
        : `<div class="res-grid">${list
              .map((r) => {
                  const used = resourceUsage(site, r).length;
                  return `<a class="res-card" href="${resourceHref(r.kind, r.file)}"><div class="res-thumb">${resourcePreview(site, r)}</div><div class="res-meta"><span class="res-name">${escapeHtml(r.file)}</span><span class="res-sub">${sizeOf(r.path)} · used by ${used}</span></div></a>`;
              })
              .join("")}</div>`;

/** Path after `/_files` → main content (unknown → undefined = 404). */
const textfilePreview = (
    site: Site,
    file: string,
    source: string,
): { html: string; errors: string[] } => {
    const language = (file.split(".").at(-1) ?? "text").toLowerCase();
    const parsed = parseContentSource(language, source, file);
    const errors = parsed?.errors.map(({ message }) => message) ?? [];
    if (errors.length) return { html: "", errors };
    try {
        return {
            html: blocksHtml(
                parsed?.blocks ?? [
                    { type: "code", lang: language, lines: source.split(/\r?\n/), filename: file },
                ],
                site.ctx,
            ),
            errors,
        };
    } catch (error) {
        return { html: "", errors: [error instanceof Error ? error.message : String(error)] };
    }
};
export const textfilePreviewHtml = (site: Site, file: string, source: string): string => {
    const { html, errors } = textfilePreview(site, file, source);
    return errors.length
        ? `<div class="errors" role="status">${errors.map(escapeHtml).join("<br>")}</div>`
        : html;
};
export const textfilePreviewErrors = (site: Site, file: string, source: string): string[] => {
    const errors = textfilePreview(site, file, source).errors;
    try {
        validateSubformatFile(root, file, source, site.previews?.domains);
    } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
    }
    if (/\.(md|markdown)$/i.test(file)) {
        const { doc, source: parsed } = compileDraft(draftContext(site), file, source);
        errors.push(...parsed.errors);
        try {
            blocksHtml(doc.blocks, site.ctx);
        } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
        }
    }
    return errors;
};

export const resourcesMain = (
    site: Site,
    rest: string,
): { title: string; main: string; sourceFile?: string } | undefined => {
    if (rest === "_extensions")
        return {
            title: "Plugins",
            main: '<article class="res-page resource-library"><div id="extensions-manager"></div></article>',
        };
    if (rest === "_git")
        return site.workspace?.protocol === "git"
            ? {
                  title: `${site.workspace.repo ?? "repo"} [${site.workspace.branch}]`,
                  main: '<article class="res-page resource-library git-page"><div id="git-manager"></div></article>',
              }
            : undefined;
    if (rest === "_statics" || rest.startsWith("_statics/")) {
        const view = rest.slice("_statics".length).replace(/^\//, "") || "codeblocks";
        return ["codeblocks", "urls", "url-previews", "dictionary", "code"].includes(view)
            ? resourcesMain(site, view)
            : undefined;
    }
    const all = siteResources(site);
    const [kind, ...tail] = rest === "" ? [] : rest.split("/");
    const file = tail.length > 0 ? decodeURIComponent(tail.join("/")) : undefined;
    if (kind == null) {
        return {
            title: workspaceName(site),
            main: `<article class="res-page files-page resource-library"><div id="files-manager"></div></article>`,
        };
    }
    if (!file && (kind === "dictionary" || kind === "code"))
        return resourcesMain(site, "codeblocks");
    if (
        !file &&
        (kind === "codeblocks" ||
            kind === "urls" ||
            kind === "url-previews" ||
            kind === "_subformats")
    ) {
        const index = resourceIndex(
            root,
            site.filePaths ?? filesSnapshot(root).files.map((item) => item.path),
            site.previews?.domains,
        );
        if (site.workspace?.protocol === "git" && index.subformats.length)
            setSubformatChanges(root, index.subformats);
        return {
            title: kind === "_subformats" ? "Subformats" : "Statics",
            main: `<article class="res-page files-page resource-library">${kind === "_subformats" ? "" : resourceTabs(kind)}${resourceLibraryHtml(index, kind === "_subformats" ? "subformats" : kind)}</article>`,
        };
    }
    if (kind === "file" && file) {
        const resource = all.find((item) => item.path === file);
        if (resource)
            return resourcesMain(site, `${resource.kind}/${encodeURIComponent(resource.file)}`);
        try {
            if (!filesSnapshot(root).files.some((item) => item.path === file)) return undefined;
            const content = readFileSync(textfilePath(root, file));
            let preview = "";
            let sourceFile: string | undefined;
            if (/\.(svg|png|jpe?g|gif|webp)$/i.test(file)) {
                const extension = file.split(".").pop()?.toLowerCase();
                const mime =
                    extension === "svg" ? "svg+xml" : extension === "jpg" ? "jpeg" : extension;
                preview = `<img alt="" src="data:image/${mime};base64,${content.toString("base64")}">`;
                if (extension === "svg") sourceFile = file;
            } else if (/\.(mp4|webm|ogg)$/i.test(file)) {
                preview = `<video data-dooc-video controls playsinline preload="metadata" aria-label="Video preview" src="data:video/${file.split(".").pop()};base64,${content.toString("base64")}"></video>`;
            } else {
                try {
                    const source = new TextDecoder("utf-8", { fatal: true }).decode(content);
                    if (source.includes("\0")) throw new Error("Binary file");
                    sourceFile = file;
                    preview = textfilePreviewHtml(site, file, source);
                } catch {
                    preview = BOX_ICON;
                }
            }
            return {
                title: file,
                sourceFile,
                main: `<article class="res-page res-file-page"><nav class="res-crumbs"><a href="/_files">${workspaceText(site)}</a></nav><h1>${escapeHtml(file)}</h1><div class="res-preview${sourceFile ? " res-text-preview" : ""}">${preview}</div></article>`,
            };
        } catch {
            return undefined;
        }
    }
    if (!RESOURCE_KINDS.includes(kind as ResourceKind)) {
        return undefined;
    }
    const k = kind as ResourceKind;
    const crumbs = `<nav class="res-crumbs"><a href="/_files">${workspaceText(site)}</a> › ${file ? `<a href="${resourceHref(k)}" data-i18n="${k}">${k}</a> › ${escapeHtml(file)}` : k}</nav>`;
    if (file == null) {
        return {
            title: `${k} — ${workspaceName(site)}`,
            main: `<article class="res-page">${k === "terms" ? "" : crumbs}<h1 data-i18n="${k}">${translate("eng", k)}</h1>${
                k === "terms"
                    ? termsHtml(
                          site.ctx.terms,
                          resolveLanguage(site.contentLanguage ?? site.defaultLang, site.languages),
                          true,
                      )
                    : resourceCards(
                          site,
                          all.filter((r) => r.kind === k),
                      )
            }</article>`,
        };
    }
    const r = all.find((x) => x.kind === k && x.file === file);
    if (!r) {
        return undefined;
    }
    const fig =
        k === "figures" || k === "html" ? site.ctx.figures.get(figureName(r.path)) : undefined;
    const used = resourceUsage(site, r);
    const snippet =
        k === "terms"
            ? isTermFile(r.file)
                ? `[](${termFileUrl(r.file)})`
                : undefined
            : fig
              ? `![](${r.path})`
              : undefined;
    const rows = [
        ["path", `<code>${escapeHtml(r.path)}</code>`],
        ["size", sizeOf(r.path)],
        ...(fig ? [["kind", fig.kind]] : []),
        ...(fig?.title ? [["title", escapeHtml(fig.title)]] : []),
        ...(fig?.desc ? [["desc", escapeHtml(fig.desc)]] : []),
        ...(snippet ? [["syntax", `<code class="res-snippet">${escapeHtml(snippet)}</code>`]] : []),
        [
            k === "icons" || k === "markdown" ? "doc" : "used in",
            used.length === 0
                ? `<span class="res-sub" data-i18n="none">none</span>`
                : used
                      .map(
                          (e) =>
                              `<a href="/${e.id}">${escapeHtml(docDisplayName(e.frontmatter, e.id))}</a>`,
                      )
                      .join(", "),
        ],
    ];
    return {
        title: `${r.file} — Files`,
        ...(/\.(?:svg|html|termth|md|markdown)$/i.test(r.path) ? { sourceFile: r.path } : {}),
        main: `<article class="res-page res-file-page">${crumbs}<h1>${escapeHtml(r.file)}</h1><div class="res-preview${k === "icons" ? " square" : ""}">${resourcePreview(site, r)}</div><details class="res-details"><summary data-i18n="File details">File details</summary><dl class="res-dl">${rows.map(([dt, dd]) => `<dt data-i18n="${dt}">${dt}</dt><dd>${dd}</dd>`).join("")}</dl></details></article>`,
    };
};

const figurePage = (site: Site, fig: FigureEntry): { title: string; main: string } => {
    const title = fig.title ?? fig.file;
    return {
        title,
        main: docHtml({ title }, [{ type: "figureRef", name: fig.name }], [], site.ctx),
    };
};

// Browser tab title — shared by page() and `/api/page` (doc switching via client-side navigation).
const pageTitle = (mode: ServeMode, title: string, siteTitle?: string): string =>
    title === siteTitle ? title : `${title} — ${siteTitle ?? `dooc ${mode}`}`;

// Navigation follows the manifest hierarchy via routing.docPath.
const page = (mode: ServeMode, site: Site, opts: PageOpts): string => {
    const nav = navGroupsHtml(mode, site, opts.currentId, opts.currentRes);
    const siteTitle = escapeHtml(site.title ?? "dooc");
    const iconImg = `<img id="site-icon" alt=""${site.icon ? ` src="${svgDataUri(site.icon)}"` : " hidden"}>`;
    const iconVariants = Object.entries(site.iconVariants ?? {});
    // The base image sits in a wrapper so theme switching and edit-client's #site-icon.hidden never fight.
    const iconHtml = iconVariants.length
        ? `<span class="site-icon-variants" data-theme-variants><span data-theme-variant="">${iconImg}</span>${iconVariants.map(([theme, svg]) => `<img data-theme-variant="${escapeHtml(theme)}" alt="" src="${svgDataUri(svg)}" hidden>`).join("")}</span>`
        : iconImg;
    const siteIcon = `<span id="site-icon-slot"${mode === "edit" ? ' title="Change site icon" data-i18n-title="Change site icon"' : ""}>${iconHtml}${DOCS_ICON}${mode === "edit" ? '<input type="file" accept=".svg,image/svg+xml" aria-label="Change site icon" data-i18n-aria-label="Change site icon">' : ""}</span>`;
    const bootScripts =
        opts.boot != null
            ? `<script id="boot" type="application/json">${JSON.stringify(opts.boot).replace(/</g, "\\u003c")}</script>
<script src="/assets/edit.js"></script>`
            : !opts.publish
              ? '<script src="/assets/ui.js"></script>'
              : opts.publish.subformatJs
                ? `<script>${inlineScript(opts.publish.subformatJs)}</script>`
                : "";
    // Interaction layer of the schema graph (zoom / pan / box drag / enlarged view). Shared by
    // preview / edit. Figures are readable without JS, so defer is enough (= progressive
    // enhancement).
    const main =
        opts.boot != null
            ? `<main class="editor-workspace">


<div id="preview-language-menu" role="menu" aria-label="Change language" data-i18n-aria-label="Change language" hidden></div>
<div id="preview-panes"${opts.currentRes !== undefined ? " hidden" : ""}><section class="preview-pane active" tabindex="0" aria-label="Active pane" data-i18n-aria-label="Active pane"><div class="pane-actions"><button class="pbtn" type="button" data-theme-picker="document" aria-label="Preview theme"></button>${fontButton("viewer")}<button class="pbtn pane-language" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="preview-language-menu" aria-label="Change language" data-i18n-aria-label="Change language" title="Change language" data-i18n-title="Change language">${GLOBE_ICON}</button></div><div class="preview-content">${opts.main}</div></section></div></main>`
            : mode === "edit" && opts.currentRes !== undefined
              ? `<main class="resources-pane">${opts.main}</main>`
              : `<main><div class="page-actions"><button class="pbtn" type="button" data-theme-picker="document" aria-label="Preview theme"></button>${fontButton("viewer")}</div>${opts.main}</main>`;
    const graphScript = opts.publish
        ? `<script>${inlineScript(opts.publish.graphJs)}</script>`
        : `<script>(${loadPreviewScript.toString()})("/assets/graph.js", "svg[data-sg-layout], [data-mermaid]", "module");</script>`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
${opts.publish ? `<meta name="referrer" content="no-referrer"><meta http-equiv="x-dns-prefetch-control" content="off">${opts.publish.network ? "" : `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' data:; img-src data: blob:; media-src data: blob:; object-src data:; font-src data: blob:; frame-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'">`}` : ""}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(pageTitle(mode, opts.title, site.title))}</title>
<script>var __name = (f) => f;
(${initializeThemes.toString()})(${JSON.stringify(site.themes)});
(${mountFigureFrames.toString()})(document);</script>
<style>${fontCss(Boolean(opts.publish))}${CSS}${mode === "edit" ? EDIT_CSS : ""}</style></head>
<body${mode === "edit" ? ' class="edit"' : ""}${site.sourceBase ? ` data-source-base="${escapeHtml(site.sourceBase)}"` : ""}><nav id="sidebar"><div id="sidebar-resize" class="panel-resize" role="separator" tabindex="0" aria-orientation="vertical" aria-controls="sidebar" aria-label="Resize sidebar" data-i18n-aria-label="Resize sidebar" title="Resize sidebar" data-i18n-title="Resize sidebar"></div><div id="sidebar-head">${siteIcon}<div id="site-title" class="site-title" title="${siteTitle}"${mode === "edit" ? ` data-title="${escapeHtml(site.title ?? "")}" tabindex="0" role="button" aria-label="Edit site title" data-i18n-aria-label="Edit site title"` : ""}>${siteTitle}</div><button id="sidebar-toggle" type="button" aria-controls="sidebar-content" aria-expanded="true" title="Close sidebar" data-i18n-title="Close sidebar">${SIDEBAR_ICON}</button></div><div id="sidebar-content"><div id="nav-groups">${nav}</div><div id="nav-status" role="status" aria-live="polite"></div></div></nav>${main}${opts.aside ?? ""}
<script>
(${mountThemePickers.toString()})(${JSON.stringify(THEME_ICONS)}, ${JSON.stringify(site.themes)});
(${mountThemeVariants.toString()})(document);
</script>
${bootScripts}${graphScript}
<script id="code-grammars" type="application/json"${opts.publish ? "" : ' data-src="/assets/code-grammars.json"'}>${opts.publish ? JSON.stringify(site.codeGrammars ?? []).replace(/</g, "\\u003c") : "[]"}</script>
${opts.publish ? `<script>${inlineScript(opts.publish.codeJs)}</script>` : `<script>(${loadPreviewScript.toString()})("/assets/code.js", ".codeblk");</script>`}
<script>
// Functions toString'd under tsx (esbuild keepNames) contain __name(...) calls; define a no-op.
var __name = (f) => f;
const contentLanguage = () => JSON.parse(document.getElementById("boot")?.textContent || "null")?.contentLanguage || ${JSON.stringify(site.contentLanguage ?? site.defaultLang)};
const localeFetch = (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, "x-docs-language": contentLanguage() } });
(${mountTerms.toString()})(document);
(${mountTables.toString()})(document);
(${mountToc.toString()})(document);
(${mountVideos.toString()})(document);
${opts.publish ? "" : `(${mountFigurePreviews.toString()})();`}
void (${mountFontPickers.toString()})(${createFontSettings.toString()}, ${JSON.stringify(site.fonts ?? []).replace(/</g, "\\u003c")});
(() => {
  const KEY = "docs:sidebar-open";
  const toggle = document.getElementById("sidebar-toggle");
  if (!toggle) return;
  const apply = (open) => {
    document.body.classList.toggle("sidebar-closed", !open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.dataset.i18nTitle = open ? "Close sidebar" : "Open sidebar";
    toggle.title = window.__docsTranslate ? window.__docsTranslate(toggle.dataset.i18nTitle) : toggle.dataset.i18nTitle;
  };
  const narrow = matchMedia("(max-width: 600px)");
  let preferred;
  try { const saved = localStorage.getItem(KEY); if (saved !== null) preferred = saved !== "0"; } catch {}
  let open = !narrow.matches && preferred !== false;
  apply(open);
  narrow.addEventListener("change", () => { open = !narrow.matches && preferred !== false; apply(open); });
  toggle.addEventListener("click", () => {
    open = !open;
    preferred = open;
    try { localStorage.setItem(KEY, open ? "1" : "0"); } catch {}
    apply(open);
  });
  document.getElementById("sidebar-content")?.addEventListener("click", (event) => {
    if (open || !(event.target instanceof Element) || !event.target.closest(".nav-row")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    toggle.click();
  }, true);
})();
(${mountPanelResize.toString()})();
(() => {
  // Open/close: by default "the branch containing the current doc is open" (the server adds
  // .open), overridden by explicit user actions (sessionStorage = per tab only).
  const OPEN_KEY = "docs:nav-open";
  const readOpen = () => { try { return JSON.parse(sessionStorage.getItem(OPEN_KEY) || "{}"); } catch { return {}; } };
  const applyOpen = () => {
    const o = readOpen();
    const tools = document.getElementById("nav-tools");
    if (tools) tools.open = o._tools !== false;
    for (const it of document.querySelectorAll("#nav-groups .nav-item")) {
      const key = it.dataset.docId || it.dataset.nodeId;
      if (key in o) it.classList.toggle("open", o[key]);
      for (const button of it.querySelectorAll(":scope > .nav-row > [aria-expanded]")) button.setAttribute("aria-expanded", String(it.classList.contains("open")));
    }
    (${focusNavTree.toString()})(document.getElementById("nav-groups"));
  };
  window.__docsNavOpen = (id, v) => {
    const o = readOpen();
    o[id] = v;
    try { sessionStorage.setItem(OPEN_KEY, JSON.stringify(o)); } catch {}
    applyOpen();
  };
  document.addEventListener("click", (ev) => {
    const t = ev.target instanceof Element ? ev.target.closest(".nav-tree-toggle") : null;
    if (!t) return;
    ev.preventDefault();
    const it = t.closest(".nav-item");
    window.__docsNavOpen(it.dataset.docId || it.dataset.nodeId, !it.classList.contains("open"));
  });
  document.addEventListener("toggle", (event) => {
    const tools = event.target;
    if (tools instanceof HTMLDetailsElement && tools.id === "nav-tools" && tools.isConnected)
      window.__docsNavOpen("_tools", tools.open);
  }, true);
  applyOpen();
  window.__docsNavRestore = applyOpen;
  const nav = document.getElementById("nav-groups");
  new ResizeObserver(() => (${focusNavTree.toString()})(nav)).observe(nav);
})();
${
    mode === "edit"
        ? `(() => {
  // Sidebar tree editing stays delegated while navigation nodes are reconciled.
  //   drag: top 1/4 of a row = before, bottom 1/4 = after, middle = move into that doc's children
  //         (at the end). The DOM isn't moved, only a marker is shown; on drop, POST /api/move →
  //         re-fetch the nav regardless of the outcome (= the display is always a copy of
  //         dooc.yaml; no rollback logic).
  // The root placeholder and row buttons open the page type menu.
  const t = (key) => window.__docsTranslate?.(key) ?? key;
  const status = document.getElementById("nav-status");
  const setStatus = (message, error) => {
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("err", Boolean(error));
  };
  const refresh = async () => {
    if (window.__docsRefreshNav) return window.__docsRefreshNav();
    const cur = document.querySelector("#nav-groups .nav-row a.cur");
    const id = (cur && cur.closest(".nav-item").dataset.docId) || "";
    const rp = location.pathname.startsWith("/_statics") ? location.pathname.slice(1) : ["/_git", "/_extensions", "/_subformats"].includes(location.pathname) ? location.pathname.slice(1) : location.pathname.startsWith("/_files") ? location.pathname.slice(8).replace(/^\\/|\\/$/g, "") : null;
    const res = await localeFetch("/api/nav?current=" + encodeURIComponent(id) + (rp == null ? "" : "&res=" + encodeURIComponent(rp)));
    if (res.ok) {
      const data = await res.json();
      (${updateNav.toString()})(document.getElementById("nav-groups"), data.html);
      const currentPage = document.querySelector('[data-subformat-nav][data-doc-id="' + CSS.escape(id) + '"] > .nav-row > a');
      if (currentPage && currentPage.pathname !== location.pathname) history.replaceState(null, "", currentPage.href);
      const label = document.getElementById("site-title");
      if (!label.querySelector("form")) label.textContent = label.title = data.siteTitle || "dooc";
      label.dataset.title = data.siteTitle || "";
    }
    if (window.__docsNavRestore) window.__docsNavRestore();
    document.dispatchEvent(new Event("docs:ui-refresh"));
  };
  const post = async (path, body) => {
    // Tell HMR, so the watch notification for our own write (dooc.yaml etc.) doesn't reload.
    const res = await localeFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || String(res.status));
    return data;
  };

  const docAction = (item, action) => {
    if (item.hasAttribute("data-subformat-nav")) {
      document.dispatchEvent(new CustomEvent("docs:subformat-page-action", { detail: { id: item.dataset.docId, action } }));
      return;
    }
    if (window.__docsDocAction) {
      void window.__docsDocAction(item.dataset.docId, action);
    } else {
      const url = new URL(item.querySelector(":scope > .nav-row > a").href);
      url.searchParams.set("doc-action", action);
      location.href = url.href;
    }
  };
  document.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-doc-action]") : null;
    if (!button) return;
    event.preventDefault();
    docAction(button.closest(".nav-item"), button.dataset.docAction);
  });
  const editSiteTitle = (label) => {
    if (document.querySelector(".nav-rename-form")) return;
    const original = label.textContent;
    const baseTitle = label.dataset.title || null;
    const form = document.createElement("form");
    form.className = "nav-rename-form";
    form.title = t("Enter to save / Esc to cancel");
    const input = document.createElement("input");
    input.name = "title";
    input.value = original;
    input.required = true;
    input.maxLength = 256;
    input.setAttribute("aria-label", t("Site title"));
    form.append(input);
    label.replaceChildren(form);
    input.select();
    let busy = false;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      form.remove();
      label.textContent = original;
      void refresh();
    };
    form.addEventListener("focusout", (event) => {
      if (!busy && !form.contains(event.relatedTarget)) close();
    });
    form.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        close();
        label.focus();
      } else if (event.key === "Enter") {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy || closed || !input.value.trim()) return;
      busy = true;
      input.readOnly = true;
      try {
        const result = await post("/api/site-title", { title: input.value, baseTitle, language: new URL(location.href).searchParams.get("lang") });
        closed = true;
        form.remove();
        label.textContent = label.title = result.title;
        label.dataset.title = result.title;
        await refresh();
        label.focus();
        setStatus("", false);
      } catch (error) {
        setStatus(error.message, true);
        input.focus();
      } finally {
        busy = false;
        input.readOnly = false;
      }
    });
  };
  const editLabel = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest("button, input, form, .nav-doc-icon")) return;
    const label = target.closest("#site-title");
    if (label) {
      event.preventDefault();
      editSiteTitle(label);
      return;
    }
    const row = target.closest("#nav-groups [data-doc-id] > .nav-row");
    if (!row) return;
    event.preventDefault();
    docAction(row.closest("[data-doc-id]"), "rename");
  };
  document.addEventListener("dblclick", editLabel);
  document.addEventListener("keydown", (event) => { if (event.key === "F2" || (event.key === "Enter" && event.target.id === "site-title")) editLabel(event); });
  const setIcon = async (slot, file) => {
    if (file && !/\\.svg$/i.test(file.name) && file.type !== "image/svg+xml") {
      setStatus("Icon must be svg", true);
      return;
    }
    const id = slot.closest(".nav-item")?.dataset.docId;
    try {
      const data = file ? btoa(Array.from(new Uint8Array(await file.arrayBuffer()), (byte) => String.fromCharCode(byte)).join("")) : null;
      const result = await post(id ? "/api/icon" : "/api/site-icon", { file: id ? id + ".md" : undefined, data, theme: getComputedStyle(document.documentElement).colorScheme === "dark" ? "dark" : "light" });
      if (!id) {
        const logo = document.getElementById("site-icon");
        logo.src = result.icon;
        logo.hidden = false;
      }
      setStatus("", false);
      await refresh();
    } catch (error) {
      setStatus(error.message, true);
    }
  };
  document.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.closest(".nav-doc-icon, #site-icon-slot")) return;
    const file = input.files[0];
    input.value = "";
    if (file) void setIcon(input.closest(".nav-doc-icon, #site-icon-slot"), file);
  });
  document.addEventListener("click", (event) => {
    const clear = event.target instanceof Element ? event.target.closest(".nav-icon-clear") : null;
    if (!clear) return;
    event.preventDefault();
    void setIcon(clear.closest(".nav-doc-icon"), null);
  });
  document.addEventListener("dragover", (event) => {
    const slot = event.target instanceof Element ? event.target.closest(".nav-doc-icon, #sidebar-head") : null;
    if (!slot || !event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    slot.classList.add("over");
  });
  document.addEventListener("dragleave", (event) => {
    const slot = event.target instanceof Element ? event.target.closest(".nav-doc-icon, #sidebar-head") : null;
    if (slot && !slot.contains(event.relatedTarget)) slot.classList.remove("over");
  });
  document.addEventListener("drop", (event) => {
    const slot = event.target instanceof Element ? event.target.closest(".nav-doc-icon, #sidebar-head") : null;
    const file = event.dataTransfer?.files[0];
    if (!slot || !file) return;
    event.preventDefault();
    slot.classList.remove("over");
    void setIcon(slot, file);
  });

  let dragged = null;
  let drop = null; // { row, zone: "before" | "after" | "into" }
  const clearMarker = () => {
    for (const r of document.querySelectorAll(".nav-row.drop-before, .nav-row.drop-after, .nav-row.drop-into")) {
      r.classList.remove("drop-before", "drop-after", "drop-into");
    }
  };
  document.addEventListener("dragstart", (event) => {
    const row = event.target instanceof Element ? event.target.closest(".nav-row") : null;
    if (!row || !event.dataTransfer) return;
    if (event.target.closest("input, button, .nav-doc-icon") || row.classList.contains("renaming")) {
      event.preventDefault();
      return;
    }
    dragged = row.closest(".nav-item");
    dragged.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-doc-id", dragged.dataset.docId || "");
  });
  document.addEventListener("dragend", () => {
    if (dragged) dragged.classList.remove("dragging");
    clearMarker();
    dragged = null;
    drop = null;
  });
  document.addEventListener("dragover", (event) => {
    if (!dragged || !event.dataTransfer) return;
    const row = event.target instanceof Element ? event.target.closest("#nav-groups .nav-row") : null;
    const item = row && row.closest(".nav-item");
    // Can't drop onto itself or its own descendants (cycle).
    if (!item || !item.dataset.docId || dragged.contains(item)) { clearMarker(); drop = null; return; }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = row.getBoundingClientRect();
    const y = (event.clientY - rect.top) / rect.height;
    const zone = y < 0.25 ? "before" : y > 0.75 ? "after" : "into";
    clearMarker();
    row.classList.add("drop-" + zone);
    drop = { row, zone };
  });
  document.addEventListener("drop", async (event) => {
    if (!dragged || !drop) return;
    event.preventDefault();
    const id = dragged.dataset.docId;
    const item = drop.row.closest(".nav-item");
    let parent;
    let index;
    if (drop.zone === "into") {
      parent = item.dataset.docId;
      index = [...item.querySelector(":scope > .nav-list").children].filter((n) => n.dataset.docId && n !== dragged).length;
      if (window.__docsNavOpen) window.__docsNavOpen(parent, true);
    } else {
      const list = item.parentElement;
      parent = list.dataset.parent || undefined;
      const siblings = [...list.children].filter((n) => n.dataset.docId && n !== dragged);
      index = siblings.indexOf(item) + (drop.zone === "after" ? 1 : 0);
    }
    clearMarker();
    setStatus("Moving…", false);
    try {
      await post("/api/move", { id, parent, index });
      setStatus("Moved", false);
    } catch (error) {
      setStatus("Failed to move: " + error.message, true);
    }
    await refresh();
  });

  document.addEventListener("docs:files-changed", () => { void refresh(); });

  // ── Page type menu and in-sidebar create form ──
  const suggestFileName = ${suggestDocFileName.toString()};
  const availableSubformats = () => JSON.parse(document.querySelector("[data-page-subformats]")?.content.textContent || "[]");
  const closeForm = () => { for (const f of document.querySelectorAll(".nav-new-item")) f.remove(); };
  const openForm = (trigger) => {
    closeForm();
    const parent = trigger.dataset.parent || "";
    const host = parent
      ? document.querySelector('#nav-groups .nav-item[data-doc-id="' + CSS.escape(parent) + '"] > .nav-list')
      : document.querySelector("#nav-groups > .nav-list");
    if (!host) return;
    if (parent) window.__docsNavOpen(parent, true);
    const item = document.createElement("div");
    item.className = "nav-item nav-new-item";
    const row = document.createElement("div");
    row.className = "nav-row";
    const form = document.createElement("form");
    form.className = "nav-new";
    form.innerHTML =
      '<p class="nav-new-heading" data-i18n="Markdown page">Markdown page</p>' +
      '<input name="title" placeholder="title" data-i18n-placeholder="title" aria-label="title" data-i18n-aria-label="title" required autocomplete="off">' +
      '<div class="nav-new-file"><input name="name" placeholder="File name" data-i18n-placeholder="File name" aria-label="File name" data-i18n-aria-label="File name" required autocomplete="off" spellcheck="false"></div>' +
      '<div class="nav-new-actions"><button type="button" class="nav-new-cancel" data-i18n="Cancel">Cancel</button><button class="nav-new-go" type="submit" data-i18n="Create">Create</button></div>' +
      '<div class="err" role="alert"></div>';
    row.append(form);
    item.append(row);
    host.append(item);
    document.dispatchEvent(new Event("docs:ui-refresh"));
    const title = form.elements.namedItem("title");
    const nameInput = form.elements.namedItem("name");
    const submit = form.querySelector(".nav-new-go");
    const err = form.querySelector(".err");
    let nameTouched = false;
    let busy = false;
    const cancel = () => {
      if (busy) return;
      closeForm();
      trigger.focus();
    };
    form.querySelector(".nav-new-cancel").addEventListener("click", cancel);
    title.addEventListener("input", () => { if (!nameTouched) nameInput.value = suggestFileName(title.value); });
    nameInput.addEventListener("input", () => { nameTouched = true; });
    form.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    // Keep partially filled forms when focus moves elsewhere.
    form.addEventListener("focusout", (e) => {
      if (busy || form.contains(e.relatedTarget) || title.value.trim() || nameInput.value.trim()) return;
      setTimeout(() => { if (item.isConnected && !item.contains(document.activeElement)) item.remove(); }, 0);
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (busy) return;
      busy = submit.disabled = title.readOnly = nameInput.readOnly = true;
      submit.setAttribute("aria-busy", "true");
      err.textContent = "";
      try {
        await post("/api/create", { parent: parent || undefined, title: title.value.trim(), name: nameInput.value.trim() });
        closeForm();
        await refresh();
      } catch (error) {
        err.textContent = error.message;
      } finally {
        busy = submit.disabled = title.readOnly = nameInput.readOnly = false;
        submit.removeAttribute("aria-busy");
      }
    });
    item.scrollIntoView({ block: "nearest" });
    title.focus();
  };
  const menu = document.createElement("div");
  menu.id = "nav-page-menu";
  menu.className = "nav-page-menu";
  menu.popover = "auto";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", t("Page type"));
  menu.dataset.i18nAriaLabel = "Page type";
  menu.innerHTML = '<button type="button" role="menuitem" tabindex="-1" data-page-type="markdown">${DOCS_ICON}Markdown</button><button type="button" role="menuitem" tabindex="-1" data-page-type="subformat" aria-haspopup="menu" popovertarget="nav-subformat-menu">${SUBFORMATS_ICON}Subformat<span class="nav-page-chevron">${CHEVRON_ICON}</span></button><div id="nav-subformat-menu" class="subformat-picker-menu subformat-setting-menu" role="menu" aria-label="Subformat" popover="auto"></div><p class="err" role="alert"></p>';
  document.body.append(menu);
  const formatsMenu = menu.querySelector("#nav-subformat-menu");
  const formatTrigger = menu.querySelector('[data-page-type="subformat"]');
  const markdownTrigger = menu.querySelector('[data-page-type="markdown"]');
  const menuError = menu.querySelector(".err");
  let menuTrigger;
  let addingPage = false;
  const showMenu = (popup, trigger) => {
    popup.style.maxHeight = "";
    popup.showPopover();
    const rect = trigger.getBoundingClientRect();
    const top = popup === menu ? rect.top : rect.bottom + 4;
    const bottom = popup === menu ? rect.bottom : rect.top - 4;
    const above = innerHeight - top < popup.offsetHeight + 8 && bottom > innerHeight - top;
    Object.assign(popup.style, {
      left: Math.max(8, Math.min(rect.left, innerWidth - popup.offsetWidth - 8)) + "px",
      top: above ? "auto" : top + "px",
      bottom: above ? innerHeight - bottom + "px" : "auto",
      maxHeight: Math.max(80, (above ? bottom : innerHeight - top) - 8) + "px",
    });
    popup.querySelector("button:not(:disabled)")?.focus();
  };
  markdownTrigger.addEventListener("click", () => {
    if (addingPage) return;
    menu.hidePopover();
    openForm(menuTrigger);
  });
  formatTrigger.addEventListener("click", (event) => {
    event.preventDefault();
    if (addingPage) return;
    if (formatsMenu.matches(":popover-open")) { formatsMenu.hidePopover(); return; }
    formatsMenu.replaceChildren();
    for (const format of availableSubformats()) {
      const row = document.createElement("div");
      row.className = "subformat-setting-option";
      row.setAttribute("role", "none");
      const option = document.createElement("button");
      option.type = "button";
      option.tabIndex = -1;
      option.setAttribute("role", "menuitem");
      option.dataset.subformat = format.ext;
      option.textContent = format.ext;
      row.append(option);
      formatsMenu.append(row);
    }
    showMenu(formatsMenu, formatTrigger);
  });
  formatsMenu.addEventListener("click", async (event) => {
    const option = event.target.closest("button[data-subformat]");
    if (!option || addingPage) return;
    const parent = menuTrigger.dataset.parent || undefined;
    const subformat = option.dataset.subformat;
    addingPage = markdownTrigger.disabled = formatTrigger.disabled = true;
    menu.setAttribute("aria-busy", "true");
    menuError.textContent = "";
    setStatus("", false);
    formatsMenu.hidePopover();
    try {
      const result = await post("/api/create", { parent, subformat, title: subformat });
      menu.hidePopover();
      await refresh();
      if (result.path) {
        if (window.__docsNavigate) await window.__docsNavigate(result.path);
        else location.href = result.path;
      }
    } catch (error) {
      menuError.textContent = error.message;
      if (!menu.matches(":popover-open")) setStatus(error.message, true);
    } finally {
      addingPage = markdownTrigger.disabled = false;
      formatTrigger.disabled = !availableSubformats().length;
      menu.removeAttribute("aria-busy");
      if (menu.matches(":popover-open")) formatTrigger.focus();
    }
  });
  menu.addEventListener("keydown", (event) => {
    const popup = event.target.closest('[role="menu"]');
    const options = [...popup.querySelectorAll("button:not(:disabled)")].filter((button) => button.closest('[role="menu"]') === popup);
    const index = options.indexOf(document.activeElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length;
      options[next]?.focus();
    }
    if (event.key === "Escape" || event.key === "Tab") {
      const dismiss = event.key === "Tab" ? menu : popup;
      dismiss.hidePopover();
      (dismiss === menu ? menuTrigger : formatTrigger)?.focus();
      if (event.key === "Escape") event.preventDefault();
    }
  });
  document.addEventListener("click", (event) => {
    const btn = event.target instanceof Element ? event.target.closest("#sidebar .new, #sidebar .nav-create") : null;
    if (!btn) return;
    event.preventDefault();
    if (addingPage) return;
    if (menu.matches(":popover-open")) {
      menu.hidePopover();
      if (menuTrigger === btn) return;
    }
    menuTrigger = btn;
    const unavailable = !availableSubformats().length;
    formatTrigger.disabled = unavailable;
    formatTrigger.title = unavailable ? t("No subformats available to add.") : "";
    menuError.textContent = "";
    menu.setAttribute("aria-label", t("Page type"));
    showMenu(menu, btn);
  });
})();`
        : ""
}
// code block copy — delegated to document so it keeps working after edit's innerHTML swaps.
document.addEventListener("click", async (event) => {
  const button = event.target instanceof Element ? event.target.closest("button.section-copy") : null;
  if (!button) return;
  const label = (key) => window.__docsTranslate ? window.__docsTranslate(key) : key;
  button.classList.remove("ok", "error");
  try {
    await navigator.clipboard.writeText(new URL(button.dataset.sectionUrl, location.href).href);
    button.classList.add("ok");
    button.title = label("Copied");
  } catch {
    button.classList.add("error");
    button.title = label("Could not copy URL");
  }
  button.setAttribute("aria-label", button.title);
  setTimeout(() => {
    button.classList.remove("ok", "error");
    button.title = label("Copy section URL");
    button.setAttribute("aria-label", button.title);
  }, 1600);
});
document.addEventListener("click", (ev) => {
  const btn = ev.target instanceof Element ? ev.target.closest("button.codecopy") : null;
  if (!btn) return;
  const wrap = btn.closest(".codeblk");
  const code = wrap && wrap.querySelector("pre code");
  if (!code) return;
  navigator.clipboard.writeText(code.textContent || "").catch(() => {});
  btn.classList.add("ok");
  setTimeout(() => btn.classList.remove("ok"), 1200);
});
// Code blocks toggle from their border label.
document.addEventListener("click", (ev) => {
  const head = ev.target instanceof Element ? ev.target.closest(".codeblk-head") : null;
  if (!head || (ev.target instanceof Element && ev.target.closest("button.codecopy"))) return;
  const wrap = head.closest(".codeblk");
  if (!wrap) return;
  const collapsed = wrap.classList.toggle("collapsed");
  const button = head.querySelector(".codefold");
  if (button) {
    const label = collapsed ? "Expand code" : "Collapse code";
    button.setAttribute("aria-expanded", String(!collapsed));
    button.dataset.i18nTitle = label;
    button.dataset.i18nAriaLabel = label;
    const text = window.__docsTranslate ? window.__docsTranslate(label) : label;
    button.title = text;
    button.setAttribute("aria-label", text);
  }
});
</script>
<script>${inlineScript(`(${mountSearch.toString()})(${JSON.stringify(opts.publish ? searchIndex(site) : []).replace(/</g, "\\u003c")}, ${searchSections.toString()}, ${JSON.stringify(Object.fromEntries(SEARCH_LABELS.map((key) => [key, translate(site.defaultLang, key)]))).replace(/</g, "\\u003c")}, ${Boolean(opts.publish)});`)}</script>
${opts.publish ? `${opts.publish.pages}<script>${publishRouterScript(opts.publish.first)}${opts.publish.network && !opts.publish.pluginJs ? `\n(${mountBundleNetwork.toString()})();` : ""}</script>${opts.publish.pluginJs ? `<script>${inlineScript(opts.publish.pluginJs)}</script>` : ""}` : `<script>${hmrClientScript(mode)}</script>`}</body></html>`;
};

// A `</script` inside an inline <script> would close the script early, so escape it.
const inlineScript = (js: string): string => js.replace(/<\/(script)/gi, "<\\/$1");

// Router for the published output — keeps each route's main content in <template data-route>
// and swaps <main> based on location.hash (`#/<ancestor/.../docId>[#<anchor>]`) (works without a server).
const publishRouterScript = (first: string): string => `
(() => {
  const FIRST = ${JSON.stringify(first)};
  const main = document.querySelector("main");
  const pages = new Map([...document.querySelectorAll("template[data-route]")].map((t) => [t.dataset.route, t]));
  const show = () => {
    const [path, rawAnchor] = location.hash.slice(1).split("#");
    let anchor = "";
    try { anchor = decodeURIComponent(rawAnchor || ""); } catch {}
    const p = (path || "").split("?")[0].replace(/^\\/+|\\/+$/g, "");
    const route = pages.has(p) ? p : FIRST;
    const page = pages.get(route);
    const actions = main.querySelector(":scope > .page-actions");
    main.innerHTML = page.innerHTML;
    document.dispatchEvent(new Event("docs:page-shown"));
    if (actions) main.prepend(actions);
    document.title = page.dataset.title;
    for (const a of document.querySelectorAll("#nav-groups a")) {
      a.classList.toggle("cur", a.getAttribute("href").split("?")[0] === "#/" + route);
    }
    const cur = document.querySelector("#nav-groups a.cur");
    for (let it = cur && cur.closest(".nav-item").parentElement.closest(".nav-item"); it; it = it.parentElement.closest(".nav-item")) {
      it.classList.add("open");
    }
    (${focusNavTree.toString()})(document.getElementById("nav-groups"));
    const target = anchor && document.getElementById(anchor);
    requestAnimationFrame(() => {
      if (target) target.scrollIntoView(); else main.scrollTo(0, 0);
    });
  };
  window.addEventListener("hashchange", show);
  show();
})();`;

// Maps the server's absolute-path links (`/<route>`) and in-body anchors (`#<id>`) to the
// published output's hash routes.
const toHashLinks = (html: string, route: string): string =>
    html
        .replace(/(href|data-section-url)="\/(?!\/)/g, '$1="#/')
        .replace(/href="#(?!\/)/g, `href="#/${route}#`);

/**
 * Turns the whole Site into a single HTML file readable without a server (everything embedded,
 * down to figures / terms / schema graph JS). Each doc is held in a
 * <template> and switched via hash routes.
 */
export const publishHtml = (
    site: Site,
    graphJs: string,
    title = site.title ?? "dooc",
    codeJs = "",
    mode: "static" | "network" | "live" = "static",
    pluginJs = "",
    subformatJs = "",
): string => {
    const pages = site.entries.map((e) => ({
        route: docPath(site.entries, e.id).slice(1),
        title: docDisplayName(e.frontmatter, e.id),
        main: entryMain(site, e),
    }));
    const first = pages[0]?.route ?? "";
    if (site.ctx.terms.length > 0) {
        const terms = resourcesMain(site, "terms");
        if (terms) pages.push({ route: "_files/terms", ...terms });
    }
    const figureRefs = new Set(site.entries.flatMap((entry) => entry.figureRefs ?? []));
    for (const name of figureRefs) {
        const fig = site.ctx.figures.get(name);
        if (!fig) continue;
        const route = `_files/file/${encodeURIComponent(fig.file)}`;
        pages.push({ route, ...figurePage(site, fig) });
    }
    const templates = pages
        .map(
            (p) =>
                `<template data-route="${escapeHtml(p.route)}" data-title="${escapeHtml(pageTitle("preview", p.title, title))}">${toHashLinks(p.main, p.route)}</template>`,
        )
        .join("");
    return toHashLinks(
        page(
            "preview",
            { ...site, title },
            {
                title,
                main: "",
                publish: {
                    graphJs,
                    codeJs,
                    pages: templates,
                    first,
                    network: mode !== "static",
                    pluginJs: mode === "live" ? pluginJs : undefined,
                    subformatJs,
                },
            },
        ),
        first,
    );
};

// A doc's main content. A doc with an empty body and children (a chapter-heading-only doc) shows
// its children list in place of the body.
const entryMain = (site: Site, e: Entry): string => {
    const html = renderEntryHtml(site, e).html;
    const kids = childrenOf(site.entries, e.id);
    if (e.subformat || e.blocks.length > 0 || kids.length === 0) {
        return html;
    }
    const items = kids
        .map(
            (k) =>
                `<li><a href="${docPath(site.entries, k.id)}">${escapeHtml(docDisplayName(k.frontmatter, k.id))}</a></li>`,
        )
        .join("");
    return html.replace(/<\/article>\s*$/, `<ul class="idx">${items}</ul></article>`);
};

/**
 * Boot data for the client (edit-client.ts) — the same shape is passed for the initial render and
 * on doc switch. Insertion happens via the client's in-editor autocomplete (`/` palette), so the
 * candidate data (figures / docs / terms) is passed here, plus blockLines for the correspondence
 * display.
 */
export interface EditorBoot {
    gitBase: string | null;
    filePreviews: FilePreviewResults;
    previews?: PreviewSettings;
    siteTitle?: string;
    siteIcon?: string;
    contentLanguage?: string;
    sourceLanguage?: string;
    docLanguage?: string;
    translatedLanguages?: string[];
    /** `<id>.md` (the save API's key). */
    file: string;
    sourceFile?: string;
    /** Resolution key for published URLs. */
    docId: string;
    title: string;
    path: string;
    body: string;
    figures: string[];
    codeLanguages: readonly string[];
    docs: { ref: string; title: string }[];
    terms: TermEntry[];
    blockLines: number[];
    /** Full source on disk (the base for external-change detection). */
    baseRaw: string;
    /** Data URI of the sidebar icon (null if none). */
    icon: string | null;
    /** Site default language (used for lint when the `lang` field is left empty). */
    defaultLang: string;
    /** Language of the CodeMirror content's browser spellcheck (the doc language's adapter). */
    spellcheckLang: string;
}

export const languageFieldHtml = (
    defaultLang: string,
    language = contentLanguageCode(defaultLang),
    translatedLanguages: readonly string[] = [contentLanguageCode(defaultLang)],
    declaredLanguages?: readonly string[],
): string => {
    const existing = new Set(translatedLanguages);
    const options = [...contentLanguages]
        .filter(({ code }) => !declaredLanguages || declaredLanguages.includes(code))
        .sort((a, b) => Number(existing.has(b.code)) - Number(existing.has(a.code)))
        .map(
            ({ code, name }) =>
                `<option value="${code}" data-name="${escapeHtml(name)}" data-added="${existing.has(code)}"${code === language ? " selected" : ""}>${escapeHtml(name)} (${code})</option>`,
        )
        .join("");
    return `<div class="fm-language"><button class="pbtn" type="button" data-language-open aria-label="Change language" data-i18n-aria-label="Change language" aria-haspopup="listbox" aria-expanded="false" aria-controls="fm-lang-options">${GLOBE_ICON}</button><select id="fm-lang" data-source="${contentLanguageCode(defaultLang)}" aria-label="Change language" data-i18n-aria-label="Change language">${options}</select></div>`;
};

// The same thing is passed for the initial render (editorAside) and doc switch (`/api/page`)
// (= the client only has to handle one boot shape, initially and after a switch).
export const editorBoot = (entry: Entry, site: Site): EditorBoot => {
    // Completion candidates are files in the figures/ catalog.
    const figures = [...site.ctx.figures.values()].map((f) => f.file);
    const docs = site.entries
        .filter((e) => !e.subformat)
        .map((e) => ({
            ref: e.sourceFile ?? CONTENT_PREFIX + e.file,
            title: docDisplayName(e.frontmatter, e.id),
        }));
    return {
        gitBase: entryGitBase(entry, site),
        ...(site.title === undefined ? {} : { siteTitle: site.title }),
        ...(site.icon === undefined ? {} : { siteIcon: svgDataUri(site.icon) }),
        ...(entry.frontmatter?.lang ? { docLanguage: entry.frontmatter.lang } : {}),
        ...(entry.translatedLanguages ? { translatedLanguages: entry.translatedLanguages } : {}),
        ...(site.contentLanguage
            ? {
                  contentLanguage: site.contentLanguage,
                  sourceLanguage: contentLanguageCode(site.defaultLang),
              }
            : {}),
        file: entry.file,
        sourceFile: entry.sourceFile,
        docId: entry.id,
        title: entry.frontmatter?.title ?? "",
        path: docPath(site.entries, entry.id),
        body: entry.body,
        figures,
        codeLanguages: site.codeLanguages ?? CODE_LANGS,
        docs,
        terms: [...site.ctx.terms],
        blockLines: entry.blockLines,
        baseRaw: entry.raw,
        icon: entry.icon ? svgDataUri(entry.icon) : null,
        defaultLang: site.defaultLang,
        spellcheckLang: resolveLanguage(entry.lang, site.languages).spellcheckLang ?? entry.lang,
        filePreviews: filePreviewResults(entry, site),
        previews: site.previews,
    };
};

// Language and editor actions stay in the header; document actions live in the tree.
const editorAside = (entry: Entry, site: Site): { aside: string; boot: EditorBoot } => {
    const aside = `<aside id="panel"><div id="resize" class="panel-resize" role="separator" tabindex="0" aria-orientation="vertical" aria-controls="panel" aria-label="Resize editor" data-i18n-aria-label="Resize editor" title="Resize editor" data-i18n-title="Resize editor"></div>
<div id="phead">
${languageFieldHtml(site.defaultLang, site.contentLanguage, entry.translatedLanguages, site.contentLanguages)}
<span id="status"></span>
<button id="validate" class="pbtn" type="button" title="Validate and apply" data-i18n-title="Validate and apply" aria-label="Validate and apply" data-i18n-aria-label="Validate and apply">${icon('<path d="M5 5l-4 5 4 5M15 5l4 5-4 5M7 10l2 2 4-5"/>')}</button>
<button id="save" class="pbtn" data-state="saved" type="button" title="Save (Ctrl+S)" data-i18n-title="Save (Ctrl+S)" aria-label="Save" data-i18n-aria-label="Save">${icon('<path d="M3 3h11l3 3v11H3z"/><path d="M6 3v5h7V3M6 17v-6h8v6"/>')}</button>
<button id="split-preview" class="pbtn" type="button" aria-pressed="false" aria-label="Split view" data-i18n-aria-label="Split view" title="Split view" data-i18n-title="Split view">${icon('<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M10 3v14"/>')}</button>
<div id="gear"><button class="pbtn" type="button" aria-haspopup="true" aria-label="View settings" data-i18n-aria-label="View settings" title="View settings" data-i18n-title="View settings">${GEAR_ICON}</button><div id="gearmenu">
<div class="editor-setting"><span class="editor-setting-icon" data-setting-theme-icon aria-hidden="true"></span><div class="subformat-control"><span class="subformat-control-label" data-i18n="Editor theme">Editor theme</span><button class="setting-picker" type="button" data-theme-picker="editor" aria-label="Editor theme"><span data-picker-value></span>${SELECT_ICON}</button></div></div>
<div class="editor-setting"><span class="editor-setting-icon" aria-hidden="true">${FONT_ICON}</span><div class="subformat-control"><span class="subformat-control-label" data-i18n="Editor font">Editor font</span>${fontButton("editor")}</div></div>
<div id="language-setting" class="editor-setting">${GLOBE_ICON}<div class="subformat-control"><span class="subformat-control-label" data-i18n="Language">Editor language</span><select id="ui-language" aria-label="Editor language" data-i18n-aria-label="Language"><option value="eng">English</option><option value="jpn">日本語</option><option value="zho">中文</option></select></div></div>
<label><input type="checkbox" id="opt-autovalidate"><span data-i18n="Auto validate">Auto validate</span></label>
<label><input type="checkbox" id="opt-autosave"><span data-i18n="Auto save">Auto save</span></label>
<label><input type="checkbox" id="opt-corr"><span data-i18n="Source mapping">Source mapping</span></label>
<label><input type="checkbox" id="opt-git-diff"><span data-i18n="Show Git changes">Show Git changes</span></label>
<label><input type="checkbox" id="opt-line-wrap" checked><span data-i18n="Wrap lines">Wrap lines</span></label>
</div></div>
</div>

<div id="cm"></div>
</aside>`;
    return { aside, boot: editorBoot(entry, site) };
};

/**
 * Response for `GET /api/page?route=/<ancestor/.../docId>` (status + body). mode === "edit" only.
 * The diff for doing edit's doc switch via client-side navigation (= keep scroll position /
 * search term / open state without rebuilding the sidebar DOM); it returns only what the client
 * replaces: main html + the panel's variable parts (file name / front-matter fields) + the new
 * doc's boot.
 * File views replace the central workspace while retaining the current editor.
 */
export const pageDataResponse = (site: Site, path: unknown): { status: number; body: unknown } => {
    if (typeof path !== "string" || !path.startsWith("/")) {
        return { status: 400, body: { error: "route must be /<docId>" } };
    }
    if (
        path === "/_extensions" ||
        path === "/_subformats" ||
        path === "/_git" ||
        path === "/_statics" ||
        path.startsWith("/_statics/") ||
        path === "/_files" ||
        path.startsWith("/_files/")
    ) {
        try {
            const resource = resourcesMain(
                site,
                path.startsWith("/_statics")
                    ? path.slice(1)
                    : ["/_git", "/_extensions", "/_subformats"].includes(path)
                      ? path.slice(1)
                      : path.slice("/_files".length).replace(/^\/|\/$/g, ""),
            );
            return resource
                ? {
                      status: 200,
                      body: {
                          resource: true,
                          path,
                          title: pageTitle("edit", resource.title, site.title),
                          html: docLinks(site, resource.main),
                          sourceFile: resource.sourceFile,
                      },
                  }
                : { status: 404, body: { error: `${path} is not a file route` } };
        } catch {
            return { status: 400, body: { error: "Invalid file route" } };
        }
    }
    const id = resolveDocPath(site.entries, path);
    const doc = site.entries.find((e) => e.id === id);
    if (!doc) {
        return { status: 404, body: { error: `${path} is not a doc route` } };
    }
    const html = entryMain(site, doc);
    if (doc.subformat)
        return {
            status: 200,
            body: {
                resource: true,
                path,
                title: pageTitle("edit", docDisplayName(doc.frontmatter, doc.id), site.title),
                html,
            },
        };
    const errors = [...site.errors, ...doc.errors];
    return {
        status: 200,
        body: {
            title: pageTitle("edit", docDisplayName(doc.frontmatter, doc.id), site.title),
            file: doc.file,
            html,
            errors,
            toc: doc.toc,
            boot: editorBoot(doc, site),
            filePreviews: filePreviewResults(doc, site),
        },
    };
};

const readJson = async (
    req: IncomingMessage,
    limit?: number,
): Promise<Record<string, unknown> | undefined> => {
    try {
        const v: unknown = JSON.parse(await readBody(req, limit));
        return typeof v === "object" && v != null ? (v as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
};

const notFound = (res: ServerResponse, path: string): void => {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(`not found: ${path}`);
};

const sendJson = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
};

const sendOp = (res: ServerResponse, r: OpResult<object>): void => {
    if (isOpError(r)) {
        const { status, ...body } = r;
        sendJson(res, status, body);
    } else {
        sendJson(res, 200, { ok: true, ...r });
    }
};

const languageLinks = (html: string, locale: string): string =>
    html.replace(
        /href="(\/(?!\/)[^"#?]*)(#[^"]*)?"/g,
        (_match, path, hash = "") => `href="${path}?lang=${encodeURIComponent(locale)}${hash}"`,
    );

const sendPage = (res: ServerResponse, mode: ServeMode, site: Site, opts: PageOpts): void => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    const html = docLinks(site, page(mode, site, opts));
    res.end(site.contentLanguage ? languageLinks(html, site.contentLanguage) : html);
};

const readBody = (req: IncomingMessage, limit = 5_000_000): Promise<string> =>
    new Promise((resolve, reject) => {
        let data = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
            data += chunk;
            if (data.length > limit) {
                reject(new Error("body too large"));
                req.destroy();
            }
        });
        req.on("end", () => resolve(data));
        req.on("error", reject);
    });

// Preview refresh (/api/render) and save (/api/save) — they differ only in the disk write and
// share the response shape (the client can update the left pane straight from a save response).
const handleDraft = async (
    req: IncomingMessage,
    res: ServerResponse,
    save: boolean,
    locale: string,
): Promise<void> => {
    let parsedBody: unknown;
    try {
        parsedBody = JSON.parse(await readBody(req));
    } catch {
        sendJson(res, 400, { error: "invalid JSON body" });
        return;
    }
    const { file, frontmatter, body, baseRaw, textfiles } = (parsedBody ?? {}) as {
        file?: unknown;
        frontmatter?: unknown;
        body?: unknown;
        baseRaw?: unknown;
        textfiles?: unknown;
    };
    let fileDrafts: ReadonlyMap<string, string>;
    try {
        fileDrafts = previewTextfiles(root, textfiles);
    } catch (error) {
        sendJson(res, 400, { error: String(error) });
        return;
    }
    const target = resolveContentFile(file);
    if (!target) {
        sendJson(res, 400, { error: "file must be <id>.md" });
        return;
    }
    if (save && !existsSync(target.abs)) {
        sendJson(res, 404, { error: `${target.name} not found (use + in the nav to create)` });
        return;
    }
    // So that autosave never silently overwrites external changes (direct edits / git pull etc.),
    // compare the current disk content with the base (the raw the client last read) right before
    // saving. If they differ, skip the write and return the disk content for the client to load
    // into the editor (= the md file wins).
    const site = loadSite(locale);
    const currentRaw = save
        ? (site.entries.find((entry) => entry.id === target.id)?.raw ??
          readFileSync(target.abs, "utf8"))
        : undefined;
    if (save && currentRaw !== undefined && isExternallyModified(baseRaw, currentRaw)) {
        const { raw: _raw, ...doc } = renderDocFile(site, target.name, currentRaw);
        sendJson(res, 200, { ...doc, saved: false, conflict: true, raw: currentRaw });
        return;
    }
    const fm = sanitizeFrontmatter(frontmatter);
    const text = typeof body === "string" ? body : "";
    if (locale !== contentLanguageCode(site.defaultLang)) fm.lang = locale;
    const raw = assembleDoc(fm, text);
    if (save) {
        if (locale === contentLanguageCode(site.defaultLang)) writeFileSync(target.abs, raw);
        else {
            const file = translationFile(
                sourceDocFile(target.id, readManifest(root).files),
                locale,
            );
            const base = existsSync(textfilePath(root, file)) ? (currentRaw ?? null) : null;
            if (!writeTextfile(root, file, raw, base)) {
                sendJson(res, 409, { error: "Translation changed. Reload before saving." });
                return;
            }
        }
    }
    const draft = renderDraft(save ? loadSite(locale) : site, target.name, raw, fileDrafts);
    sendJson(res, 200, { ...draft, saved: save, conflict: false, raw });
};

// Prose lint (/api/lint) = the `lint` of the doc language's adapter (language socket); languages
// without one return no findings. Lints the body string (same coordinate system as the CM doc)
// and returns findings with offsets — spellchecking is left to the browser (client side).
const handleLint = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let parsedBody: unknown;
    try {
        parsedBody = JSON.parse(await readBody(req));
    } catch {
        sendJson(res, 400, { error: "invalid JSON body" });
        return;
    }
    const { body, lang } = (parsedBody ?? {}) as { body?: unknown; lang?: unknown };
    const tag =
        typeof lang === "string" && isLangTag(lang)
            ? lang
            : (readManifest(root).defaultLang ?? DEFAULT_LANG);
    const { lint } = resolveLanguage(tag, siteLanguages.languages);
    const findings = lint ? await lint(typeof body === "string" ? body : "") : [];
    sendJson(res, 200, { findings });
};

// Create a new doc; the sidebar refresh keeps the current document open.
const handleCreate = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJson(req);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const parent = typeof body?.parent === "string" && body.parent !== "" ? body.parent : undefined;
    const result =
        typeof body?.subformat === "string"
            ? ops.addSubformat(body.subformat, title, parent)
            : ops.addFile(name, title, parent);
    sendOp(
        res,
        isOpError(result) ? result : { ...result, path: docPath(loadSite().entries, result.id) },
    );
};

// Add a figure (sidebar file picker / drag-and-drop). Returns the written file name
// (the client inserts ![](figures/<file>)).
const handleFigure = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJson(req);
    if (typeof body?.name !== "string" || typeof body?.data !== "string") {
        sendJson(res, 400, { error: "specify an svg / png / webp / jpeg / html file" });
        return;
    }
    const result = ops.addFigure(body.name, Buffer.from(body.data, "base64"));
    sendOp(
        res,
        isOpError(result) ? result : { ...result, path: result.path ?? `figures/${result.file}` },
    );
};

// Doc icon (the header's icon slot). data = base64 of an svg (null = remove). Pads it to 1:1 and
// writes icons/<id>.svg. Response icon = the new data URI (null if removed).
const handleIcon = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJson(req);
    const manifest = readManifest(root);
    if (manifest.errors.length) {
        sendJson(res, 409, { error: manifest.errors.join("\n") });
        return;
    }
    const requestedId = typeof body?.file === "string" ? docIdOfFile(body.file) : undefined;
    const page = flattenTree(manifest.tree).find(
        (node) => node.id === requestedId && node.subformat,
    );
    const target = page ? undefined : resolveContentFile(body?.file);
    const id = page?.id ?? (target && existsSync(target.abs) ? target.id : undefined);
    if (!id) {
        sendJson(res, 404, { error: "target doc not found" });
        return;
    }
    const previous = docIconFile(id, manifest.files);
    const file =
        manifest.format !== "nested" &&
        manifest.files?.defaultLayout !== false &&
        !Object.hasOwn(manifest.files?.icons ?? {}, id) &&
        !existsSync(textfilePath(root, previous))
            ? defaultFilePath(`${id}-icon.svg`)
            : previous;
    const path = textfilePath(root, file);
    if (body?.data == null) {
        if (existsSync(path)) {
            unlinkSync(path);
        }
        if (manifest.files?.icons && Object.hasOwn(manifest.files.icons, id)) {
            delete manifest.files.icons[id];
            writeManifest(root, manifest.tree, manifest);
        }
        sendJson(res, 200, { ok: true, icon: null });
        return;
    }
    const svg =
        typeof body.data === "string"
            ? squareSvg(Buffer.from(body.data, "base64").toString("utf8"))
            : undefined;
    if (!svg) {
        sendJson(res, 400, { error: "specify an svg (viewBox or width / height required)" });
        return;
    }
    if (file !== previous && existsSync(path)) {
        sendJson(res, 409, { error: "File already exists" });
        return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, svg);
    if (file !== previous) {
        manifest.files ??= parseFileLayout({});
        manifest.files.icons ??= {};
        manifest.files.icons[id] = file;
        writeManifest(root, manifest.tree, manifest);
    }
    sendJson(res, 200, { ok: true, icon: svgDataUri(svg) });
};

// Sidebar DnD move (reorder + reparent). Rewrites only dooc.yaml (file / id unchanged).
const handleMove = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJson(req);
    const { id, parent, index } = body ?? {};
    if (
        typeof id !== "string" ||
        (parent !== undefined && typeof parent !== "string") ||
        typeof index !== "number"
    ) {
        sendJson(res, 400, { error: "id / parent? / index required" });
        return;
    }
    sendOp(res, ops.move(id, parent, index));
};

// Rename the source file, update its references, and preserve the document's URL.
const handleRename = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJson(req);
    const target = resolveContentFile(body?.file);
    if (!target) {
        sendJson(res, 404, { error: "target doc not found" });
        return;
    }
    try {
        const snapshot = filesSnapshot(root);
        const file = sourceDocFile(target.id, snapshot.layout);
        if (body?.sourceFile !== file) throw new Error("Files changed. Reload before retrying.");
        const result = updateFiles(root, {
            action: "rename",
            file,
            name: typeof body?.name === "string" ? body.name.trim() : "",
            revision: snapshot.revision,
        });
        sendOp(res, {
            path: docPath(loadSite().entries, target.id),
            sourceFile: sourceDocFile(target.id, result.layout),
        });
    } catch (error) {
        sendJson(res, 409, { error: error instanceof Error ? error.message : String(error) });
    }
};

// Delete a doc. If it's referenced, refuse without force and return the referrers (the client
// confirms and resends with force). Response parent = where to navigate after deletion.
const handleDelete = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJson(req);
    const target = resolveContentFile(body?.file);
    if (!target) {
        sendJson(res, 404, { error: "target doc not found" });
        return;
    }
    const result = ops.remove(target.id, body?.force === true);
    sendOp(
        res,
        isOpError(result)
            ? result
            : {
                  ...result,
                  path: result.parent ? docPath(loadSite().entries, result.parent) : "/",
              },
    );
};

/** Cache of entry name → { js, etag }. clear() is called on HMR "client" notifications
 * (changes to edit-client.ts / the schema graph interaction layer) (= invalidation is
 * startServer's job; this is just the container). */
export interface BundleCache {
    get: (entry: string, build: () => Promise<string>) => Promise<{ js: string; etag: string }>;
    clear: () => void;
}

export const createBundleCache = (): BundleCache => {
    const store = new Map<string, { js: string; etag: string }>();
    return {
        get: async (entry, build) => {
            const hit = store.get(entry);
            if (hit) {
                return hit;
            }
            const js = await build();
            const etag = `"${createHash("sha256").update(js).digest("hex")}"`;
            const value = { js, etag };
            store.set(entry, value);
            return value;
        },
        clear: () => store.clear(),
    };
};

// The npm package (running as dist/*.js) has no src/, so read the prebuilt bundles.
const PREBUILT: Record<string, string> = {
    "core/schema-graph-global.tsx": "flow.global.js",
    "viewer/edit-client.ts": "edit.global.js",
    "viewer/ui-client.ts": "ui.global.js",
    "viewer/code-highlight.ts": "code.global.js",
    "viewer/code-worker.ts": "code-worker.global.js",
    "viewer/published-plugins.ts": "plugins.global.js",
    "viewer/published-subformats.ts": "subformats.global.js",
};

/** Minified client bundle shared by local viewing and published HTML. */
export const bundleClient = async (entry: string): Promise<string> => {
    const prebuilt = PREBUILT[entry];
    if (usePrebuiltAssets && prebuilt) {
        return readViewerAsset(prebuilt).toString("utf8");
    }
    const esbuild = await import("esbuild");
    const out = await esbuild.build({
        entryPoints: [join(pkgRoot, "src", entry)],
        bundle: true,
        format: "iife",
        target: "es2022",
        write: false,
        minify: true,
    });
    return out.outputFiles?.[0]?.text ?? "";
};

export const startServer = async (
    mode: ServeMode,
    port = 5179,
    pluginModule?: string,
    startup?: { file?: string; data?: string; login?: string },
): Promise<ViewerRuntime> => {
    // Language adapters are read once; the manifest is re-read by the compiler.
    siteLanguages = await loadSiteLanguages(root);
    const viewerPlugins = await loadViewerPlugins(pluginModule);
    workspaceSource = viewerPlugins.workspace;
    let gitOrigin = viewerPlugins.gitOrigin;
    const handleGit = createGitHandler(root, () => gitOrigin);
    const personal = createLocalPluginStorage();
    const handlePlugins = createPluginHandler(
        viewerPlugins.plugins,
        viewerPlugins,
        personal.credentials,
    );
    const handleExtensions = createExtensionManager(root, handlePlugins, viewerPlugins, personal);
    let loginPlugins = startup?.login ? [startup.login] : [];
    process.once("exit", handleExtensions.dispose);
    // Client bundles (bundleClient) = edit's editing UI and the schema graph interaction layer
    // shared by preview/edit. React Flow's stylesheet isn't mixed into the bundle — the mount
    // layer (flow-css.ts) injects it into a <style> at runtime, so the page needs no CSS delivery
    // path (same conditions as the published output).
    // Cache the bundle result + etag per entry (graph.js / edit.js) — this path isn't hit by the
    // per-keystroke /api/render / /api/save, but tsx watch doesn't restart for these, so
    // invalidate explicitly on the watcher's "client" notification (changes to edit-client.ts /
    // the schema graph interaction layer's src/*.tsx).
    const bundleCache = createBundleCache();
    let graphChunks: Promise<Map<string, string>> | undefined;
    const graphAsset = async (name: string): Promise<string> => {
        if (usePrebuiltAssets) return readViewerAsset(`graph/${name}`).toString("utf8");
        graphChunks ??= import("esbuild")
            .then(async (esbuild) => {
                const output = await esbuild.build({
                    entryPoints: [join(pkgRoot, "src/core/schema-graph-global.tsx")],
                    bundle: true,
                    splitting: true,
                    format: "esm",
                    target: "es2022",
                    outdir: join(pkgRoot, "dist/graph"),
                    write: false,
                    minify: true,
                });
                return new Map(output.outputFiles.map((file) => [basename(file.path), file.text]));
            })
            .catch((error) => {
                graphChunks = undefined;
                throw error;
            });
        const js = (await graphChunks).get(name);
        if (js === undefined) throw new Error("Diagram asset not found");
        return js;
    };

    // HMR — bootId changes on every process start. It's how the client detects a tsx watch
    // restart.
    const hub = createHmrHub(`${process.pid}-${Date.now()}`);
    const viewer: ViewerRuntime = {
        register: handlePlugins.register,
        unregister: handlePlugins.unregister,
        setWorkspace(workspace) {
            workspaceSource = workspace === undefined ? undefined : parseWorkspaceSource(workspace);
            hub.broadcast("content", []);
        },
        setGitOrigin(origin) {
            gitOrigin = origin === undefined ? undefined : validateGitOrigin(origin);
        },
        setAllowedDomains(domains) {
            if (!Array.isArray(domains)) throw new Error("Allowed domains must be a list");
            const previews = parsePreviewSettings({ domains });
            applicationPreviews = previews;
            compiler = createCompiler(root, { previews });
            localeCompilers.clear();
            hub.broadcast("content", []);
        },
    };
    viewer.setAllowedDomains(viewerPlugins.allowedDomains ?? []);
    await viewerPlugins.setup?.(viewer);
    const extensionErrors = await handleExtensions
        .restore()
        .catch((error: unknown) => [error instanceof Error ? error.message : String(error)]);
    for (const error of extensionErrors) console.error(`Plugin: ${error}`);
    if (startup?.file && startup.data) {
        const result = (await handleExtensions({
            action: "install",
            file: startup.file,
            data: startup.data,
            base: null,
        })) as { items: import("../core/extension-package.js").ExtensionSummary[] };
        loginPlugins = result.items.find((item) => item.file === startup.file)?.plugins ?? [];
        console.log(`Installed ${startup.file} in ${join(root, EXTENSIONS_DIR)}`);
    }

    // DOCS_HMR=0 = no hot reload (nothing is watched = changes need a manual reload).
    if (process.env.DOCS_HMR !== "0") {
        const watcher = watchProject(root, pkgRoot, (kind, files) => {
            console.log(`hmr: ${kind} (${files.join(", ")})`);
            if (kind === "client") {
                bundleCache.clear();
                graphChunks = undefined;
            }
            hub.broadcast(kind, files);
        });
        watchTextfiles = watcher.watchTextfiles;
        process.once("exit", watcher.close);
    }

    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (await handlePlugins(req, res)) return;
        const requestUrl = new URL(req.url ?? "/", "http://localhost");
        const requestedLanguage =
            req.headers["x-docs-language"] ??
            requestUrl.searchParams.get("lang") ??
            contentLanguageCode(readManifest(root).defaultLang ?? DEFAULT_LANG);
        if (typeof requestedLanguage !== "string" || !isContentLanguage(requestedLanguage)) {
            sendJson(res, 400, { error: "Expected an ISO 639-3 language code" });
            return;
        }
        const locale = requestedLanguage;
        const path = decodeURIComponent(requestUrl.pathname);

        if (req.method === "GET" && path.startsWith("/assets/fonts/")) {
            const font = readFont(path.slice("/assets/fonts/".length));
            if (!font) {
                notFound(res, path);
                return;
            }
            res.writeHead(200, {
                "content-type": "font/woff2",
                "cache-control": "public, max-age=86400",
            });
            res.end(font);
            return;
        }
        // No favicon (this only silences the 404 console error from the browser's auto-request).
        if (path === "/favicon.ico") {
            res.writeHead(204);
            res.end();
            return;
        }
        if (req.method === "GET" && path === HMR_PATH) {
            hub.handle(res);
            return;
        }
        // Client bundles — graph.js (the schema graph interaction layer) is shared by
        // preview / edit, edit.js is for the editing UI only.
        const clientEntry =
            path === "/assets/code.js"
                ? "viewer/code-highlight.ts"
                : path === "/assets/code-worker.js"
                  ? "viewer/code-worker.ts"
                  : mode === "edit" && path === "/assets/edit.js"
                    ? "viewer/edit-client.ts"
                    : path === "/assets/ui.js"
                      ? "viewer/ui-client.ts"
                      : undefined;
        const graphName =
            path === "/assets/graph.js"
                ? "schema-graph-global.js"
                : /^\/assets\/graph\/([\w-]+\.js)$/.exec(path)?.[1];
        if (req.method === "GET" && (clientEntry != null || graphName)) {
            const { js, etag } = await bundleCache.get(
                graphName ? path : (clientEntry ?? ""),
                () =>
                    graphName
                        ? path === "/assets/graph.js"
                            ? Promise.resolve('import "/assets/graph/schema-graph-global.js";')
                            : graphAsset(graphName)
                        : bundleClient(clientEntry ?? ""),
            );
            if (req.headers["if-none-match"] === etag) {
                res.writeHead(304, { etag, "cache-control": "no-cache" });
                res.end();
                return;
            }
            res.writeHead(200, {
                "content-type": "application/javascript; charset=utf-8",
                etag,
                "cache-control": "no-cache",
            });
            res.end(js);
            return;
        }
        if (mode === "edit" && req.method === "POST") {
            if (path === "/api/extensions") {
                res.setHeader("cache-control", "no-store");
                if (
                    !isLocalToolRequest(
                        req.headers.host ?? "",
                        req.headers.origin,
                        req.headers["content-type"],
                    ) ||
                    ![
                        `localhost:${req.socket.localPort}`,
                        `127.0.0.1:${req.socket.localPort}`,
                        `[::1]:${req.socket.localPort}`,
                    ].includes(req.headers.host ?? "")
                ) {
                    sendJson(res, 403, {
                        error: "Plugins require a same-origin local editor request",
                    });
                    return;
                }
                try {
                    const input = await readJson(req, MAX_EXTENSION_BYTES * 6 + 4096);
                    if (!input) throw new Error("Expected a plugin request");
                    sendJson(res, 200, await handleExtensions(input));
                } catch (error) {
                    sendJson(res, 409, {
                        error: error instanceof Error ? error.message : "Plugin operation failed",
                    });
                }
                return;
            }
            if (path === "/api/git") {
                res.setHeader("cache-control", "no-store");
                if (
                    !isLocalToolRequest(
                        req.headers.host ?? "",
                        req.headers.origin,
                        req.headers["content-type"],
                    ) ||
                    (req.headers.host !== `localhost:${req.socket.localPort}` &&
                        req.headers.host !== `127.0.0.1:${req.socket.localPort}` &&
                        req.headers.host !== `[::1]:${req.socket.localPort}`)
                ) {
                    sendJson(res, 403, {
                        error: "Git requires a same-origin local editor request",
                    });
                    return;
                }
                try {
                    if ((workspaceSource ?? readWorkspaceSource(root)).protocol !== "git")
                        throw new Error("Git workspace is not available");
                    const input = await readJson(req, 1_048_576);
                    const result = await handleGit(input);
                    if (
                        workspaceSource?.protocol === "git" &&
                        (input?.action === "switch" || input?.action === "branch")
                    ) {
                        const local = readWorkspaceSource(root);
                        if (local.protocol === "git")
                            workspaceSource = { ...workspaceSource, branch: local.branch };
                    }
                    sendJson(res, 200, result);
                } catch (error) {
                    sendJson(res, 409, {
                        error: error instanceof Error ? error.message : "Git operation failed",
                    });
                }
                return;
            }
            if (path === "/api/files") {
                if (
                    !isLocalToolRequest(
                        req.headers.host ?? "",
                        req.headers.origin,
                        req.headers["content-type"],
                    )
                ) {
                    sendJson(res, 403, {
                        error: "Files require a same-origin local editor request",
                    });
                    return;
                }
                try {
                    const input = await readJson(
                        req,
                        Math.ceil((MAX_FILE_UPLOAD_BYTES * 4) / 3) + 16_384,
                    );
                    if (!input) throw new Error("Invalid file request");
                    const result =
                        input.action === "complete"
                            ? completeFilePaths(root, input.prefix)
                            : input.action === "read"
                              ? filesSnapshot(root)
                              : input.action === "upload"
                                ? uploadFile(root, input)
                                : updateFiles(root, input);
                    sendJson(res, 200, result);
                } catch (error) {
                    sendJson(res, 409, {
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
                return;
            }
            if (path === "/api/subformat") {
                if (
                    !isLocalToolRequest(
                        req.headers.host ?? "",
                        req.headers.origin,
                        req.headers["content-type"],
                    )
                ) {
                    sendJson(res, 403, {
                        error: "Record changes require a same-origin local editor request",
                    });
                    return;
                }
                const result = subformatResponse(
                    root,
                    await readJson(req),
                    applicationPreviews.domains,
                );
                sendJson(res, result.status, result.body);
                return;
            }
            if (path === "/api/code-file") {
                if (
                    !isLocalToolRequest(
                        req.headers.host ?? "",
                        req.headers.origin,
                        req.headers["content-type"],
                    )
                ) {
                    sendJson(res, 403, {
                        error: "Code tools require a same-origin local editor request",
                    });
                    return;
                }
                const result = codeFileResponse(root, await readJson(req), applicationPreviews);
                sendJson(res, result.status, result.body);
                return;
            }
            if (path === "/api/textfile") {
                if (
                    !isLocalToolRequest(
                        req.headers.host ?? "",
                        req.headers.origin,
                        req.headers["content-type"],
                    )
                ) {
                    sendJson(res, 403, {
                        error: "Text files require a same-origin local editor request",
                    });
                    return;
                }
                const input = await readJson(req);
                if (input?.action === "preview") {
                    try {
                        if (typeof input.file !== "string") throw new Error("Expected a file path");
                        const files = previewTextfiles(root, {
                            [input.file]: input.content,
                        });
                        const [file, content] = [...files][0] as [string, string];
                        sendJson(res, 200, {
                            html: textfilePreviewHtml(loadSite(locale), file, content),
                        });
                    } catch (error) {
                        sendJson(res, 400, { error: String(error) });
                    }
                    return;
                }
                if (input?.action === "validate") {
                    try {
                        if (
                            typeof input.file !== "string" ||
                            typeof input.content !== "string" ||
                            isRemoteTextfile(input.file)
                        )
                            throw new Error("Invalid text file tool request");
                        previewTextfiles(root, { [input.file]: input.content });
                        const name = textfileName(input.file);
                        const extension = (name.split(".").at(-1) || name).toLowerCase();
                        const grammar = siteLanguages.codeGrammars?.find(
                            (entry) =>
                                entry.name === extension || entry.aliases?.includes(extension),
                        );
                        const language = existsSync(
                            join(root, ".dooc/editor-tools", `${extension}.json`),
                        )
                            ? extension
                            : (readManifest(root).subformats?.find(
                                  (config) => config.ext === extension,
                              )?.format ??
                              grammar?.name ??
                              extension);
                        const result = await validateTextfileCode(root, language, input.content);
                        for (const message of textfilePreviewErrors(
                            loadSite(locale),
                            input.file,
                            result.content,
                        ))
                            result.findings.push({
                                message,
                                range: [0, result.content.length],
                                ruleId: "preview",
                            });
                        sendJson(res, 200, result);
                    } catch (error) {
                        sendJson(res, 400, {
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                    return;
                }
                const result = await textfileResponse(root, input, applicationPreviews.domains);
                if (
                    result.status === 200 &&
                    typeof input?.file === "string" &&
                    !isRemoteTextfile(input.file)
                ) {
                    result.body.gitBase =
                        (workspaceSource ?? readWorkspaceSource(root)).protocol === "git"
                            ? gitBaseText(root, input.file)
                            : null;
                }
                sendJson(res, result.status, result.body);
                return;
            }
            if (path === "/api/render" || path === "/api/save") {
                await handleDraft(req, res, path === "/api/save", locale);
                return;
            }
            if (path === "/api/translation") {
                if (
                    !isLocalToolRequest(
                        req.headers.host ?? "",
                        req.headers.origin,
                        req.headers["content-type"],
                    )
                ) {
                    sendJson(res, 403, {
                        error: "Translations require a same-origin local editor request",
                    });
                    return;
                }
                const input = await readJson(req);
                const target = resolveContentFile(input?.file);
                if (
                    !target ||
                    typeof input?.language !== "string" ||
                    typeof input.added !== "boolean"
                ) {
                    sendJson(res, 400, { error: "file / language / added required" });
                    return;
                }
                try {
                    setDocTranslation(
                        root,
                        contentLanguageCode(readManifest(root).defaultLang ?? DEFAULT_LANG),
                        target.id,
                        input.language,
                        input.added,
                    );
                    sendJson(res, 200, {
                        translatedLanguages: loadSite().entries.find(
                            (entry) => entry.id === target.id,
                        )?.translatedLanguages,
                    });
                } catch (error) {
                    sendJson(res, 400, { error: String(error) });
                }
                return;
            }
            if (path === "/api/code-tool") {
                if (
                    !isLocalToolRequest(
                        req.headers.host ?? "",
                        req.headers.origin,
                        req.headers["content-type"],
                    )
                ) {
                    sendJson(res, 403, {
                        error: "Code tools require a same-origin local editor request",
                    });
                    return;
                }
                const input = await readJson(req);
                const target = resolveContentFile(input?.file);
                if (
                    !target ||
                    !existsSync(target.abs) ||
                    typeof input?.body !== "string" ||
                    (input.action !== "validate" && typeof input.position !== "number") ||
                    (input.action !== "format" &&
                        input.action !== "lint" &&
                        input.action !== "validate")
                ) {
                    sendJson(res, 400, { error: "Invalid code tool request" });
                    return;
                }
                try {
                    sendJson(
                        res,
                        200,
                        input.action === "validate"
                            ? await validateCodeTools(root, input.body)
                            : await runCodeTool(
                                  root,
                                  input.body,
                                  Number(input.position),
                                  input.action,
                              ),
                    );
                } catch (error) {
                    sendJson(res, 400, {
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
                return;
            }
            if (path === "/api/lint") {
                await handleLint(req, res);
                return;
            }
            if (path === "/api/create") {
                await handleCreate(req, res);
                return;
            }
            if (path === "/api/subformat-page") {
                if (
                    !isLocalToolRequest(
                        req.headers.host ?? "",
                        req.headers.origin,
                        req.headers["content-type"],
                    )
                ) {
                    sendJson(res, 403, {
                        error: "Page changes require a same-origin local editor request",
                    });
                    return;
                }
                const body = await readJson(req);
                const id = typeof body?.id === "string" ? body.id : "";
                if (!loadSite().entries.some((entry) => entry.id === id && entry.subformat)) {
                    sendJson(res, 404, { error: "Subformat page not found" });
                    return;
                }
                sendOp(
                    res,
                    body?.action === "delete"
                        ? ops.remove(id)
                        : body?.action === "rename" && typeof body.title === "string"
                          ? ops.renameSubformat(id, body.title)
                          : { status: 400, error: "Unknown page action" },
                );
                return;
            }
            if (path === "/api/icon") {
                await handleIcon(req, res);
                return;
            }
            if (path === "/api/site-icon" || path === "/api/site-title") {
                if (
                    !isLocalToolRequest(
                        req.headers.host ?? "",
                        req.headers.origin,
                        req.headers["content-type"],
                    )
                ) {
                    sendJson(res, 403, {
                        error: "Site settings require a same-origin local editor request",
                    });
                    return;
                }
                const input = await readJson(req);
                const result =
                    path === "/api/site-title"
                        ? siteTitleResponse(root, input)
                        : siteIconResponse(root, input);
                sendJson(res, result.status, result.body);
                return;
            }
            if (path === "/api/figure") {
                await handleFigure(req, res);
                return;
            }
            if (path === "/api/move") {
                await handleMove(req, res);
                return;
            }
            if (path === "/api/rename") {
                await handleRename(req, res);
                return;
            }
            if (path === "/api/delete") {
                await handleDelete(req, res);
                return;
            }
        }

        if (req.method === "GET" && path === "/assets/code-grammars.json") {
            const grammars = subformatCodeGrammars(
                siteLanguages.codeGrammars ?? [],
                readManifest(root).subformats,
            );
            const language = requestUrl.searchParams.get("language");
            const json = JSON.stringify(
                language === null ? grammars : selectCodeGrammars(grammars, [language]),
            );
            const etag = `"${createHash("sha256").update(json).digest("hex")}"`;
            res.writeHead(req.headers["if-none-match"] === etag ? 304 : 200, {
                "content-type": "application/json; charset=utf-8",
                "cache-control": "no-cache",
                etag,
            });
            res.end(req.headers["if-none-match"] === etag ? undefined : json);
            return;
        }

        const site = loadSite(locale);
        if (req.method === "GET" && path === "/api/figure-preview") {
            const figure = [...site.ctx.figures.values()].find(
                (figure) => figure.file === requestUrl.searchParams.get("file"),
            );
            if (!figure) {
                notFound(res, path);
                return;
            }
            res.writeHead(200, {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-store",
            });
            res.end(
                figureFrameHtml(
                    figure,
                    `fig-frame res-${figure.kind}`,
                    requestUrl.searchParams.get("label") ?? undefined,
                ),
            );
            return;
        }
        if (req.method === "GET" && path === "/api/search") {
            sendJson(
                res,
                200,
                searchIndex(
                    site,
                    mode === "edit"
                        ? (site.filePaths ?? filesSnapshot(root).files.map((file) => file.path))
                        : [],
                ),
            );
            return;
        }
        // edit-mode-only APIs (used by edit-client.ts). handle() strips the query from path, so
        // the query is read from req.url via URL/URLSearchParams.
        if (mode === "edit" && req.method === "GET" && path === "/api/nav") {
            const params = new URL(req.url ?? "/", "http://localhost").searchParams;
            sendJson(res, 200, {
                siteTitle: site.title,
                siteIcon: site.icon ? svgDataUri(site.icon) : undefined,
                translatedLanguages: site.entries.find(
                    (entry) => entry.id === requestUrl.searchParams.get("current"),
                )?.translatedLanguages,
                html: navGroupsHtml(
                    mode,
                    site,
                    params.get("current") || undefined,
                    params.get("res") ?? undefined,
                ),
            });
            return;
        }
        if (mode === "edit" && req.method === "GET" && path === "/api/page") {
            const params = new URL(req.url ?? "/", "http://localhost").searchParams;
            const { status, body } = pageDataResponse(site, params.get("route"));
            sendJson(res, status, body);
            return;
        }
        if (mode === "edit" && req.method === "GET" && path === "/api/doc") {
            const params = new URL(req.url ?? "/", "http://localhost").searchParams;
            const { status, body } = docQueryResponse(site, params.get("file"));
            sendJson(res, status, body);
            return;
        }
        // "/" redirects to the first doc (the canonical URL follows the manifest hierarchy). In edit with 0
        // docs, an empty page (the first doc is created via "add doc" at the end of the sidebar).
        if (path === "/") {
            const first = site.entries[0];
            if (first) {
                res.writeHead(302, {
                    location: `${docPath(site.entries, first.id)}?lang=${encodeURIComponent(locale)}`,
                });
                res.end();
                return;
            }
            if (mode === "edit") {
                sendPage(res, mode, site, {
                    title: "docs",
                    main: "<article></article>",
                });
                return;
            }
            notFound(res, path);
            return;
        }

        const linkedFigure = path.startsWith("/_files/file/")
            ? [...site.ctx.figures.values()].find(
                  (fig) => fig.file === path.slice("/_files/file/".length),
              )
            : undefined;
        if (mode === "preview" && linkedFigure) {
            sendPage(res, mode, site, figurePage(site, linkedFigure));
            return;
        }
        if (
            (mode === "edit" &&
                (path === "/_extensions" ||
                    path === "/_subformats" ||
                    path === "/_git" ||
                    path === "/_statics" ||
                    path.startsWith("/_statics/") ||
                    path === "/_files" ||
                    path.startsWith("/_files/"))) ||
            path === "/_files/terms"
        ) {
            const rest = path.startsWith("/_statics")
                ? path.slice(1)
                : ["/_git", "/_extensions", "/_subformats"].includes(path)
                  ? path.slice(1)
                  : requestUrl.pathname.slice("/_files".length).replace(/^\/|\/$/g, "");
            const page = resourcesMain(site, rest);
            if (!page) {
                notFound(res, path);
                return;
            }
            const editor =
                mode === "edit"
                    ? (site.entries.find(
                          (entry) =>
                              !entry.subformat &&
                              entry.id === requestUrl.searchParams.get("editor"),
                      ) ?? site.entries.find((entry) => !entry.subformat))
                    : undefined;
            if (editor) {
                const { aside, boot } = editorAside(editor, site);
                sendPage(res, mode, site, {
                    title: page.title,
                    main: entryMain(site, editor),
                    currentId: editor.id,
                    currentRes: rest,
                    aside,
                    boot: {
                        ...boot,
                        resource: {
                            path,
                            title: pageTitle(mode, page.title, site.title),
                            html: docLinks(site, page.main),
                            sourceFile: page.sourceFile,
                        },
                    },
                });
                return;
            }
            sendPage(res, mode, site, { ...page, currentRes: rest });
            return;
        }
        const id = resolveDocPath(site.entries, requestUrl.pathname);
        const doc = site.entries.find((e) => e.id === id);
        if (!doc) {
            notFound(res, path);
            return;
        }
        const opts: PageOpts = {
            title: docDisplayName(doc.frontmatter, doc.id),
            main: entryMain(site, doc),
            currentId: doc.id,
        };
        if (mode === "edit" && !doc.subformat) {
            Object.assign(opts, editorAside(doc, site));
        }
        if (mode === "edit" && doc.subformat) {
            const editor = site.entries.find((entry) => !entry.subformat);
            if (editor) {
                const { aside, boot } = editorAside(editor, site);
                Object.assign(opts, {
                    aside,
                    main: entryMain(site, editor),
                    currentRes: path,
                    boot: {
                        ...boot,
                        resource: {
                            path,
                            title: pageTitle(mode, opts.title, site.title),
                            html: entryMain(site, doc),
                        },
                    },
                });
            }
        }
        sendPage(res, mode, site, opts);
    };

    const server = createServer((req, res) => {
        handle(req, res).catch((e: unknown) => {
            if (!res.headersSent) {
                res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
            }
            res.end(`error: ${e instanceof Error ? e.message : e}`);
        });
    });

    // If the port is in use (e.g. a previous instance left running), automatically try +1, up to
    // 10 ports.
    // The URL is printed once, on "listening" (no callbacks left over from failed listens).
    server.once("listening", () => {
        const addr = server.address();
        const p = typeof addr === "object" && addr ? addr.port : port;
        console.log(`dooc ${mode} (${root}): http://localhost:${p}/`);
        for (const plugin of loginPlugins) {
            try {
                console.log(
                    `Log in to ${plugin}: ${handlePlugins.loginLink(plugin, `http://localhost:${p}`)}`,
                );
            } catch (error) {
                console.error(error instanceof Error ? error.message : String(error));
            }
        }
        if (loginPlugins.length)
            console.log(
                "Keep this command running while signing in. Login links expire in 10 minutes.",
            );
    });
    const listen = (p: number, left: number): void => {
        server.once("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE" && left > 0) {
                console.log(`port ${p} in use → trying ${p + 1}`);
                listen(p + 1, left - 1);
                return;
            }
            throw err;
        });
        server.listen(p, "127.0.0.1");
    };
    listen(port, 10);
    return viewer;
};
