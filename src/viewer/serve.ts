import { filesSnapshot, updateFiles, uploadFile } from "../compiler/files.js";
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
import { dirname, join, resolve } from "node:path";
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
import { type Block, type TocEntry, walkBlocks } from "../core/blocks.js";
import { docIdOfFile } from "../core/content-metadata.js";
import type { CompiledDoc, FigureEntry, TermEntry } from "../core/content-types.js";
import { figureFrameHtml, mountFigureFrames } from "../core/figure-frame.js";
import { blocksHtml, docHtml, escapeHtml, type RenderCtx, termsHtml } from "../core/html.js";
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
import { readViewerAsset, prebuilt as usePrebuiltAssets } from "./assets.js";
import { mountBundleNetwork } from "./bundle-network.js";
import { codeFileResponse } from "./code-file.js";
import {
    isLocalToolRequest,
    runCodeTool,
    validateCodeTools,
    validateTextfileCode,
} from "./editor-tools.js";
import { type FilePreviewResults, fileReferences } from "./file-references.js";
import { mountFontPickers } from "./font-picker.js";
import { createFontSettings } from "./font-settings.js";
import { fontCss, readFont } from "./fonts.js";
import { createGitHandler, validateGitOrigin } from "./git.js";
import { gitBaseBody, gitBaseText } from "./git-diff.js";
import { createHmrHub, HMR_PATH, hmrClientScript, watchProject } from "./hmr.js";
import { translate } from "./i18n.js";
import { DEFAULT_SITE_LANGUAGES, loadSiteLanguages } from "./languages.js";
import { focusNavTree } from "./nav-focus.js";
import { loadViewerPlugins, type ViewerRuntime } from "./plugin-config.js";
import { createPluginHandler } from "./plugins.js";
import { mountPanelResize, mountToolsResize } from "./resize.js";
import { resourceIndex, resourceLibraryHtml, resourceTabs } from "./resource-library.js";
import { mountSearch, SEARCH_LABELS, searchIndex, searchSections } from "./search.js";
import { siteIconResponse } from "./site-icon.js";
import { previewTextfiles, textfileResponse } from "./textfile.js";
import { mountThemePickers } from "./theme-picker.js";
import { readWorkspaceSource } from "./workspace.js";

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
}

export interface Site {
    fonts?: readonly ProjectFont[];
    workspace?: WorkspaceSource;
    filePaths?: readonly string[];
    previews?: PreviewSettings;
    title?: string;
    icon?: string;
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
        docs,
        terms,
        figures,
        sources,
        siteErrors,
        defaultLang,
        previews,
        contentLanguages,
        themes,
    }: Compiled,
    languages: readonly LanguageAdapter[] = DEFAULT_SITE_LANGUAGES.languages,
): Site => {
    return {
        previews,
        ...(contentLanguages ? { contentLanguages } : {}),
        ...(themes ? { themes } : {}),
        ...(title === undefined ? {} : { title }),
        ...(icon === undefined ? {} : { icon }),
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
        entries.flatMap((entry) => [
            entry.sourceFile ?? CONTENT_PREFIX + entry.file,
            ...fileReferences(entry.body).map((reference) => reference.file),
        ]),
    );
};
const loadSite = (locale?: string): Site => {
    const previews = applicationPreviews;
    const manifest = readManifest(root);
    const source = contentLanguageCode(manifest.defaultLang ?? DEFAULT_LANG);
    locale ??= source;
    let selected = compiler;
    if (locale !== source) {
        selected = localeCompilers.get(locale) ?? createCompiler(root, { locale, previews });
        localeCompilers.set(locale, selected);
    }
    const site = siteFrom(selected.compile(), siteLanguages.languages);
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
    const siteIconFile = manifest.icon;
    if (siteIconFile) watchTextfiles?.([siteIconFile]);
    return {
        ...site,
        fonts: loadProjectFonts(root),
        workspace: workspaceSource ?? readWorkspaceSource(root),
        filePaths: manifest.errors.length
            ? undefined
            : filesSnapshot(root).files.map((file) => file.path),
        codeLanguages: siteLanguages.codeLanguages,
        codeGrammars: siteLanguages.codeGrammars,
        contentLanguage: locale,
    };
};

const draftContext = (site: Site): DraftContext => ({
    previews: site.previews,
    root,
    docs: site.entries.map((e) => ({
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
        value: { html: string; errors: string[] };
    }
>();

/** Renders only the requested doc, not every doc in site.entries. */
export const renderEntryHtml = (site: Site, entry: Entry): { html: string; errors: string[] } => {
    const sig = renderSignature(site, entry);
    const cached = entryHtmlCache.get(entry.file);
    if (
        cached &&
        cached.blocks === entry.blocks &&
        cached.sig === sig &&
        cached.figures === site.ctx.figures
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
    return id == null
        ? undefined
        : {
              id,
              name: `${id}.md`,
              abs: textfilePath(root, sourceDocFile(id, readManifest(root).files)),
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
  --c-fg:#1a1e23; --c-fg-muted:#5a636c; --c-fg-faint:#7b848e; --fw-body:300;
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
const GIT_ICON = icon(
    '<path d="M5.5 6.5v7M14.5 6.5v1a4 4 0 0 1-4 4h-5"/><circle cx="5.5" cy="4.5" r="2"/><circle cx="5.5" cy="15.5" r="2"/><circle cx="14.5" cy="4.5" r="2"/>',
);
const STORAGE_ICON = icon(
    '<path d="m3 12 2-8h10l2 8"/><rect x="3" y="12" width="14" height="5" rx="1"/><path d="M13 14.5h1"/>',
);
const workspaceName = (site: Site): string =>
    site.workspace?.protocol === "storage" ? workspaceLabel(site.workspace) : "Files";
const workspaceText = (site: Site): string =>
    `<span${site.workspace?.protocol === "storage" ? "" : ' data-i18n="Files"'}>${escapeHtml(workspaceName(site))}</span>`;
const workspaceIcon = (site: Site): string => {
    if (site.workspace?.protocol === "git") return icon('<path d="M2 5h6l2 2h8v10H2Z"/>');
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

const fontButton = (target: "editor" | "viewer"): string => {
    const label = target === "editor" ? "Editor font" : "Viewer font";
    return `<button class="pbtn font-control" type="button" data-font-picker="${target}" aria-haspopup="menu" aria-expanded="false" aria-label="${label}" title="${label}" disabled>${icon('<path d="M2.5 15 7 4l4.5 11M4 11h6M13 10.5c0-2.5 5-2.5 5 0V15M18 12h-2.5c-3.5 0-3.5 4 0 3L18 13.5"/>')}</button>`;
};

const CSS = `
:root { ${DARK_C} ${DOC_FROM_C} --doc-mono: ${MONO_FONT}; --font-sans: ${SANS_FONT}; }
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { ${LIGHT_C} } }
:root[data-theme="light"] { ${LIGHT_C} }
body.edit :is(#sidebar, #panel, .resources-pane), .preview-pane[data-theme], .theme-picker[data-theme] { ${DARK_C} ${DOC_FROM_C} }
@media (prefers-color-scheme: light) {
  :root:not([data-editor-theme="dark"]) body.edit :is(#sidebar, #panel, .resources-pane),
  :is(.preview-pane, .theme-picker)[data-theme="auto"] { ${LIGHT_C} }
}
:root[data-editor-theme="light"] body.edit :is(#sidebar, #panel, .resources-pane),
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
  gap: 2px; height: 36px; padding: 0 24px; border-bottom: 1px solid var(--c-line); background: var(--c-bg0); z-index: 5; }
.page-actions { top: 0; margin: -20px -24px 20px; }
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
  width: min(600px, calc(100vw - 24px)); min-height: 56px; max-height: min(420px, calc(100dvh - 24px)); margin: 0 auto;
  padding: 0 10px 10px; color: var(--c-fg); background: color-mix(in srgb, var(--c-bg1) 82%, transparent);
  border: 1px solid color-mix(in srgb, var(--c-fg-muted) 55%, transparent);
  backdrop-filter: blur(16px); border-radius: 8px; box-shadow: 0 8px 24px #0003; overflow: hidden; }
#doc-search[open] { display: flex; flex-direction: column; }
#doc-search :focus-visible { outline-color: var(--c-fg-muted); }
.search-head { display: flex; flex: none; align-items: center; gap: 10px; padding: 8px;
  color: var(--c-fg-muted); }
.search-head svg { flex: none; }
#doc-search.search-filled .search-head svg { display: none; }
#doc-search-input { width: 100%; min-width: 0; padding: 4px 0; font: inherit; font-size: 15px;
  color: var(--c-fg); background: none; border: 0; outline: none; }
#doc-search-input::-webkit-search-cancel-button { appearance: none; }
.search-status { padding: 8px 16px; color: var(--c-fg-muted); font-size: 12px; }
.search-status:empty { display: none; }
.search-count { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap; }
#doc-search-results { overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
#doc-search-results a { display: flex; flex: none; flex-direction: column; gap: 6px;
  border: 1px solid var(--c-line); border-radius: 5px; color: var(--c-fg); text-decoration: none;
  background: color-mix(in srgb, var(--c-bg0) 50%, transparent); overflow-wrap: anywhere; }
#doc-search-results a:hover, #doc-search-results a[aria-selected="true"] { border-color: var(--c-fg-muted); }
.search-meta { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 5px 10px; border-bottom: 1px solid var(--c-line); color: var(--c-fg-muted); }
.search-path { text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#doc-search-results strong { margin: 2px 10px 0; font-weight: 500; }
#doc-search-results span { margin: 0 10px 10px; color: var(--c-fg-muted); }
.search-grip { position: absolute; top: 8px; bottom: 18px; width: 10px; cursor: grab; touch-action: none; }
.search-grip-left { left: 0; }
.search-grip-right { right: 0; }
.search-grip:active { cursor: grabbing; }
.search-grip::after { content: ""; position: absolute; top: 35%; bottom: 35%; left: 4px;
  width: 2px; border-radius: 2px; background: var(--c-line); }
.search-grip:hover::after, .search-grip:focus-visible::after { background: var(--c-fg-muted); }
.search-resize { position: absolute; bottom: 0; right: 0; width: 18px; height: 18px;
  cursor: nwse-resize; touch-action: none; }
.search-resize::after { content: ""; position: absolute; right: 4px; bottom: 4px; width: 7px; height: 7px;
  border-right: 1px solid var(--c-fg-muted); border-bottom: 1px solid var(--c-fg-muted); }

/* ── sidebar ── */
#sidebar { width: var(--sidebar-width, 260px); height: 100vh; position: sticky; top: 0; flex: none;
  display: flex; flex-direction: column; background: var(--c-bg1);
  border-right: 1px solid var(--c-line); overflow: hidden; }
body.sidebar-closed #sidebar { width: 52px; }
body.sidebar-closed #sidebar-resize { display: none; }
.panel-resize { position: absolute; top: 0; bottom: 0; width: 8px; cursor: col-resize; z-index: 6;
  touch-action: none; transition: background 120ms ease; }
#sidebar-resize { right: 0; }
#resize { left: 0; }
.panel-resize:hover, .panel-resize:focus-visible, .panel-resize.drag {
  background: color-mix(in srgb, var(--c-accent) 60%, transparent); }
body.resizing, body.resizing * { cursor: col-resize !important; user-select: none !important; }
body.sidebar-closed .site-title { display: none; }
#sidebar-head { position: relative; flex: none; display: flex; align-items: center; min-width: 0; min-height: 36px;
  border-bottom: 1px solid var(--c-line); }
#sidebar-toggle { flex: none; display: flex; align-items: center; padding: 8px 16px;
  background: transparent; border: none; color: var(--c-fg-muted); cursor: pointer; }
#sidebar-toggle:hover { color: var(--c-fg); }
#site-icon-slot { position: relative; flex: none; width: 24px; height: 24px; margin: 0 8px 0 16px; color: var(--c-fg-muted); }
#site-icon, #site-icon-slot > .nav-icon { display: block; width: 100%; height: 100%; object-fit: contain; }
#site-icon[hidden], #site-icon-slot:has(#site-icon:not([hidden])) > .nav-icon { display: none; }
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
.nav-count { margin-left: auto; padding-left: 8px; color: var(--c-fg-faint); font-size: 11px; }
body.sidebar-closed #sidebar-content { display: block; overflow-y: auto; scrollbar-width: none; padding: 6px 0; }
body.sidebar-closed #nav-groups { display: block; }
body.sidebar-closed #nav-docs { scrollbar-width: none; }
body.sidebar-closed #nav-groups :is(.nav-label, .nav-count, .nav-toc, .nav-tree-toggle, .nav-tree-spacer, .nav-placeholder, .new, .nav-delete, .files-upload, .files-drop-hint, input, .nav-icon-clear),
body.sidebar-closed #nav-status { display: none; }
body.sidebar-closed #nav-groups .nav-tree { display: block; padding: 0; margin: 0; }
body.sidebar-closed #nav-groups .nav-row { position: relative; padding: 0; gap: 0; min-height: 36px; }
body.sidebar-closed #nav-groups .nav-row > a { width: 100%; height: 36px; padding: 0; justify-content: center; }
body.sidebar-closed #nav-groups .nav-doc-icon { position: absolute; left: 16px; z-index: 1; pointer-events: none; }
body.sidebar-closed #nav-groups .nav-row > a .nav-icon, body.sidebar-closed #nav-groups .nav-row > a .doc-icon-frame { margin: 0; width: 18px; height: 18px; }
body.sidebar-closed #nav-groups :is(.nav-item, .nav-tree, .nav-row, a)::before,
body.sidebar-closed #nav-groups :is(.nav-item, .nav-tree, .nav-row, a)::after { display: none; }
body.sidebar-closed :is(#nav-files, #nav-git) { border: 0; border-top: 1px solid var(--c-line); border-radius: 0; margin: 6px 0 0; padding: 6px 0 0; overflow: visible; }
body.edit #sidebar-content { display: flex; flex-direction: column; overflow: hidden; scrollbar-gutter: auto; }
body.edit #nav-groups { flex: 1; min-height: 0; display: flex; flex-direction: column; }
#nav-docs { flex: 1; min-height: 0; overflow: auto; scrollbar-gutter: stable; }
#nav-tools { position: relative; flex: none; display: flex; flex-direction: column; min-height: 0; height: var(--tools-height, 220px); margin: 10px 8px 4px; padding: 12px 4px 4px; border: 1px solid var(--c-line); border-radius: 8px; background: var(--c-bg1); }
#tools-resize { position: absolute; top: -4px; left: 0; right: 0; height: 8px; z-index: 2; cursor: row-resize; touch-action: none; border-radius: 6px; }
#tools-resize:hover, #tools-resize:focus-visible, body.resizing-tools #tools-resize { background: color-mix(in srgb, var(--c-fg-muted) 20%, transparent); }
body.resizing-tools, body.resizing-tools * { cursor: row-resize !important; user-select: none !important; }
.nav-tool-cards { flex: 1; min-height: 0; overflow: auto; }
#nav-tools .nav-resources { height: 36px; margin: 0; border: 0; border-radius: 4px; }
.workspace-location { position: absolute; top: -1px; left: 10px; z-index: 3; transform: translateY(-50%); display: flex; align-items: center; gap: 4px; max-width: calc(100% - 32px); color: var(--c-fg-muted); font: 400 10px/16px var(--font-sans); cursor: default; }
.workspace-location > .nav-icon { flex: none; width: 14px; height: 14px; padding: 1px; background: var(--c-bg1); }
.workspace-address { min-width: 0; padding: 0 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: var(--c-bg1); }
body.sidebar-closed #nav-tools { height: auto; margin: 4px 0; padding: 0; border: 0; }
body.sidebar-closed :is(#tools-resize, .workspace-location) { display: none; }
.nav-resources { position: relative; container-type: size; flex: none; height: 42px; margin: 8px 8px 4px;
  border: 1px solid var(--c-line); border-radius: 8px; overflow: hidden;
  background: var(--c-bg1); font-family: var(--font-sans); }
.nav-resources > .nav-item, .nav-resources .nav-row { height: 100%; }
.nav-resources .nav-row > .nav-link { height: 100%; padding: 8px 10px; gap: 8px; }
.nav-resources .nav-row { cursor: default; }
.nav-resources .nav-link::before { display: none; }
.nav-resources .files-upload { margin-right: 6px; }
.files-upload { flex: none; display: grid; place-items: center; width: 28px; height: 28px; padding: 0;
  border: 0; border-radius: 4px; background: transparent; color: var(--c-fg-muted); cursor: pointer; }
.files-upload:hover, .files-upload:focus-visible { color: var(--c-fg); background: var(--c-raised); }
.files-upload svg { display: block; width: 16px; height: 16px; }
.files-upload > span { display: none; font: 10px var(--doc-mono); }
.files-upload[data-state] > svg { display: none; }
.files-upload[data-state] > span { display: block; }
.files-upload[data-state="error"] { color: var(--c-danger); }
.files-upload[data-state="done"] { color: var(--doc-ok); }
.files-drop-hint { position: absolute; inset: 0; display: none; align-items: center;
  justify-content: center; gap: 6px; padding: 6px; pointer-events: none; text-align: center; }
.files-drop-hint > svg { width: 28px; height: 28px; }
.files-drop-hint ul { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px 8px;
  margin: 0; padding: 0; list-style: none; font: 11px var(--doc-mono); color: var(--c-fg-muted); }
@container (max-height: 140px) { .files-drop-hint ul { display: none; } }
body.files-dragging #nav-files { border-color: var(--c-accent); }
body.files-dragging #nav-files > .nav-item { opacity: .15; }
body.files-dragging .files-drop-hint { display: flex; }
body.files-over #nav-files { background: color-mix(in srgb, var(--c-accent) 10%, var(--c-bg1)); }
#nav-status { min-height: 16px; margin: 6px 16px 0; color: var(--c-fg-faint); font-size: 11px;
  line-height: 1.35; }
#nav-status.err { color: var(--c-danger); }

/* ── main (document body) ── */
main { flex: 1; min-width: 0; padding: 20px 24px 50vh; }
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
.plugin-content:has(> iframe) { padding: 0; }
.plugin-content:empty { display: none; }
.plugin .plugin-card { margin: 0; max-width: none; }
.plugin-card strong { font-size: 14px; font-weight: 600; }
.plugin-card p { margin: 6px 0 0; font-size: 13px; white-space: pre-wrap; line-height: 1.5; overflow-wrap: anywhere; }
.plugin-content > ul { display: grid; gap: 4px; padding-left: 20px; margin: 0; line-height: 1.5; }
.plugin-content > ul li::marker { color: var(--doc-accent); }
.plugin-content > table { width: 100%; border-collapse: collapse; font-size: 13px; line-height: 1.6; }
.plugin-content :is(th, td) { padding: 6px 8px; text-align: start; border-bottom: 1px solid var(--doc-border); }
.plugin-content th { background: var(--doc-bg-2); color: var(--doc-fg-2); font-size: 12px; font-weight: 600; }
.plugin-content tr:last-child td { border-bottom: 0; }
.plugin-content > pre { margin: 0; max-height: 320px; padding: 10px; }
.plugin-content > iframe { display: block; color-scheme: inherit; }
[data-plugin-result][data-resized] > iframe { height: 100% !important; }
[data-plugin-result][data-resized] > pre { max-height: none; }
.plugin-resize { display: none; height: 12px; align-items: center; justify-content: center;
  cursor: row-resize; touch-action: none; user-select: none; }
.plugin[data-ready="true"]:not(.collapsed) > .plugin-resize { display: flex; }
.plugin-resize::before { content: ""; width: 32px; height: 3px; border-radius: 2px; background: var(--doc-border); }
.plugin-resize:hover::before, .plugin-resize:focus-visible::before, .plugin-resize.drag::before { background: var(--doc-accent); }
.plugin-resize:focus-visible { outline: 2px solid var(--doc-accent); outline-offset: -2px; }
body:has(.plugin-resize.drag), body:has(.plugin-resize.drag) * { cursor: row-resize !important; user-select: none !important; }
body:has(.plugin-resize.drag) iframe { pointer-events: none; }

.plugin[data-blocks="true"] { container-type: inline-size; background: var(--doc-bg); color: var(--doc-fg); }
.plugin[data-blocks="true"] .plugin-content { padding: 20px; }
.plugin[data-blocks="true"] .plugin-header { padding: 0 16px; }
.plugin[data-blocks="true"][data-ready="true"] .plugin-info { display: block; flex-basis: auto; }
.plugin[data-blocks="true"][data-ready="true"] .plugin-info h2 { display: none; }
.plugin[data-blocks="true"][data-ready="true"] .plugin-header:has([data-plugin-status]:not(:empty)) { display: flex; padding-top: 12px; }
.plugin[data-blocks="true"] [data-plugin-status] { margin: 0; }
.plugin[data-operation-error="true"] [data-plugin-status] { color: var(--doc-danger); }
.plugin-heading { order: -1; display: flex; align-items: center; gap: 8px; min-width: 0; max-width: calc(100% - 156px); font: 11px/20px var(--doc-mono); }
.plugin-heading::before { content: ""; border-top: 2px solid var(--doc-border); width: 8px; flex: none; }
.plugin-heading a { display: flex; align-items: center; gap: 6px; color: var(--doc-fg-2); text-decoration: none; flex: none; }
.plugin-heading img { display: block; width: 16px; height: 16px; }
.plugin-heading-context { color: var(--doc-fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.plugin-heading button { font: inherit; color: var(--doc-fg-2); background: transparent; border: 0; padding: 0; cursor: pointer; white-space: nowrap; }
.plugin-action-menu { position: relative; margin: 0; }
.plugin-action-menu > summary { list-style: none; font-size: 20px; line-height: 16px; }
.plugin-action-menu > summary::-webkit-details-marker { display: none; }
.plugin-action-menu > div { position: absolute; z-index: 20; right: 0; top: 26px; width: min(340px, calc(100vw - 64px)); max-height: 65vh; overflow: auto; padding: 8px; background: var(--doc-bg); color: var(--doc-fg); border: 1px solid var(--doc-border-2); border-radius: 8px; box-shadow: 0 8px 24px var(--c-shadow); }
.plugin-action-menu > div > div > button { width: 100%; text-align: start; margin-bottom: 3px; }
.plugin-blocks { font: 13px/1.65 var(--doc-mono); overflow-wrap: anywhere; }
.plugin-blocks > :first-child, .plugin-block-columns > div > :first-child { margin-top: 0; }
.plugin-blocks .plugin-block-heading { margin: 0 0 16px; padding: 0; border: 0; font: 600 20px/1.45 var(--doc-mono); color: var(--doc-fg); }
.plugin-block-text { margin: 12px 0; white-space: pre-wrap; }
.plugin-block-text:has(p, pre, ul, ol) { white-space: normal; }
.plugin-blocks p { margin: 6px 0; white-space: pre-wrap; }
.plugin-blocks strong { font-weight: 600; }
.plugin-blocks a { color: var(--doc-accent); text-underline-offset: 3px; }
.plugin-blocks code { font-family: var(--doc-mono); }
.plugin-block-context { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; margin: 10px 0; color: var(--doc-fg-3); font-size: 11px; }
.plugin-block-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px 20px; margin: 14px 0; }
.plugin-block-fields > div { min-width: 0; }
.plugin-block-fields dt { color: var(--doc-fg-3); font-size: 11px; margin-bottom: 3px; }
.plugin-block-fields dd { margin: 0; min-height: 26px; font-size: 12px; }
.plugin-block-columns { display: grid; grid-template-columns: minmax(0, 1fr) 200px; gap: 24px; }
.plugin-block-columns > div, .plugin-block-columns aside { min-width: 0; }
.plugin-block-columns aside { border-left: 1px solid var(--doc-border); padding-left: 18px; }
.plugin-block-columns aside .plugin-block-fields { grid-template-columns: 1fr; margin-top: 0; }
.plugin-block-section { border-top: 1px solid var(--doc-border); padding-top: 10px; margin: 18px 0 0; min-width: 0; }
.plugin-block-section > summary { cursor: pointer; font-size: 12px; font-weight: 600; color: var(--doc-fg-2); padding: 4px 0; }
.plugin-block-note { color: var(--doc-warn); font-size: 11px; border-left: 2px solid currentColor; padding-left: 10px; }
.plugin-block-table { overflow: auto; width: 100%; margin: 8px 0; }
.plugin-block-table table { width: 100%; border-collapse: collapse; font-size: 12px; }
.plugin-block-table :is(th, td) { padding: 8px 10px; min-width: 90px; max-width: 320px; vertical-align: top; }
.plugin-blocks .plugin-block-code { font: 12px/1.65 var(--doc-mono); padding: 12px; margin: 10px 0; border: 1px solid var(--doc-border); border-radius: 6px; max-height: 400px; overflow: auto; white-space: pre-wrap; }
.plugin-block-diff code > span { display: inline-block; min-width: 100%; }
.plugin-block-diff [data-tone="success"] { color: var(--doc-ok); background: color-mix(in srgb, var(--doc-ok) 8%, transparent); }
.plugin-block-diff [data-tone="danger"] { color: var(--doc-danger); background: color-mix(in srgb, var(--doc-danger) 8%, transparent); }
.plugin-block-message { padding: 12px 0; border-bottom: 1px solid var(--doc-border); }
.plugin-block-message:last-child { border-bottom: 0; }
.plugin-message-byline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.plugin-message-byline > span:not(.plugin-avatar, .plugin-message-actions) { color: var(--doc-fg-3); font-size: 10px; }
.plugin-avatar { display: grid; place-items: center; width: 28px; height: 28px; flex: none; border-radius: 7px; color: var(--doc-accent); background: color-mix(in srgb, var(--doc-accent) 12%, var(--doc-bg)); font-size: 10px; }
.plugin-task { display: flex; align-items: baseline; gap: 8px; list-style: none; }
.plugin-message-actions svg { display: block; width: 14px; height: 14px; }
.plugin-message-actions .plugin-block-button { padding: 4px; border: 0; color: var(--doc-fg-3); }
.plugin-message-actions { margin-left: auto; display: flex; gap: 4px; }
.plugin-message-body, .plugin-reactions { margin: 6px 0 0 36px; }
.plugin-reactions { display: flex; flex-wrap: wrap; gap: 5px; font-size: 11px; }
.plugin-reactions button { font: inherit; padding: 2px 8px; border: 1px solid var(--doc-border); border-radius: 12px; background: transparent; color: var(--doc-fg-2); cursor: pointer; }
.plugin-reactions [aria-pressed="true"] { border-color: var(--doc-accent); color: var(--doc-accent); background: color-mix(in srgb, var(--doc-accent) 8%, transparent); }
.plugin-badge { display: inline-flex; padding: 1px 7px; border-radius: 5px; font-size: 11px; color: var(--doc-fg-2); background: var(--doc-bg-2); }
.plugin-badge[data-tone="accent"] { color: var(--doc-accent); background: color-mix(in srgb, var(--doc-accent) 10%, var(--doc-bg)); }
.plugin-badge[data-tone="success"] { color: var(--doc-ok); background: color-mix(in srgb, var(--doc-ok) 10%, var(--doc-bg)); }
.plugin-badge[data-tone="warning"] { color: var(--doc-warn); background: color-mix(in srgb, var(--doc-warn) 10%, var(--doc-bg)); }
.plugin-badge[data-tone="danger"] { color: var(--doc-danger); background: color-mix(in srgb, var(--doc-danger) 10%, var(--doc-bg)); }
.plugin-copy-value { display: inline-flex; align-items: center; gap: 3px; max-width: 100%; }
.plugin-copy { width: 22px; height: 22px; padding: 3px; border: 0; background: transparent; color: var(--doc-fg-3); cursor: pointer; flex: none; }
.plugin-copy svg { width: 14px; height: 14px; }
.plugin-block-progress { display: flex; align-items: center; gap: 10px; font-size: 11px; color: var(--doc-fg-3); margin: 12px 0; }
.plugin-block-progress progress { flex: 1; width: 0; height: 6px; accent-color: var(--doc-accent); }
.plugin-block-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
.plugin-block-actions:has([data-block-composer]) { display: block; }
.plugin-block-button { font: inherit; font-size: 12px; padding: 5px 10px; border: 1px solid var(--doc-border); border-radius: 5px; color: var(--doc-fg); background: transparent; cursor: pointer; }
.plugin-block-button:hover, .plugin-edit-display:hover { background: var(--doc-bg-2); }
.plugin-block-button:disabled { opacity: .5; cursor: wait; }
.plugin-danger { color: var(--doc-danger); }
.plugin-edit-display { border-radius: 4px; cursor: text; min-height: 24px; }
.plugin-edit-display:focus-visible, .plugin :is(button, summary, input, select, textarea):focus-visible, .plugin-block-table:focus-visible { outline: 2px solid var(--doc-accent); outline-offset: 2px; }
.plugin-editor { display: grid; gap: 10px; margin: 8px 0; padding: 10px; border: 1px solid var(--doc-border); border-radius: 6px; font: 12px/1.6 var(--doc-mono); color: var(--doc-fg); background: var(--doc-bg); min-width: 0; }
.plugin-editor label { display: grid; gap: 5px; color: var(--doc-fg-2); }
.plugin-editor :is(input, textarea, select) { box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%; padding: 7px 8px; border: 1px solid var(--doc-border-2); border-radius: 4px; color: var(--doc-fg); background: var(--doc-bg); font: inherit; }
.plugin-editor textarea { resize: vertical; min-height: 96px; max-height: 60vh; }
.plugin-editor-controls { display: flex; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
.plugin-editor .plugin-submit { background: var(--doc-accent); color: var(--doc-accent-fg); border-color: transparent; }
.plugin-editor-notice { color: var(--doc-danger); font-size: 11px; }
.plugin-editor-notice:empty { display: none; }
.plugin [hidden] { display: none !important; }
@container (max-width: 600px) {
  .plugin-block-columns { grid-template-columns: minmax(0, 1fr); gap: 14px; }
  .plugin-block-columns aside { border-left: 0; border-top: 1px solid var(--doc-border); padding: 14px 0 0; }
  .plugin-block-columns aside .plugin-block-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .plugin-heading-context { display: none; }
  .plugin-blocks .plugin-block-heading { font-size: 18px; }
  .plugin-message-body, .plugin-reactions { margin-left: 0; }
}

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
ul, ol { margin: 4px 0; line-height: 1.3; }
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
table { border-collapse: collapse; font-size: 14px; }
th, td { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); padding: 4px 10px; }
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
.in-toc { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; margin: 0 10px 0 0; }
.toc-current { position: relative; flex: none; width: 120px; min-width: 0; max-width: calc(100% - 36px); padding: 4px 20px 4px 4px;
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
.toc-seek { flex: 1; appearance: none; width: 0; min-width: 24px; height: 24px; margin: 0; padding: 0; background: transparent; cursor: ew-resize; }
.toc-seek::-webkit-slider-runnable-track { height: 2px; background: linear-gradient(to right, var(--doc-accent) var(--toc-progress, 0%), var(--doc-border) var(--toc-progress, 0%)); }
.toc-seek::-moz-range-track { height: 2px; background: linear-gradient(to right, var(--doc-accent) var(--toc-progress, 0%), var(--doc-border) var(--toc-progress, 0%)); }
.toc-seek::-webkit-slider-thumb { appearance: none; width: 8px; height: 8px; margin-top: -3px; border: 0; border-radius: 50%; background: var(--doc-accent); }
.toc-seek::-moz-range-thumb { width: 8px; height: 8px; border: 0; border-radius: 50%; background: var(--doc-accent); }
.toc-seek:disabled { opacity: .35; cursor: default; }
html:has(.page-actions .toc-seek), .preview-pane:has(> .pane-actions .toc-seek) { scrollbar-width: none; }
html:has(.page-actions .toc-seek)::-webkit-scrollbar,
.preview-pane:has(> .pane-actions .toc-seek)::-webkit-scrollbar { display: none; }
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
.resource-toolbar { display: flex; align-items: center; gap: 10px; height: 30px; padding: 0 6px;
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
.resource-item .term-definition { margin: 0; white-space: pre-wrap; font-size: 13px; }
.resource-description { color: var(--doc-fg-3); white-space: pre-wrap; font-size: 12px; margin: 6px 0 0; }
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
body.git-diff-hidden .cm-lineNumbers :is(.cm-git-added, .cm-git-modified, .cm-git-deleted-start, .cm-git-deleted-end) { box-shadow: none; }
body.git-diff-hidden .cm-line:is(.cm-git-added, .cm-git-modified, .cm-git-deleted-start, .cm-git-deleted-end) { background-color: transparent; }
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
#gear:hover #gearmenu, #gear:focus-within #gearmenu, #gear.open #gearmenu { display: flex; }
#gearmenu label { display: flex; gap: 10px; align-items: center; cursor: pointer;
  padding: 7px 10px; border-radius: 4px; }
#gearmenu label:hover { background: var(--c-raised); }
#gearmenu input { accent-color: var(--c-accent); margin: 0; }

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
.pane-actions { top: -20px; margin: -20px -24px 20px; }
#preview-panes { display: flex; flex: 1; min-height: 0; }
#preview-panes[hidden] { display: none; }
.preview-pane.resources-pane { min-height: 0; padding-bottom: 24px; }
.preview-pane.resources-pane:has(.resource-library) { padding-top: 0; }
.resources-pane .resource-tabs { margin-inline: -24px; padding: 0 12px; }
.preview-pane { flex: 1; min-width: 0; overflow: auto; padding: 20px 24px 50vh; border-top: 2px solid transparent; }
#preview-panes.split .preview-pane { padding: 16px; }
#preview-panes.split .pane-actions { top: -16px; margin: -16px -16px 16px; padding-inline: 10px; }
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
#language-setting { flex: none; display: flex; align-items: center; gap: 12px; padding: 8px 14px; border-bottom: 1px solid var(--c-line); }
#language-setting .language-select { width: 160px; }
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
.files-table [data-drop=before] {box-shadow:inset 0 2px var(--c-accent);}.files-table [data-drop=after] {box-shadow:inset 0 -2px var(--c-accent);}.files-table [data-drop=into] {outline:2px solid var(--c-accent);outline-offset:-2px;}
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
.res-section h2 { font-size: 15px; border: 0; margin: 28px 0 10px; }
.res-section h2 a { color: inherit; text-decoration: none; }
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
.res-thumb .res-frame { width: 100%; height: 100%; border: 0; pointer-events: none; background: #fff; }
.res-meta { display: flex; flex-direction: column; gap: 1px; padding: 7px 10px; border-top: 1px solid var(--c-line); }
.res-name { font-family: var(--doc-mono); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.res-preview { display: flex; align-items: center; justify-content: center; min-height: 160px; padding: 16px;
  border: 1px solid var(--c-line); border-radius: 6px; background: var(--c-bg0); }
.res-preview .res-img { max-width: 100%; max-height: 480px; }
.res-preview.square .res-img { width: 160px; height: 160px; outline: 1px dashed var(--c-line); }
.res-preview .res-frame { width: 100%; height: 420px; border: 0; background: #fff; }
.res-markdown { width: 100%; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.res-thumb .res-markdown { max-height: 100%; overflow: hidden; font-size: 11px; }
.res-preview .res-markdown { max-height: 480px; overflow: auto; }
.res-empty { color: var(--c-fg-faint); }
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
.nav-add-hover { visibility: hidden; }
#sidebar:hover .nav-add-hover, #sidebar:focus-within .nav-add-hover { visibility: visible; }
#sidebar .nav-list:has(> .nav-new-item) > .nav-placeholder { display: none; }
/* Keep the title and filename together in a compact create form. */
.nav-row > .nav-new { position: relative; display: flex; flex: 1; min-width: 0;
  flex-direction: column; justify-content: center; align-items: stretch; cursor: auto;
  margin: 4px 0; height: 42px; padding: 5px 38px 5px 36px;
  border: 1px dashed var(--c-line); border-radius: 6px; background: var(--c-raised); }
.nav-tree .nav-new { margin-left: calc(var(--nav-pad) - 12px); }
.nav-new > .nav-icon { position: absolute; left: 12px; top: 10px; color: var(--c-fg-faint); }
.nav-new input { font: inherit; color: var(--c-fg); background: transparent; border: none;
  padding: 0; min-width: 0; outline: none; }
.nav-new input::placeholder { color: var(--c-fg-faint); }
.nav-new input[name="title"] { font-size: 13px; line-height: 17px; }
.nav-new-file { display: flex; align-items: center; color: var(--c-fg-faint);
  font: 10px/12px var(--doc-mono); }
.nav-new-file input { flex: 1; font-family: inherit; font-size: inherit; color: var(--c-fg-muted); }
.nav-new-go { position: absolute; right: 7px; top: 50%; transform: translateY(-50%);
  display: flex; align-items: center; justify-content: center; width: 24px;
  height: 24px; padding: 0; font-size: 11px; color: var(--c-fg-faint); background: none;
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
    publish?: { graphJs: string; codeJs: string; pages: string; first: string; network: boolean };
}

// Contents of #nav-groups (the doc tree). Used by both page()'s initial render and
// `GET /api/nav` (edit mode; the client replaces just the innerHTML after an md change)
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
                        ? `<a class="nav-link${cur}" href="/${e.id}" title="${label}">${e.icon ? svgImg(e.icon, "nav-icon doc-icon") : DOCS_ICON}<span class="nav-label">${label}</span></a>`
                        : `<a class="nav-tree-link${cur}" href="/${e.id}" title="${label}">${e.icon ? svgImg(e.icon, "doc-icon") : DOCS_ICON}<span class="nav-label">${label}</span></a>`;
                let actions = "";
                let editableIcon = "";
                if (mode === "edit") {
                    link = `<a class="${depth === 0 ? "nav-link" : "nav-tree-link"}${cur}" href="/${e.id}" title="${label}" aria-keyshortcuts="F2"><span class="nav-doc-name"><span class="nav-label">${label}</span></span></a>`;
                    editableIcon = `<span class="nav-doc-icon" title="icon" data-i18n-title="icon">${e.icon ? svgImg(e.icon, "doc-icon") : DOCS_ICON}<input type="file" accept=".svg,image/svg+xml" aria-label="icon" data-i18n-aria-label="icon">${e.icon ? '<button class="nav-icon-clear" type="button" title="Remove icon" data-i18n-title="Remove icon" aria-label="Remove icon" data-i18n-aria-label="Remove icon">×</button>' : ""}</span>`;
                    actions = `<button class="new" type="button" data-parent="${escapeHtml(e.id)}" title="Add doc" data-i18n-title="Add doc" aria-label="Add doc" data-i18n-aria-label="Add doc">${PLUS_ICON}</button><button class="nav-delete" type="button" data-doc-action="delete" title="Delete doc" data-i18n-title="Delete doc" aria-label="Delete doc" data-i18n-aria-label="Delete doc">${DELETE_ICON}</button>`;
                }
                const branch = childrenOf(site.entries, e.id).length > 0;
                const toggle = branch
                    ? `<button class="nav-tree-toggle" type="button" aria-label="Toggle ${label}">${CHEVRON_ICON}</button>`
                    : mode === "edit"
                      ? '<span class="nav-tree-spacer" aria-hidden="true"></span>'
                      : "";
                return `<div class="nav-item${open.has(e.id) ? " open" : ""}" data-doc-id="${escapeHtml(e.id)}"><div class="nav-row${mode === "edit" ? " nav-doc-row" : ""}"${mode === "edit" ? ' draggable="true"' : ""}>${editableIcon}${link}${actions}${toggle}</div>${list(e.id, depth + 1)}</div>`;
            })
            .join("");
        const placeholder =
            mode === "edit" && depth === 0
                ? `<div class="nav-item nav-placeholder${items ? " nav-add-hover" : ""}"><div class="nav-row"><button class="nav-create" type="button" data-parent="" title="Add doc" data-i18n-title="Add doc" aria-label="Add doc" data-i18n-aria-label="Add doc">${PLUS_ICON}</button></div></div>`
                : "";
        return depth === 0
            ? `<div class="nav-list nav-root" data-parent=""${mode === "edit" ? ' id="nav-docs"' : ""}>${items}${placeholder}</div>`
            : `<div class="nav-list nav-tree" data-parent="${escapeHtml(parent ?? "")}" style="--nav-depth:${depth + 1}">${items}${placeholder}</div>`;
    };
    const html = list(undefined, 0) + (mode === "edit" ? navFilesHtml(site, currentRes) : "");
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
    ...site.entries.map((entry) => ({
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
        ["dictionary", "code", "urls"].includes(currentRes ?? "");
    const folderIcon = icon('<path d="M2 5h6l2 2h8v10H2Z"/>');
    const upload = `<button class="files-upload" type="button" title="Upload files" data-i18n-title="Upload files" aria-label="Upload files" data-i18n-aria-label="Upload files">${UPLOAD_ICON}<span></span></button><input id="files-upload-input" type="file" multiple hidden>`;
    const hint = `<div class="files-drop-hint" aria-hidden="true">${UPLOAD_ICON}<span data-i18n="Upload files">Upload files</span></div>`;
    const location =
        source?.protocol === "git"
            ? `<div class="workspace-location" data-workspace-protocol="git" title="${escapeHtml(`${source.repo ?? "repo"}[${source.branch}]`)}">${GIT_ICON}<span class="workspace-address"><span class="git-repo-name">${escapeHtml(source.repo ?? "repo")}</span><span class="git-branch-caption">[${escapeHtml(source.branch)}]</span></span></div>`
            : `<div class="workspace-location" id="nav-storage" data-workspace-protocol="storage" title="${escapeHtml(workspaceName(site))}">${workspaceIcon(site)}<span class="workspace-address">${escapeHtml(source?.folder ?? "Files")} / ${escapeHtml(source?.service ?? "Local")}</span></div>`;
    const git =
        source?.protocol === "git"
            ? `<div class="nav-resources" id="nav-git"><div class="nav-item" data-node-id="_git"><div class="nav-row"><a class="nav-link${currentRes === "_git" ? " cur" : ""}" href="/_git" title="Git controls" data-i18n-title="Git controls">${GIT_ICON}<span class="nav-label">Git</span></a></div></div></div>`
            : "";
    return `<section id="nav-tools" aria-label="Workspace tools" data-i18n-aria-label="Workspace tools"><div id="tools-resize" role="separator" tabindex="0" aria-orientation="horizontal" aria-controls="nav-tools" aria-label="Resize workspace tools" data-i18n-aria-label="Resize workspace tools"></div>${location}<div class="nav-tool-cards"><div class="nav-resources" id="nav-files"><div class="nav-item" data-node-id="_files"><div class="nav-row"><a class="nav-link${currentRes !== undefined && currentRes !== "_git" && !statics ? " cur" : ""}" href="/_files" title="Files" data-i18n-title="Files">${folderIcon}<span class="nav-label" data-i18n="Files">Files</span></a>${upload}</div></div>${hint}</div><div class="nav-resources" id="nav-statics"><div class="nav-item" data-node-id="_statics"><div class="nav-row"><a class="nav-link${statics ? " cur" : ""}" href="/_statics" title="Statics" data-i18n-title="Statics">${BOX_ICON}<span class="nav-label" data-i18n="Statics">Statics</span></a></div></div></div>${git}</div></section>`;
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
            : figureFrameHtml(f, `fig-frame res-${f.kind}`);
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
    if (rest === "_git")
        return site.workspace?.protocol === "git"
            ? {
                  title: `${site.workspace.repo ?? "repo"} [${site.workspace.branch}]`,
                  main: '<article class="res-page resource-library git-page"><div id="git-manager"></div></article>',
              }
            : undefined;
    if (rest === "_statics" || rest.startsWith("_statics/")) {
        const view = rest.slice("_statics".length).replace(/^\//, "") || "dictionary";
        return ["dictionary", "code", "urls"].includes(view)
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
    if (!file && (kind === "dictionary" || kind === "code" || kind === "urls")) {
        const index = resourceIndex(
            root,
            site.filePaths ?? filesSnapshot(root).files.map((item) => item.path),
        );
        return {
            title: "Statics",
            main: `<article class="res-page files-page resource-library">${resourceTabs(kind)}${resourceLibraryHtml(index, kind)}</article>`,
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
    const siteIcon = `<span id="site-icon-slot"${mode === "edit" ? ' title="Change site icon" data-i18n-title="Change site icon"' : ""}><img id="site-icon" alt=""${site.icon ? ` src="${svgDataUri(site.icon)}"` : " hidden"}>${DOCS_ICON}${mode === "edit" ? '<input type="file" accept=".svg,image/svg+xml" aria-label="Change site icon" data-i18n-aria-label="Change site icon">' : ""}</span>`;
    const bootScripts =
        opts.boot != null
            ? `<script id="boot" type="application/json">${JSON.stringify(opts.boot).replace(/</g, "\\u003c")}</script>
<script src="/assets/edit.js"></script>`
            : !opts.publish
              ? '<script src="/assets/ui.js"></script>'
              : "";
    // Interaction layer of the schema graph (zoom / pan / box drag / enlarged view). Shared by
    // preview / edit. Figures are readable without JS, so defer is enough (= progressive
    // enhancement).
    const main =
        opts.boot != null
            ? `<main class="editor-workspace">


<div id="preview-language-menu" role="menu" aria-label="Change language" data-i18n-aria-label="Change language" hidden></div>
<div id="preview-panes"><section class="preview-pane active" tabindex="0" aria-label="Active pane" data-i18n-aria-label="Active pane"><div class="pane-actions"><button class="pbtn" type="button" data-theme-picker="document" aria-label="Preview theme"></button>${fontButton("viewer")}<button class="pbtn pane-language" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="preview-language-menu" aria-label="Change language" data-i18n-aria-label="Change language" title="Change language" data-i18n-title="Change language">${GLOBE_ICON}</button></div><div class="preview-content">${opts.main}</div></section></div></main>`
            : mode === "edit" && opts.currentRes !== undefined
              ? `<main class="resources-pane">${opts.main}</main>`
              : `<main><div class="page-actions"><button class="pbtn" type="button" data-theme-picker="document" aria-label="Preview theme"></button>${fontButton("viewer")}</div>${opts.main}</main>`;
    const graphScript = opts.publish
        ? `<script>${inlineScript(opts.publish.graphJs)}</script>`
        : '<script src="/assets/graph.js" defer></script>';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
${opts.publish ? `<meta name="referrer" content="no-referrer"><meta http-equiv="x-dns-prefetch-control" content="off">${opts.publish.network ? "" : `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' data:; img-src data: blob:; media-src data: blob:; font-src data: blob:; frame-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'">`}` : ""}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(pageTitle(mode, opts.title, site.title))}</title>
<script>try{const t=localStorage.getItem("docs-preview:theme");if(t)document.documentElement.dataset.theme=t;const e=localStorage.getItem("docs-editor:theme");if(e)document.documentElement.dataset.editorTheme=e}catch{}</script>
<style>${fontCss(Boolean(opts.publish))}${CSS}${mode === "edit" ? EDIT_CSS : ""}</style></head>
<body${mode === "edit" ? ' class="edit"' : ""}><nav id="sidebar"><div id="sidebar-resize" class="panel-resize" role="separator" tabindex="0" aria-orientation="vertical" aria-controls="sidebar" aria-label="Resize sidebar" data-i18n-aria-label="Resize sidebar" title="Resize sidebar" data-i18n-title="Resize sidebar"></div><div id="sidebar-head">${siteIcon}<div id="site-title" class="site-title" title="${siteTitle}">${siteTitle}</div><button id="sidebar-toggle" type="button" aria-controls="sidebar-content" aria-expanded="true" title="Close sidebar" data-i18n-title="Close sidebar">${SIDEBAR_ICON}</button></div><div id="sidebar-content"><div id="nav-groups">${nav}</div><div id="nav-status" role="status" aria-live="polite"></div></div></nav>${main}${opts.aside ?? ""}
${bootScripts}${graphScript}
<script id="code-grammars" type="application/json">${JSON.stringify(site.codeGrammars ?? []).replace(/</g, "\\u003c")}</script>
${opts.publish ? `<script>${inlineScript(opts.publish.codeJs)}</script>` : '<script src="/assets/code.js" defer></script>'}
<script>
// Functions toString'd under tsx (esbuild keepNames) contain __name(...) calls; define a no-op.
var __name = (f) => f;
const contentLanguage = () => JSON.parse(document.getElementById("boot")?.textContent || "null")?.contentLanguage || ${JSON.stringify(site.contentLanguage ?? site.defaultLang)};
const localeFetch = (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, "x-docs-language": contentLanguage() } });
(${mountTerms.toString()})(document);
(${mountTables.toString()})(document);
(${mountToc.toString()})(document);
(${mountVideos.toString()})(document);
(${mountFigureFrames.toString()})(document);
(${mountThemeVariants.toString()})(document);
(${mountThemePickers.toString()})(${JSON.stringify(THEME_ICONS)}, ${JSON.stringify(site.themes)});
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
(${mountToolsResize.toString()})();
(() => {
  // Open/close: by default "the branch containing the current doc is open" (the server adds
  // .open), overridden by explicit user actions (sessionStorage = per tab only).
  const OPEN_KEY = "docs:nav-open";
  const readOpen = () => { try { return JSON.parse(sessionStorage.getItem(OPEN_KEY) || "{}"); } catch { return {}; } };
  const applyOpen = () => {
    const o = readOpen();
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
  applyOpen();
  window.__docsNavRestore = applyOpen;
  const nav = document.getElementById("nav-groups");
  new ResizeObserver(() => (${focusNavTree.toString()})(nav)).observe(nav);
})();
${
    mode === "edit"
        ? `(() => {
  // Sidebar tree editing (delegated to document — keeps working when HMR swaps #nav-groups).
  //   drag: top 1/4 of a row = before, bottom 1/4 = after, middle = move into that doc's children
  //         (at the end). The DOM isn't moved, only a marker is shown; on drop, POST /api/move →
  //         re-fetch the nav regardless of the outcome (= the display is always a copy of
  //         dooc.yaml; no rollback logic).
  // The root placeholder and row buttons open the create form.
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
    const rp = location.pathname.startsWith("/_statics") ? location.pathname.slice(1) : location.pathname === "/_git" ? "_git" : location.pathname.startsWith("/_files") ? location.pathname.slice(8).replace(/^\\/|\\/$/g, "") : null;
    const res = await localeFetch("/api/nav?current=" + encodeURIComponent(id) + (rp == null ? "" : "&res=" + encodeURIComponent(rp)));
    if (res.ok) document.getElementById("nav-groups").innerHTML = (await res.json()).html;
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
  const editLabel = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest("button, input, form, .nav-doc-icon")) return;
    const row = target.closest("#nav-groups [data-doc-id] > .nav-row");
    if (!row) return;
    event.preventDefault();
    docAction(row.closest("[data-doc-id]"), "rename");
  };
  document.addEventListener("dblclick", editLabel);
  document.addEventListener("keydown", (event) => { if (event.key === "F2") editLabel(event); });
  const setIcon = async (slot, file) => {
    if (file && !/\\.svg$/i.test(file.name) && file.type !== "image/svg+xml") {
      setStatus("Icon must be svg", true);
      return;
    }
    const id = slot.closest(".nav-item")?.dataset.docId;
    try {
      const data = file ? btoa(Array.from(new Uint8Array(await file.arrayBuffer()), (byte) => String.fromCharCode(byte)).join("")) : null;
      const result = await post(id ? "/api/icon" : "/api/site-icon", { file: id ? id + ".md" : undefined, data });
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

  // ── In-sidebar create form ──
  const suggestFileName = ${suggestDocFileName.toString()};
  const closeForm = () => { for (const f of document.querySelectorAll(".nav-new-item")) f.remove(); };
  const openForm = (parent) => {
    closeForm();
    const host = parent
      ? document.querySelector('#nav-groups .nav-item[data-doc-id="' + CSS.escape(parent) + '"] > .nav-list')
      : document.querySelector("#nav-groups > .nav-list");
    if (!host) return;
    if (parent) {
      window.__docsNavOpen(parent, true);
    }
    const item = document.createElement("div");
    item.className = "nav-item nav-new-item";
    const row = document.createElement("div");
    row.className = "nav-row";
    const form = document.createElement("form");
    form.className = "nav-new";
    form.innerHTML =
      ${JSON.stringify(DOCS_ICON)} +
      '<input name="title" placeholder="title" data-i18n-placeholder="title" required autocomplete="off">' +
      '<div class="nav-new-file"><input name="name" placeholder="File name" data-i18n-placeholder="File name" aria-label="File name" data-i18n-aria-label="File name" required autocomplete="off" spellcheck="false">' +
      '<button class="nav-new-go" type="submit" title="Create" data-i18n-title="Create" aria-label="Create" data-i18n-aria-label="Create">↵</button></div>' +
      '<div class="err"></div>';
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
    title.addEventListener("input", () => { if (!nameTouched) nameInput.value = suggestFileName(title.value); });
    nameInput.addEventListener("input", () => { nameTouched = true; });
    form.addEventListener("keydown", (e) => { if (e.key === "Escape" && !busy) closeForm(); });
    // Close when focus moves out with nothing typed (keep partially filled forms).
    // (remove itself fires focusout, so defer one tick and close only if still there)
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
        await post("/api/create", { parent: parent || undefined, name: nameInput.value.trim(), title: title.value.trim() });
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
  document.addEventListener("click", (event) => {
    const btn = event.target instanceof Element ? event.target.closest("#sidebar .new, #sidebar .nav-create") : null;
    if (!btn) return;
    event.preventDefault();
    openForm(btn.dataset.parent || "");
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
${opts.publish ? `${opts.publish.pages}<script>${publishRouterScript(opts.publish.first)}${opts.publish.network ? `\n(${mountBundleNetwork.toString()})();` : ""}</script>` : `<script>${hmrClientScript(mode)}</script>`}</body></html>`;
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
      if (target) target.scrollIntoView(); else window.scrollTo(0, 0);
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
    mode: "static" | "network" = "static",
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
                publish: { graphJs, codeJs, pages: templates, first, network: mode === "network" },
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
    if (e.blocks.length > 0 || kids.length === 0) {
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
    const docs = site.entries.map((e) => ({
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
<button class="pbtn" type="button" data-theme-picker="editor" aria-label="Editor theme"></button>
${fontButton("editor")}
${languageFieldHtml(site.defaultLang, site.contentLanguage, entry.translatedLanguages, site.contentLanguages)}
<span id="status"></span>
<button id="validate" class="pbtn" type="button" title="Validate and apply" data-i18n-title="Validate and apply" aria-label="Validate and apply" data-i18n-aria-label="Validate and apply">${icon('<path d="M5 5l-4 5 4 5M15 5l4 5-4 5M7 10l2 2 4-5"/>')}</button>
<button id="save" class="pbtn" data-state="saved" type="button" title="Save (Ctrl+S)" data-i18n-title="Save (Ctrl+S)" aria-label="Save" data-i18n-aria-label="Save">${icon('<path d="M3 3h11l3 3v11H3z"/><path d="M6 3v5h7V3M6 17v-6h8v6"/>')}</button>
<button id="split-preview" class="pbtn" type="button" aria-pressed="false" aria-label="Split view" data-i18n-aria-label="Split view" title="Split view" data-i18n-title="Split view">${icon('<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M10 3v14"/>')}</button>
<div id="gear"><button class="pbtn" type="button" aria-haspopup="true" aria-label="View settings" data-i18n-aria-label="View settings" title="View settings" data-i18n-title="View settings">${GEAR_ICON}</button><div id="gearmenu">
<div id="language-setting"><select id="ui-language" aria-label="Editor language" data-i18n-aria-label="Language"><option value="eng">English</option><option value="jpn">日本語</option><option value="zho">中文</option></select></div>
<label><input type="checkbox" id="opt-autovalidate"><span data-i18n="Auto validate">Auto validate</span></label>
<label><input type="checkbox" id="opt-autosave"><span data-i18n="Auto save">Auto save</span></label>
<label><input type="checkbox" id="opt-corr"><span data-i18n="Source mapping">Source mapping</span></label>
<label><input type="checkbox" id="opt-git-diff"><span data-i18n="Show Git changes">Show Git changes</span></label>
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
                    : path === "/_git"
                      ? "_git"
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
    const draft = renderDraft(loadSite(locale), target.name, raw, fileDrafts);
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
    const result = ops.addFile(name, title, parent);
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
    const target = resolveContentFile(body?.file);
    if (!target || !existsSync(target.abs)) {
        sendJson(res, 404, { error: "target doc not found" });
        return;
    }
    const manifest = readManifest(root);
    if (manifest.errors.length) {
        sendJson(res, 409, { error: manifest.errors.join("\n") });
        return;
    }
    const previous = docIconFile(target.id, manifest.files);
    const file =
        manifest.files?.defaultLayout !== false &&
        !Object.hasOwn(manifest.files?.icons ?? {}, target.id) &&
        !existsSync(textfilePath(root, previous))
            ? defaultFilePath(`${target.id}-icon.svg`)
            : previous;
    const path = textfilePath(root, file);
    if (body?.data == null) {
        if (existsSync(path)) {
            unlinkSync(path);
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
        manifest.files.icons[target.id] = file;
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
};

/** Client bundle (src/<entry> as an IIFE). Sourcemap for the server, minified for publish. */
export const bundleClient = async (entry: string, publish = false): Promise<string> => {
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
        ...(publish ? { minify: true } : { sourcemap: "inline" as const }),
    });
    return out.outputFiles?.[0]?.text ?? "";
};

export const startServer = async (
    mode: ServeMode,
    port = 5179,
    pluginModule?: string,
): Promise<ViewerRuntime> => {
    // Language adapters are read once; the manifest is re-read by the compiler.
    siteLanguages = await loadSiteLanguages(root);
    const viewerPlugins = await loadViewerPlugins(pluginModule);
    workspaceSource = viewerPlugins.workspace;
    let gitOrigin = viewerPlugins.gitOrigin;
    const handleGit = createGitHandler(root, () => gitOrigin);
    const handlePlugins = createPluginHandler(viewerPlugins.plugins, viewerPlugins);
    // Client bundles (bundleClient) = edit's editing UI and the schema graph interaction layer
    // shared by preview/edit. React Flow's stylesheet isn't mixed into the bundle — the mount
    // layer (flow-css.ts) injects it into a <style> at runtime, so the page needs no CSS delivery
    // path (same conditions as the published output).
    // Cache the bundle result + etag per entry (graph.js / edit.js) — this path isn't hit by the
    // per-keystroke /api/render / /api/save, but tsx watch doesn't restart for these, so
    // invalidate explicitly on the watcher's "client" notification (changes to edit-client.ts /
    // the schema graph interaction layer's src/*.tsx).
    const bundleCache = createBundleCache();

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
    // DOCS_HMR=0 = no hot reload (nothing is watched = changes need a manual reload).
    if (process.env.DOCS_HMR !== "0") {
        const watcher = watchProject(root, pkgRoot, (kind, files) => {
            console.log(`hmr: ${kind} (${files.join(", ")})`);
            if (kind === "client") {
                bundleCache.clear();
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
                : path === "/assets/graph.js"
                  ? "core/schema-graph-global.tsx"
                  : mode === "edit" && path === "/assets/edit.js"
                    ? "viewer/edit-client.ts"
                    : path === "/assets/ui.js"
                      ? "viewer/ui-client.ts"
                      : undefined;
        if (req.method === "GET" && clientEntry != null) {
            const { js, etag } = await bundleCache.get(clientEntry, () =>
                bundleClient(clientEntry),
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
                        input.action === "read"
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
                            : (grammar?.name ?? extension);
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
            if (path === "/api/icon") {
                await handleIcon(req, res);
                return;
            }
            if (path === "/api/site-icon") {
                if (
                    !isLocalToolRequest(
                        req.headers.host ?? "",
                        req.headers.origin,
                        req.headers["content-type"],
                    )
                ) {
                    sendJson(res, 403, {
                        error: "Site icons require a same-origin local editor request",
                    });
                    return;
                }
                const result = siteIconResponse(root, await readJson(req));
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

        const site = loadSite(locale);
        if (req.method === "GET" && path === "/api/search") {
            sendJson(res, 200, searchIndex(site));
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
                (path === "/_git" ||
                    path === "/_statics" ||
                    path.startsWith("/_statics/") ||
                    path === "/_files" ||
                    path.startsWith("/_files/"))) ||
            path === "/_files/terms"
        ) {
            const rest = path.startsWith("/_statics")
                ? path.slice(1)
                : path === "/_git"
                  ? "_git"
                  : requestUrl.pathname.slice("/_files".length).replace(/^\/|\/$/g, "");
            const page = resourcesMain(site, rest);
            if (!page) {
                notFound(res, path);
                return;
            }
            const editor =
                mode === "edit"
                    ? (site.entries.find(
                          (entry) => entry.id === requestUrl.searchParams.get("editor"),
                      ) ?? site.entries[0])
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
        const id = resolveDocPath(site.entries, path);
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
        if (mode === "edit") {
            Object.assign(opts, editorAside(doc, site));
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
