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
//             manifest.yaml.
//             The client (src/viewer/edit-client.ts) is bundled in memory with esbuild on
//             first request (cached) and served.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageRegistration } from "shiki/core";
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
    catalogLanguages,
    readCatalog,
    setDocTranslation,
    writeCatalog,
} from "../compiler/locales.js";
import { readManifest } from "../compiler/manifest.js";
import { assembleDoc, createDocOps, isOpError, type OpResult } from "../compiler/ops.js";
import type { ArtifactDoc, TermEntry } from "../core/artifact-types.js";
import type { Block, TocEntry } from "../core/blocks.js";
import { docIdOfFile } from "../core/content-metadata.js";
import { figureFrameHtml, mountFigureFrames } from "../core/figure-frame.js";
import { docHtml, escapeHtml, figureIndexRoute, type RenderCtx, termsHtml } from "../core/html.js";
import { isLangTag, type LanguageAdapter, resolveLanguage } from "../core/language.js";
import { ancestorsOf, childrenOf, docPath, resolveDocPath } from "../core/routing.js";
import { CODE_LANGS, docDisplayName, type Frontmatter } from "../core/taxonomy.js";
import { mountTerms } from "../core/terms-ui.js";
import { isRemoteTextfile, textfileName } from "../core/textfile.js";
import {
    isLocalToolRequest,
    runCodeTool,
    validateCodeTools,
    validateTextfileCode,
} from "./editor-tools.js";
import { fontCss, readFont } from "./fonts.js";
import { createHmrHub, HMR_PATH, hmrClientScript, watchProject } from "./hmr.js";
import { translate } from "./i18n.js";
import { DEFAULT_SITE_LANGUAGES, loadSiteLanguages } from "./languages.js";
import { focusNavTree } from "./nav-focus.js";
import { mountPanelResize } from "./resize.js";
import { mountSearch, SEARCH_LABELS, searchIndex, searchSections } from "./search.js";
import { previewTextfiles, textfileResponse } from "./textfile.js";

export type ServeMode = "preview" | "edit";

// pkgRoot = the viewer itself (src/ for the client bundles). docsRoot = the docs folder that
// follows the layout convention (content/ figures/).
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const root = resolve(process.env.DOCS_ROOT ?? process.cwd());
const contentDir = join(root, "content");
const iconsDir = join(root, ICONS_DIR);

/**
 * One doc in the viewer = a view model combining the compiler's ArtifactDoc (rendering) and
 * DocSource (extra info for editing).
 * file is `<id>.md` (= same shape as the save API's file parameter; ArtifactDoc.file minus the
 * content/ prefix).
 */
export interface Entry {
    id: string;
    translatedLanguages?: string[];
    /** Parent doc id (omitted = top level). */
    parent?: string;
    file: string;
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
}

export interface Site {
    title?: string;
    icon?: string;
    codeLanguages?: string[];
    codeGrammars?: LanguageRegistration[];
    contentLanguage?: string;
    availableLanguages?: string[];
    /** Display order (pre-order traversal of the manifest). */
    entries: Entry[];
    ctx: RenderCtx;
    /** Errors not tied to a doc (the compiler's siteErrors). Shown on every page. */
    errors: string[];
    /** Language adapters (docs.config.mjs + built-ins); each doc renders with its own. */
    languages: readonly LanguageAdapter[];
    /** Site default language. */
    defaultLang: string;
}

const CONTENT_PREFIX = "content/";

const toEntry = (doc: ArtifactDoc, source: DocSource): Entry => ({
    id: doc.id,
    ...(doc.parent == null ? {} : { parent: doc.parent }),
    file: doc.file.slice(CONTENT_PREFIX.length),
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
});

// Recompile on every request (= read the docs.json equivalent in real time). The compiler's cache
// skips re-parsing files unchanged on disk, so it stays cheap even when called on every keystroke
// (POST /api/render). Replaced in startServer once docs.config.mjs (default language / adapters)
// has been loaded.
let siteLanguages = DEFAULT_SITE_LANGUAGES;
let compiler = createCompiler(root);
const ops = createDocOps(root);

/** Compile result → viewer Site (shared by the server's per-request path and one-off publish). */
export const siteFrom = (
    { artifact, figures, sources, siteErrors, defaultLang }: Compiled,
    languages: readonly LanguageAdapter[] = DEFAULT_SITE_LANGUAGES.languages,
): Site => {
    return {
        ...(artifact.title === undefined ? {} : { title: artifact.title }),
        ...(artifact.icon === undefined ? {} : { icon: artifact.icon }),
        entries: artifact.docs.flatMap((doc) => {
            const source = sources.get(doc.file);
            return source ? [toEntry(doc, source)] : [];
        }),
        ctx: {
            figures: new Map(figures.map((f) => [f.name, f])),
            terms: artifact.terms,
            termLinks: new Map(
                artifact.docs.flatMap((doc) =>
                    doc.blocks.flatMap((block) =>
                        block.type === "term"
                            ? [[block.entry.id, `/${doc.id}#term-${block.entry.id}`] as const]
                            : [],
                    ),
                ),
            ),
            figureIndex: figureIndexRoute(artifact.docs),
        },
        errors: siteErrors,
        languages,
        defaultLang,
    };
};

const localeCompilers = new Map<string, ReturnType<typeof createCompiler>>();
let watchTextfiles: ((files: Iterable<string>) => void) | undefined;
const watchEntryTextfiles = (entries: readonly Entry[]): void => {
    watchTextfiles?.(
        entries.flatMap((entry) =>
            entry.blocks.flatMap((block) =>
                block.type === "code" && block.filename ? [block.filename] : [],
            ),
        ),
    );
};
const loadSite = (locale = contentLanguageCode(siteLanguages.defaultLang)): Site => {
    let selected = compiler;
    if (locale !== contentLanguageCode(siteLanguages.defaultLang)) {
        selected =
            localeCompilers.get(locale) ??
            createCompiler(root, { defaultLang: siteLanguages.defaultLang, locale });
        localeCompilers.set(locale, selected);
    }
    const site = siteFrom(selected.compile(), siteLanguages.languages);
    const sourceLanguage = contentLanguageCode(site.defaultLang);
    for (const entry of site.entries) entry.translatedLanguages = [sourceLanguage];
    for (const language of catalogLanguages(root)) {
        try {
            const catalog = readCatalog(root, language);
            for (const entry of site.entries) {
                if (Object.hasOwn(catalog, entry.id)) entry.translatedLanguages?.push(language);
            }
        } catch (error) {
            site.errors.push(String(error));
        }
    }
    watchEntryTextfiles(site.entries);
    const siteIconFile = readManifest(root).icon;
    if (siteIconFile) watchTextfiles?.([siteIconFile]);
    return {
        ...site,
        codeLanguages: siteLanguages.codeLanguages,
        codeGrammars: siteLanguages.codeGrammars,
        contentLanguage: locale,
        availableLanguages: [
            ...new Set([
                contentLanguageCode(site.defaultLang),
                locale,
                "eng",
                "jpn",
                "zho",
                "kor",
                "fra",
                "deu",
                "spa",
                "por",
                ...catalogLanguages(root),
            ]),
        ],
    };
};

const draftContext = (site: Site): DraftContext => ({
    root,
    docs: site.entries.map((e) => ({
        id: e.id,
        ...(e.parent == null ? {} : { parent: e.parent }),
        file: CONTENT_PREFIX + e.file,
    })),
    figures: site.ctx.figures,
    termSources: site.entries.map((entry) => ({
        file: CONTENT_PREFIX + entry.file,
        entries: entry.blocks.flatMap((block) => (block.type === "term" ? [block.entry] : [])),
    })),
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
                terms: [
                    ...site.ctx.terms.filter(
                        (term) =>
                            !site.entries
                                .find((saved) => saved.file === entry.file)
                                ?.blocks.some(
                                    (block) => block.type === "term" && block.entry.id === term.id,
                                ),
                    ),
                    ...entry.blocks.flatMap((block) =>
                        block.type === "term" ? [block.entry] : [],
                    ),
                ],
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
    const { doc, source } = compileDraft(
        { ...draftContext(site), textfiles },
        CONTENT_PREFIX + file,
        raw,
    );
    const entry = toEntry(doc, source);
    watchEntryTextfiles([entry]);
    return entry;
};

// Render the raw being edited (unsaved draft) to body html — shared by the save / render APIs.
const renderDraft = (
    site: Site,
    file: string,
    raw: string,
    textfiles?: ReadonlyMap<string, string>,
): { html: string; errors: string[]; toc: TocEntry[]; blockLines: number[] } => {
    const entry = draftEntry(site, file, raw, textfiles);
    return {
        html: renderEntry(site, entry, ""),
        errors: [...site.errors, ...entry.errors],
        toc: entry.toc,
        blockLines: entry.blockLines,
    };
};

// Render result cache — opening the same doc repeatedly (page GET / nav switch) doesn't re-render.
// The compiler's cache returns the same blocks reference while disk is unchanged, so check that,
// plus that the id list (affects doc: link resolution) / terms / figures / errors haven't
// changed. Rebuild if any of them did.
const renderSignature = (site: Site, entry: Entry): string =>
    JSON.stringify([site.ctx.terms, site.errors, entry.errors, entry.frontmatter, entry.lang]) +
    site.entries
        .map((e) => docPath(site.entries, e.id))
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
    raw: string;
    frontmatter: Frontmatter | undefined;
    body: string;
    html: string;
    errors: string[];
    toc: TocEntry[];
    blockLines: number[];
} => {
    const entry = draftEntry(site, file, raw);
    return {
        raw,
        frontmatter: entry.frontmatter,
        body: entry.body,
        html: renderEntry(site, entry, ""),
        errors: [...site.errors, ...entry.errors],
        toc: entry.toc,
        blockLines: entry.blockLines,
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
    return id == null ? undefined : { id, name: `${id}.md`, abs: join(contentDir, `${id}.md`) };
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

// Monospace font stack for code blocks etc. (same value as the editor's MONO_FONT in
// edit-client.ts).
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
const BOX_ICON = icon(
    '<path d="M3.5 6.5 10 3l6.5 3.5v7L10 17l-6.5-3.5v-7Z"/><path d="M3.5 6.5 10 10l6.5-3.5M10 10v7"/>',
);
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

const CSS = `
:root { ${DARK_C} ${DOC_FROM_C} --doc-mono: ${MONO_FONT}; --font-sans: ${SANS_FONT}; }
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { ${LIGHT_C} } }
:root[data-theme="light"] { ${LIGHT_C} }
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
body.sidebar-closed #sidebar-content, body.sidebar-closed .site-title,
body.sidebar-closed #sidebar-foot .nav-label { display: none; }
#sidebar-head { position: relative; flex: none; display: flex; align-items: center; min-width: 0; min-height: 47px;
  border-bottom: 1px solid var(--c-line); }
#sidebar-toggle { flex: none; display: flex; align-items: center; padding: 14px 16px;
  background: transparent; border: none; color: var(--c-fg-muted); cursor: pointer; }
#sidebar-toggle:hover { color: var(--c-fg); }
#site-icon { flex: none; width: 24px; height: 24px; margin: 0 8px 0 16px; object-fit: contain; }
body.sidebar-closed #site-icon { margin: 0 auto; }
body.sidebar-closed #sidebar-toggle { position: absolute; inset: 0; width: 100%; justify-content: center; padding: 0; }
body.sidebar-closed #sidebar-head:has(#site-icon:not([hidden])) #sidebar-toggle svg { visibility: hidden; }
#site-icon[hidden] { display: block; visibility: hidden; }
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
.nav-list:has(> .nav-ancestor) > .nav-item:not(.nav-ancestor) { display: none; }
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
/* Resources (edit only). Dashed border to set it apart from the doc tree */
.nav-resources { margin: 12px 12px 4px; border: 1px dashed var(--c-line); border-radius: 6px; overflow: hidden; }
.nav-resources .nav-row > .nav-link { padding: 8px 12px; gap: 12px; }
.nav-resources .nav-tree { --nav-pad: calc(42px + (var(--nav-depth, 2) - 2) * 22px); }
#nav-status { min-height: 16px; margin: 6px 16px 0; color: var(--c-fg-faint); font-size: 11px;
  line-height: 1.35; }
#nav-status.err { color: var(--c-danger); }
#sidebar-foot { flex: none; margin-top: auto; border-top: 1px solid var(--c-line); padding: 8px 0; }
#theme { width: 100%; }

/* ── main (document body) ── */
main { flex: 1; min-width: 0; padding: 20px 24px 50vh; }
article { max-width: 860px; margin: 0 auto; font-family: system-ui, sans-serif; }
article, article * { font-weight: 400; }
h1, h2, h3 { font-weight: 400; }
article h1 { font-size: 26px; margin: 0 0 2px; }
article :is(h1, h2, h3, h4, h5, h6):has(> .section-copy) { position: relative; padding-right: 32px; }
.section-copy { position: absolute; right: 0; top: 0; display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; border: 0; border-radius: 4px; background: transparent;
  color: var(--c-fg-faint); cursor: pointer; }
.section-copy:hover, .section-copy:focus-visible { background: var(--c-raised); color: var(--c-fg); }
.section-copy.ok svg, .section-copy.error svg { display: none; }
.section-copy.ok::after { content: "✓"; color: var(--c-ok); }
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
.fig { margin: 10px 0; }
/* Only direct svg / img children (= figures) follow the width; icon svgs inside html fragments
   are left alone */
.fig > svg, .fig > img { max-width: 100%; height: auto; display: block; }
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
.codeblk-filename { order: 1; margin: 0; min-width: 0; max-width: 70%;
  font-family: var(--doc-mono); font-size: 11px; color: var(--doc-fg-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.codefold svg { transition: transform 150ms ease; }
.codeblk.collapsed .codefold svg { transform: rotate(-90deg); }
@media (prefers-reduced-motion: reduce) { .codefold svg { transition: none; } }
.codeblk.collapsed > pre { display: none; }
.codeblk.collapsed { min-height: 1px; border-bottom: 0; margin-bottom: 18px; }
.codeblk :is(.codecopy, .codefold) { display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; width: 16px; height: 16px; padding: 0; border: none; border-radius: 6px; background: none;
  color: var(--doc-fg-3); cursor: pointer; }
.codeblk :is(.codecopy, .codefold):hover, .codeblk :is(.codecopy, .codefold):focus-visible { color: var(--doc-accent);
  background: color-mix(in srgb, currentColor 8%, transparent); }
.codeblk .codecopy .ic-ok { display: none; }
.codeblk .codecopy.ok .ic-copy { display: none; }
.textfile-unavailable { margin: 0; padding: 12px; color: var(--doc-fg-2); font-size: 12px; }
.textfile.unavailable .codeblk-head { cursor: default; }
.codeblk .codecopy.ok .ic-ok { display: block; color: var(--doc-ok); }
table { border-collapse: collapse; font-size: 14px; }
th, td { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); padding: 4px 10px; }
article a { color: var(--doc-accent); }
.ph { border: 1px dashed color-mix(in srgb, currentColor 40%, transparent);
  border-radius: 8px; padding: 18px; text-align: center; margin: 16px 0; }
.ph span { opacity: .5; font-size: 13px; }
.cap { opacity: .7; font-size: 13px; margin-top: 6px; white-space: pre-line; }
.callout { border: 1px solid color-mix(in srgb, var(--doc-accent) 45%, transparent);
  border-radius: 8px; padding: 4px 16px; margin: 10px 0; }
.callout .cap { margin: 6px 0 0; }
.errors { border: 1px solid var(--doc-danger); border-radius: 8px; padding: 10px 16px;
  margin-bottom: 16px; color: var(--doc-danger); font-size: 13px; }
.in-toc { border: 1px solid var(--doc-border); border-radius: 8px;
  padding: 8px 14px 10px; margin: 10px 0 20px; }
.in-toc-title { font-size: 11.5px; opacity: .6; margin-bottom: 3px; }
.in-toc ul { list-style: none; margin: 0; padding-left: 0; line-height: 1.55; }
.in-toc li.lvl2 { padding-left: 14px; }
.in-toc li.lvl3 { padding-left: 26px; opacity: .7; font-size: .95em; }
.in-toc a { text-decoration: none; color: inherit; }
.in-toc a:hover { color: var(--doc-accent); }
ul.idx { list-style: none; padding: 0; }
ul.idx li { margin: 10px 0; }
details summary { cursor: pointer; opacity: .8; }
/* Figure refs (Fig. <name>) / term references in the body: link-like, rendering the figure /
   definition on hover */
.figref, .dictref { color: var(--doc-accent-2); text-decoration: none;
  border-bottom: 1px dotted currentColor; position: relative; cursor: pointer; }
.figref .figpop, .dictref .dictpop { display: none; position: absolute; left: 50%;
  transform: translateX(-50%); top: calc(100% + 6px); z-index: 5;
  width: min(560px, 78vw); padding: 12px 14px;
  background: var(--doc-panel); border: 1px solid var(--doc-border);
  border-radius: 8px; box-shadow: 0 4px 16px color-mix(in srgb, var(--doc-fg) 18%, transparent);
  color: var(--doc-fg); font-size: 13px; line-height: 1.7; }
.figref:hover .figpop, .dictref:hover .dictpop { display: block; }
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
`;

// edit mode only (right panel / new doc form). Uses the viewer's shared background / rules and
// button / input styles. To keep CM as wide as possible the fm is compact, and the toggles
// (autosave / correspondence display / fm visibility) are gathered in the header gear's hover
// menu. Width is drag-resizable.
const EDIT_CSS = `
/* Right panel = header / properties / editor stacked on one surface, separated by rules (no
   nested frames). */
#panel { width: var(--panel-width, min(760px, 52vw)); flex-shrink: 0; position: sticky; top: 0; height: 100vh;
  display: flex; flex-direction: column; font-size: 12.5px; line-height: 1.6;
  border-left: 1px solid var(--c-line); background: var(--c-bg1); }

/* header band (same height and rule as sidebar-head) */
#phead { flex: none; display: flex; align-items: center; gap: 2px; height: 47px; padding: 0 10px 0 14px;
  border-bottom: 1px solid var(--c-line); }
/* Document metadata is edited in the tree, without changing the row's size. */
body.edit #nav-groups { --nav-rail: 22px; --nav-icon-half: 9px; }
.nav-doc-row { padding-left: 12px; gap: 3px; min-height: 38px; }
.nav-tree .nav-doc-row { padding-left: var(--nav-pad); }
.nav-doc-row:has(> a.cur) { background: var(--c-raised); }
.nav-row.nav-doc-row > a { padding: 4px 2px; background: transparent; }
.nav-doc-row > a::before { display: none; }
.nav-doc-name { display: flex; flex-direction: column; min-width: 0; line-height: 17px; }
.nav-doc-id { color: var(--c-fg-faint); font: 10px/12px var(--doc-mono); overflow: hidden; text-overflow: ellipsis; }
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
.nav-rename-form { position: absolute; z-index: 4; display: flex; flex-direction: column; justify-content: center;
  background: var(--c-bg0); }
.nav-rename-form input { width: 100%; min-width: 0; box-sizing: border-box; color: var(--c-fg);
  background: transparent; border: 0; border-radius: 2px; padding: 0 2px; font: inherit; line-height: 17px; }
.nav-rename-form input[name="id"] { font: 10px/12px var(--doc-mono); color: var(--c-fg-faint); }
.nav-rename-form input:focus { outline: 1px solid var(--c-accent); }
.nav-rename-form input:invalid { outline-color: var(--c-danger); }
.nav-doc-row.renaming > a { visibility: hidden; }
.pbtn { flex: none; display: flex; align-items: center; justify-content: center; width: 28px; height: 28px;
  padding: 0; color: var(--c-fg-faint); background: none; border: none; border-radius: 5px; cursor: pointer;
  transition: color 120ms ease, background 120ms ease; }
.pbtn:hover, .pbtn:focus-visible, #gear.open > .pbtn { color: var(--c-fg); background: var(--c-raised); }
.nav-delete:hover, .nav-delete:focus-visible { color: var(--c-danger); }
#status { flex: 1; min-width: 0; padding: 0 8px; text-align: right; color: var(--c-fg-faint);
  font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#status.err { color: var(--c-danger); }
#preview-status { display: inline-flex; flex-shrink: 0; color: var(--c-ok); }
#preview-status svg { width: 18px; height: 18px; }
#preview-status [data-preview-icon] { display: none; }
#preview-status[data-state="valid"] [data-preview-icon="valid"],
#preview-status[data-state="error"] [data-preview-icon="error"],
#preview-status[data-state="loading"] [data-preview-icon="loading"] { display: block; }
#preview-status[data-state="error"] { color: var(--c-danger); }
#preview-status[data-state="loading"] { color: var(--c-accent); }
#preview-status[data-state="loading"] svg { animation: preview-spin 1s linear infinite; }
@keyframes preview-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { #preview-status[data-state="loading"] svg { animation: none; } }
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
.pane-actions { position: relative; top: -12px; right: -16px; height: 0; display: flex; justify-content: flex-end; z-index: 4; }
.pane-actions .pbtn { background: var(--c-bg0); border-radius: 50%; }
.preview-content article > h1 { padding-right: 34px; }
#preview-panes { display: flex; flex: 1; min-height: 0; }
.preview-pane { flex: 1; min-width: 0; overflow: auto; padding: 20px 24px 50vh; border-top: 2px solid transparent; }
#preview-panes.split .preview-pane { padding: 16px; }
#preview-panes.split .pane-actions { top: -8px; right: -8px; }
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
#validate[data-state="pending"], .cm-textfile-validate[data-state="pending"] { color:var(--c-accent); }
#save[data-state="error"], .cm-textfile-save[data-state="error"] { color:var(--c-danger); }
#save[data-state="saved"], .cm-textfile-save[data-state="saved"] { color:var(--c-ok); }
#save[data-state="pending"], .cm-textfile-save[data-state="pending"] { color:var(--c-accent); }
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

/* Upload target for body assets (bottom of the sidebar, dashed 16:9 frame) */
#dropzone { flex: none; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 4px; margin: 8px 12px; aspect-ratio: 16 / 9; max-height: 120px; color: var(--c-fg-faint);
  border: 1px dashed var(--c-line); border-radius: 6px; cursor: pointer; text-align: center;
  font-size: 12px; transition: border-color 120ms ease, background 120ms ease, color 120ms ease; }
#dropzone:hover, #dropzone.over { color: var(--c-fg-muted); border-color: var(--c-accent);
  background: color-mix(in srgb, var(--c-accent) 6%, transparent); }
body.sidebar-closed #dropzone { display: none; }

/* Resources pages */
.res-page h1 { margin-bottom: 6px; }
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
.res-empty { color: var(--c-fg-faint); }
.res-dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 16px 0 0; font-size: 13px; }
.res-dl dt { color: var(--c-fg-faint); }
.res-dl dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }

/* Draft placeholders, the in-sidebar create form, and drag moves */
.nav-row .new, .nav-row .nav-delete { flex: none; width: 20px; height: 24px; display: flex;
  align-items: center; justify-content: center; border: none; border-radius: 4px; padding: 0;
  background: transparent; color: var(--c-fg-muted); cursor: pointer; opacity: 0; }
.nav-row:hover :is(.new, .nav-delete), .nav-row:focus-within :is(.new, .nav-delete),
.nav-row.renaming :is(.new, .nav-delete) { opacity: 1; }
.nav-row :is(.new, .nav-delete):hover { background: var(--c-line); }
.nav-doc-row .nav-tree-toggle, .nav-tree-spacer { width: 18px; margin-right: 3px; }
.nav-tree-spacer { flex: none; height: 28px; }
@media (hover: none) { .nav-row :is(.new, .nav-delete) { opacity: 1; } }
.nav-row > .nav-create { display: flex; flex: 1; min-width: 0; align-items: center; gap: 5px; margin: 4px 12px; padding: 5px 10px;
  min-height: 42px; border: 1px dashed var(--c-line); border-radius: 6px; background: none;
  color: var(--c-fg-faint); font: inherit; text-align: left; cursor: pointer; }
.nav-tree .nav-create { margin-left: calc(var(--nav-pad) - 12px); }
.nav-create:hover { color: var(--c-fg-muted); background: var(--c-raised); }
.nav-create > .nav-icon { color: var(--c-fg-muted); }
.nav-create .nav-label { color: var(--c-fg-muted); }
.nav-add-hover { display: none; }
#sidebar:hover .nav-add-hover, #sidebar:focus-within .nav-add-hover { display: block; }
#sidebar .nav-list:has(> .nav-new-item) > .nav-placeholder { display: none; }
/* Create form = a draft row inserted into the tree (same guide lines / indent; the └ connects to
   it). Line 1 = title (underline-only input), line 2 = /id (mono) + ↵. */
.nav-row.nav-new { flex-direction: column; align-items: stretch; gap: 1px; cursor: auto;
  padding: 5px 12px 6px var(--nav-pad, 48px); background: var(--c-raised); }
.nav-new > .nav-icon { position: absolute; left: 16px; top: 8px; color: var(--c-fg-faint); }
.nav-new input { font: inherit; color: var(--c-fg); background: transparent; border: none;
  padding: 1px 0; min-width: 0; outline: none; }
.nav-new input::placeholder { color: var(--c-fg-faint); }
.nav-new input[name="title"] { font-size: 13px; border-bottom: 1px solid var(--c-line); }
.nav-new input[name="title"]:focus { border-bottom-color: var(--c-accent); }
.nav-new-id { display: flex; align-items: center; gap: 1px; color: var(--c-fg-faint);
  font-family: var(--doc-mono); font-size: 11px; }
.nav-new-id input { flex: 1; font-family: inherit; font-size: inherit; color: var(--c-fg-muted); }
.nav-new-go { flex: none; display: flex; align-items: center; justify-content: center; width: 20px;
  height: 18px; padding: 0; font-size: 11px; color: var(--c-fg-faint); background: none;
  border: 1px solid var(--c-line); border-radius: 4px; cursor: pointer; }
.nav-new-go:hover { color: var(--c-accent); border-color: var(--c-accent); }
.nav-new .err { color: var(--c-danger); font-size: 11px; line-height: 1.4; }
.nav-new .err:empty { display: none; }
.nav-tree > .nav-new-item > .nav-row::before { top: 16px; }
.nav-tree > .nav-new-item:last-child > .nav-row::after { height: 16px; }
.nav-tree > .nav-new-item > .nav-row::before, .nav-tree > .nav-new-item > .nav-row::after,
.nav-tree > .nav-item:has(~ .nav-new-item)::before { background: var(--c-accent); }
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
    /** Current location among the Resources pages (the part after `/_resources`). */
    currentRes?: string;
    /** edit-mode doc pages only: right-panel html + client boot data. */
    aside?: string;
    boot?: unknown;
    /**
     * When writing out a single static HTML file (publishHtml). Replaces every server-served
     * script with an inline one.
     */
    publish?: { graphJs: string; codeJs: string; pages: string; first: string };
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
                    link = `<a class="${depth === 0 ? "nav-link" : "nav-tree-link"}${cur}" href="/${e.id}" title="${label}" aria-keyshortcuts="F2"><span class="nav-doc-name"><span class="nav-label">${label}</span><span class="nav-doc-id">${escapeHtml(e.file)}</span></span></a>`;
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
                ? `<div class="nav-item nav-placeholder${items ? " nav-add-hover" : ""}"><div class="nav-row"><button class="nav-create" type="button" data-parent="" aria-label="Add doc" data-i18n-aria-label="Add doc">${DOCS_ICON}<span class="nav-doc-name" aria-hidden="true"><span class="nav-label">...</span><span class="nav-doc-id">... .md</span></span></button></div></div>`
                : "";
        return depth === 0
            ? `<div class="nav-list nav-root" data-parent="">${items}${placeholder}</div>`
            : `<div class="nav-list nav-tree" data-parent="${escapeHtml(parent ?? "")}" style="--nav-depth:${depth + 1}">${items}${placeholder}</div>`;
    };
    const html = list(undefined, 0) + (mode === "edit" ? navResourcesHtml(site, currentRes) : "");
    return docLinks(site, site.contentLanguage ? languageLinks(html, site.contentLanguage) : html);
};

// ── Resources (shown in edit mode only; asset list of the docs root) ──────────────────────
// Structure: Resources (list page of everything) › kind (list pages for figures / html / icons) › individual file.
// Route is `/_resources[/<kind>[/<file>]]` (doc ids can't start with `_`, so no collision).
const RESOURCE_KINDS = ["figures", "html", "icons", "terms"] as const;
type ResourceKind = (typeof RESOURCE_KINDS)[number];
interface Resource {
    kind: ResourceKind;
    /** Key within the kind (the end of the route). */
    file: string;
    /** Path relative to the docs root. */
    path: string;
}
const siteResources = (site: Site): Resource[] => [
    ...site.ctx.terms.map((term) => ({
        kind: "terms" as const,
        file: term.id,
        path:
            CONTENT_PREFIX +
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
            path: `${ICONS_DIR}/${e.id}.svg`,
        })),
];
const resourceHref = (kind?: ResourceKind, file?: string): string =>
    `/_resources${kind ? `/${kind}` : ""}${file ? `/${encodeURIComponent(file)}` : ""}`;

/**
 * Resources section at the end of the sidebar (dashed box). currentRes = path after
 * `/_resources` (`""` = the list).
 */
const navResourcesHtml = (site: Site, currentRes?: string): string => {
    const all = siteResources(site);
    const count = (n: number): string => `<span class="nav-count">${n}</span>`;
    const groups = RESOURCE_KINDS.map((kind) => {
        const files = all.filter((r) => r.kind === kind);
        const items = files
            .map((r) => {
                const cur = currentRes === `${kind}/${r.file}` ? " cur" : "";
                return `<div class="nav-item" data-node-id="_res:${kind}/${escapeHtml(r.file)}"><div class="nav-row"><a class="nav-tree-link${cur}" href="${resourceHref(kind, r.file)}" title="${escapeHtml(r.path)}"><span class="nav-label">${escapeHtml(r.file)}</span></a></div></div>`;
            })
            .join("");
        const open = currentRes?.startsWith(`${kind}`) ? " open" : "";
        const cur = currentRes === kind ? " cur" : "";
        const toggle =
            files.length > 0
                ? `<button class="nav-tree-toggle" type="button" aria-label="Toggle ${translate("eng", kind)}">${CHEVRON_ICON}</button>`
                : "";
        return `<div class="nav-item${open}" data-node-id="_res:${kind}"><div class="nav-row"><a class="nav-tree-link${cur}" href="${resourceHref(kind)}"><span class="nav-label" data-i18n="${kind}">${translate("eng", kind)}</span>${count(files.length)}</a>${toggle}</div><div class="nav-list nav-tree" style="--nav-depth:3">${items}</div></div>`;
    }).join("");
    const open = currentRes != null ? " open" : "";
    const cur = currentRes === "" ? " cur" : "";
    return `<div class="nav-resources"><div class="nav-list nav-root"><div class="nav-item${open}" data-node-id="_res"><div class="nav-row"><a class="nav-link${cur}" href="/_resources">${BOX_ICON}<span class="nav-label" data-i18n="Resources">Resources</span>${count(all.length)}</a><button class="nav-tree-toggle" type="button" aria-label="Toggle Resources">${CHEVRON_ICON}</button></div><div class="nav-list nav-tree" style="--nav-depth:2">${groups}</div></div></div></div>`;
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
    if (r.kind === "terms") return termsHtml(site.ctx.terms.filter((term) => term.id === r.file));
    if (r.kind === "figures" || r.kind === "html") {
        const f = site.ctx.figures.get(figureName(r.file));
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
    r.kind === "figures" || r.kind === "html"
        ? site.entries.filter((e) => e.figureRefs?.includes(figureName(r.file)))
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

/** Path after `/_resources` → main content (unknown → undefined = 404). */
export const resourcesMain = (
    site: Site,
    rest: string,
): { title: string; main: string } | undefined => {
    const all = siteResources(site);
    const [kind, ...tail] = rest === "" ? [] : rest.split("/");
    const file = tail.length > 0 ? decodeURIComponent(tail.join("/")) : undefined;
    if (kind == null) {
        const sections = RESOURCE_KINDS.map((k) => {
            const list = all.filter((r) => r.kind === k);
            return `<section class="res-section"><h2><a href="${resourceHref(k)}" data-i18n="${k}">${k}</a> <span class="res-sub">${list.length}</span></h2>${k === "terms" ? termsHtml(site.ctx.terms) : resourceCards(site, list)}</section>`;
        }).join("");
        return {
            title: "Resources",
            main: `<article class="res-page"><h1 data-i18n="Resources">Resources</h1>${sections}</article>`,
        };
    }
    if (!RESOURCE_KINDS.includes(kind as ResourceKind)) {
        return undefined;
    }
    const k = kind as ResourceKind;
    const crumbs = `<nav class="res-crumbs"><a href="/_resources" data-i18n="Resources">Resources</a> › ${file ? `<a href="${resourceHref(k)}" data-i18n="${k}">${k}</a> › ${escapeHtml(file)}` : k}</nav>`;
    if (file == null) {
        return {
            title: `${k} — Resources`,
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
        k === "figures" || k === "html" ? site.ctx.figures.get(figureName(r.file)) : undefined;
    const used = resourceUsage(site, r);
    const snippet =
        k === "terms"
            ? `:::term(${r.file})`
            : fig
              ? `:::${fig.kind === "html" ? "html" : "figure"}(${r.file})`
              : undefined;
    const rows = [
        ["path", `<code>${escapeHtml(r.path)}</code>`],
        ["size", sizeOf(r.path)],
        ...(fig ? [["kind", fig.kind]] : []),
        ...(fig?.title ? [["title", escapeHtml(fig.title)]] : []),
        ...(fig?.desc ? [["desc", escapeHtml(fig.desc)]] : []),
        ...(snippet ? [["syntax", `<code class="res-snippet">${escapeHtml(snippet)}</code>`]] : []),
        [
            k === "icons" ? "doc" : "used in",
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
        title: `${r.file} — Resources`,
        main: `<article class="res-page">${crumbs}<h1>${escapeHtml(r.file)}</h1><div class="res-preview${k === "icons" ? " square" : ""}">${resourcePreview(site, r)}</div><dl class="res-dl">${rows.map(([dt, dd]) => `<dt data-i18n="${dt}">${dt}</dt><dd>${dd}</dd>`).join("")}</dl></article>`,
    };
};

// Browser tab title — shared by page() and `/api/page` (doc switching via client-side navigation).
const pageTitle = (mode: ServeMode, title: string, siteTitle?: string): string =>
    title === siteTitle ? title : `${title} — ${siteTitle ?? `dooc ${mode}`}`;

// Navigation follows the manifest hierarchy via routing.docPath.
const page = (mode: ServeMode, site: Site, opts: PageOpts): string => {
    const nav = navGroupsHtml(mode, site, opts.currentId, opts.currentRes);
    // Upload target for body assets (figures/). edit only; pinned to the bottom of the sidebar
    // (above theme).
    const dropzone =
        mode === "edit"
            ? `<label id="dropzone" title="figures/"><input id="dropfile" type="file" multiple hidden accept=".svg,.png,.webp,.jpg,.jpeg,.html">${UPLOAD_ICON}<span data-i18n="figures">figures</span></label>`
            : "";
    const siteTitle = escapeHtml(site.title ?? "dooc");
    const bootScripts =
        opts.boot != null
            ? `<script id="boot" type="application/json">${JSON.stringify(opts.boot).replace(/</g, "\\u003c")}</script>
<script src="/assets/edit.js"></script>`
            : mode === "edit"
              ? '<script src="/assets/ui.js"></script>'
              : "";
    // Interaction layer of the schema graph (zoom / pan / box drag / enlarged view). Shared by
    // preview / edit. Figures are readable without JS, so defer is enough (= progressive
    // enhancement).
    const main =
        opts.boot != null
            ? `<main class="editor-workspace">


<div id="preview-language-menu" role="menu" aria-label="Change language" data-i18n-aria-label="Change language" hidden></div>
<div id="preview-panes"><section class="preview-pane active" tabindex="0" aria-label="Active pane" data-i18n-aria-label="Active pane"><div class="pane-actions"><button class="pbtn pane-language" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="preview-language-menu" aria-label="Change language" data-i18n-aria-label="Change language" title="Change language" data-i18n-title="Change language">${icon('<circle cx="10" cy="10" r="7"/><ellipse cx="10" cy="10" rx="3" ry="7"/><path d="M3 10h14"/>')}</button></div><div class="preview-content">${opts.main}</div></section></div></main>`
            : `<main>${opts.main}</main>`;
    const graphScript = opts.publish
        ? `<script>${inlineScript(opts.publish.graphJs)}</script>`
        : '<script src="/assets/graph.js" defer></script>';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(pageTitle(mode, opts.title, site.title))}</title>
<script>try{const t=localStorage.getItem("docs-preview:theme");if(t)document.documentElement.dataset.theme=t}catch{}</script>
<style>${fontCss(Boolean(opts.publish))}${CSS}${mode === "edit" ? EDIT_CSS : ""}</style></head>
<body${mode === "edit" ? ' class="edit"' : ""}><nav id="sidebar"><div id="sidebar-resize" class="panel-resize" role="separator" tabindex="0" aria-orientation="vertical" aria-controls="sidebar" aria-label="Resize sidebar" data-i18n-aria-label="Resize sidebar" title="Resize sidebar" data-i18n-title="Resize sidebar"></div><div id="sidebar-head"><img id="site-icon" alt=""${site.icon ? ` src="${svgDataUri(site.icon)}"` : " hidden"}><div id="site-title" class="site-title" title="${siteTitle}">${siteTitle}</div><button id="sidebar-toggle" type="button" aria-controls="sidebar-content" aria-expanded="true" title="Close sidebar" data-i18n-title="Close sidebar">${SIDEBAR_ICON}</button></div><div id="sidebar-content"><div id="nav-groups">${nav}</div><div id="nav-status" role="status" aria-live="polite"></div></div>${dropzone}<div id="sidebar-foot"><button id="theme" class="nav-link" type="button"></button></div></nav>${main}${opts.aside ?? ""}
${bootScripts}${graphScript}
<script id="code-grammars" type="application/json">${JSON.stringify(site.codeGrammars ?? []).replace(/</g, "\\u003c")}</script>
${opts.publish ? `<script>${inlineScript(opts.publish.codeJs)}</script>` : '<script src="/assets/code.js" defer></script>'}
<script>
// Functions toString'd under tsx (esbuild keepNames) contain __name(...) calls; define a no-op.
var __name = (f) => f;
const contentLanguage = () => JSON.parse(document.getElementById("boot")?.textContent || "null")?.contentLanguage || ${JSON.stringify(site.contentLanguage ?? site.defaultLang)};
const localeFetch = (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, "x-docs-language": contentLanguage() } });
(${mountTerms.toString()})(document);
(${mountFigureFrames.toString()})(document);
(() => {
  const KEY = "docs-preview:theme";
  const btn = document.getElementById("theme");
  const labels = { "": "Auto", light: "Light", dark: "Dark" };
  const t = (key) => window.__docsTranslate ? window.__docsTranslate(key) : key;
  const icons = ${JSON.stringify(THEME_ICONS)};
  const apply = (v) => {
    if (v) { document.documentElement.dataset.theme = v; } else { delete document.documentElement.dataset.theme; }
    if (!btn) return;
    btn.innerHTML = icons[v || ""] + '<span class="nav-label">' + t('Theme') + ': ' + t(labels[v || ""]) + "</span>";
    btn.title = t("Theme") + ": " + t(labels[v || ""]);
  };
  let cur = "";
  try { cur = localStorage.getItem(KEY) || ""; } catch {}
  apply(cur);
  document.addEventListener("docs:ui-language", () => apply(cur));
  if (!btn) return;
  btn.addEventListener("click", () => {
    cur = cur === "" ? "light" : cur === "light" ? "dark" : "";
    try { cur ? localStorage.setItem(KEY, cur) : localStorage.removeItem(KEY); } catch {}
    apply(cur);
  });
})();
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
  let open = true;
  try { open = localStorage.getItem(KEY) !== "0"; } catch {}
  apply(open);
  toggle.addEventListener("click", () => {
    open = !open;
    try { localStorage.setItem(KEY, open ? "1" : "0"); } catch {}
    apply(open);
  });
})();
(${mountPanelResize.toString()})();
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
  //         manifest.yaml; no rollback logic).
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
    const rp = location.pathname.startsWith("/_resources") ? location.pathname.slice(12).replace(/^\\/|\\/$/g, "") : null;
    const res = await localeFetch("/api/nav?current=" + encodeURIComponent(id) + (rp == null ? "" : "&res=" + encodeURIComponent(decodeURIComponent(rp))));
    if (res.ok) document.getElementById("nav-groups").innerHTML = (await res.json()).html;
    if (window.__docsNavRestore) window.__docsNavRestore();
    document.dispatchEvent(new Event("docs:ui-refresh"));
  };
  const post = async (path, body) => {
    // Tell HMR, so the watch notification for our own write (manifest.yaml etc.) doesn't reload.
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
    const id = slot.closest(".nav-item").dataset.docId;
    try {
      const data = file ? btoa(Array.from(new Uint8Array(await file.arrayBuffer()), (byte) => String.fromCharCode(byte)).join("")) : null;
      await post("/api/icon", { file: id + ".md", data });
      setStatus("", false);
      await refresh();
    } catch (error) {
      setStatus(error.message, true);
    }
  };
  document.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.closest(".nav-doc-icon")) return;
    const file = input.files[0];
    input.value = "";
    if (file) void setIcon(input.closest(".nav-doc-icon"), file);
  });
  document.addEventListener("click", (event) => {
    const clear = event.target instanceof Element ? event.target.closest(".nav-icon-clear") : null;
    if (!clear) return;
    event.preventDefault();
    void setIcon(clear.closest(".nav-doc-icon"), null);
  });
  document.addEventListener("dragover", (event) => {
    const slot = event.target instanceof Element ? event.target.closest(".nav-doc-icon") : null;
    if (!slot || !event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    slot.classList.add("over");
  });
  document.addEventListener("dragleave", (event) => {
    const slot = event.target instanceof Element ? event.target.closest(".nav-doc-icon") : null;
    if (slot && !slot.contains(event.relatedTarget)) slot.classList.remove("over");
  });
  document.addEventListener("drop", (event) => {
    const slot = event.target instanceof Element ? event.target.closest(".nav-doc-icon") : null;
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

  // ── Uploading body assets (drop onto / click the dashed frame at the sidebar bottom) ──
  const zone = document.getElementById("dropzone");
  const zoneInput = document.getElementById("dropfile");
  const toBase64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  const register = async (files) => {
    if (files.length === 0) return;
    setStatus("Adding… (" + files.length + ")", false);
    const done = [];
    try {
      for (const f of files) done.push((await post("/api/figure", { name: f.name, data: await toBase64(f) })).file);
      setStatus("Added to figures/: " + done.join(", "), false);
    } catch (error) {
      setStatus((done.length ? "Partially added (" + done.join(", ") + ") / " : "") + "Failed to add: " + error.message, true);
    }
    await refresh();
  };
  if (zone && zoneInput) {
    zoneInput.addEventListener("change", () => { void register([...zoneInput.files]); zoneInput.value = ""; });
    zone.addEventListener("dragover", (e) => {
      if (!e.dataTransfer || !e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      zone.classList.add("over");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("over"));
    zone.addEventListener("drop", (e) => {
      zone.classList.remove("over");
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      void register([...e.dataTransfer.files]);
    });
  }

  // ── In-sidebar create form ──
  const slugify = (t) => t.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const closeForm = () => { for (const f of document.querySelectorAll(".nav-new-item")) f.remove(); };
  const openForm = (parent) => {
    closeForm();
    const host = parent
      ? document.querySelector('#nav-groups .nav-item[data-doc-id="' + CSS.escape(parent) + '"] > .nav-list')
      : document.querySelector("#nav-groups > .nav-list");
    if (!host) return;
    if (parent) {
      host.closest(".nav-item").classList.add("open");
    }
    const item = document.createElement("div");
    item.className = "nav-item nav-new-item";
    const form = document.createElement("form");
    form.className = "nav-row nav-new";
    form.innerHTML =
      (parent ? "" : ${JSON.stringify(DOCS_ICON)}) +
      '<input name="title" placeholder="title" data-i18n-placeholder="title" required autocomplete="off">' +
      '<div class="nav-new-id">/<input name="id" placeholder="id" required autocomplete="off" spellcheck="false">' +
      '<button class="nav-new-go" type="submit" title="Create" data-i18n-title="Create" aria-label="Create" data-i18n-aria-label="Create">↵</button></div>' +
      '<div class="err"></div>';
    item.append(form);
    host.append(item);
    document.dispatchEvent(new Event("docs:ui-refresh"));
    const title = form.elements.namedItem("title");
    const idInput = form.elements.namedItem("id");
    const err = form.querySelector(".err");
    // id follows the title until edited by hand (empty for non-alphanumeric titles = type it).
    let idTouched = false;
    title.addEventListener("input", () => { if (!idTouched) idInput.value = slugify(title.value); });
    idInput.addEventListener("input", () => { idTouched = true; });
    form.addEventListener("keydown", (e) => { if (e.key === "Escape") closeForm(); });
    // Close when focus moves out with nothing typed (keep partially filled forms).
    // (remove itself fires focusout, so defer one tick and close only if still there)
    form.addEventListener("focusout", (e) => {
      if (form.contains(e.relatedTarget) || title.value.trim() || idInput.value.trim()) return;
      setTimeout(() => { if (item.isConnected && !item.contains(document.activeElement)) item.remove(); }, 0);
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      try {
        const data = await post("/api/create", { parent: parent || undefined, id: idInput.value.trim(), title: title.value.trim() });
        if (window.__docsNavigate) await window.__docsNavigate(data.path);
        else window.location.href = data.path + "?lang=" + encodeURIComponent(contentLanguage());
      } catch (error) {
        err.textContent = error.message;
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
${opts.publish ? `${opts.publish.pages}<script>${publishRouterScript(opts.publish.first)}</script>` : `<script>${hmrClientScript(mode)}</script>`}</body></html>`;
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
    main.innerHTML = page.innerHTML;
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
    if (target) target.scrollIntoView(); else window.scrollTo(0, 0);
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
): string => {
    const pages = site.entries.map((e) => ({
        route: docPath(site.entries, e.id).slice(1),
        title: docDisplayName(e.frontmatter, e.id),
        main: entryMain(site, e),
    }));
    const first = pages[0]?.route ?? "";
    if (site.ctx.terms.length > 0) {
        const terms = resourcesMain(site, "terms");
        if (terms) pages.push({ route: "_resources/terms", ...terms });
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
                publish: { graphJs, codeJs, pages: templates, first },
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
    siteTitle?: string;
    siteIcon?: string;
    contentLanguage?: string;
    sourceLanguage?: string;
    docLanguage?: string;
    translatedLanguages?: string[];
    /** `<id>.md` (the save API's key). */
    file: string;
    /** Resolution key for URLs / doc: links. */
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
): string => {
    const existing = new Set(translatedLanguages);
    const options = [...contentLanguages]
        .sort((a, b) => Number(existing.has(b.code)) - Number(existing.has(a.code)))
        .map(
            ({ code, name }) =>
                `<option value="${code}" data-name="${escapeHtml(name)}" data-added="${existing.has(code)}"${code === language ? " selected" : ""}>${escapeHtml(name)} (${code})</option>`,
        )
        .join("");
    return `<div class="fm-language"><select id="fm-lang" data-source="${contentLanguageCode(defaultLang)}" aria-label="Change language" data-i18n-aria-label="Change language">${options}</select></div>`;
};

// The same thing is passed for the initial render (editorAside) and doc switch (`/api/page`)
// (= the client only has to handle one boot shape, initially and after a switch).
export const editorBoot = (entry: Entry, site: Site): EditorBoot => {
    // Completion candidates are figures/-relative files, as written in :::figure( / :::html(.
    const figures = [...site.ctx.figures.values()].map((f) => f.file.replace(/^figures\//, ""));
    const docs = site.entries.map((e) => ({
        ref: e.id,
        title: docDisplayName(e.frontmatter, e.id),
    }));
    return {
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
    };
};

// Language and editor actions stay in the header; document actions live in the tree.
const editorAside = (entry: Entry, site: Site): { aside: string; boot: EditorBoot } => {
    const aside = `<aside id="panel"><div id="resize" class="panel-resize" role="separator" tabindex="0" aria-orientation="vertical" aria-controls="panel" aria-label="Resize editor" data-i18n-aria-label="Resize editor" title="Resize editor" data-i18n-title="Resize editor"></div>
<div id="phead">
${languageFieldHtml(site.defaultLang, site.contentLanguage, entry.translatedLanguages)}
<span id="status"></span>
<span id="preview-status" role="status" data-state="valid" aria-label="Preview is up to date" data-i18n-aria-label="Preview is up to date" title="Preview is up to date"><span data-preview-icon="valid">${icon('<path d="m4 10 4 4 8-8"/>')}</span><span data-preview-icon="error">${icon('<circle cx="10" cy="10" r="7"/><path d="M10 5v6m0 3h.01"/>')}</span><span data-preview-icon="loading">${icon('<path d="M17 10a7 7 0 1 1-7-7"/>')}</span></span>
<button id="validate" class="pbtn" type="button" title="Validate and apply" data-i18n-title="Validate and apply" aria-label="Validate and apply" data-i18n-aria-label="Validate and apply">${icon('<path d="M5 5l-4 5 4 5M15 5l4 5-4 5M7 10l2 2 4-5"/>')}</button>
<button id="save" class="pbtn" data-state="saved" type="button" title="Save (Ctrl+S)" data-i18n-title="Save (Ctrl+S)" aria-label="Save" data-i18n-aria-label="Save">${icon('<path d="M3 3h11l3 3v11H3z"/><path d="M6 3v5h7V3M6 17v-6h8v6"/>')}</button>
<button id="split-preview" class="pbtn" type="button" aria-pressed="false" aria-label="Split view" data-i18n-aria-label="Split view" title="Split view" data-i18n-title="Split view">${icon('<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M10 3v14"/>')}</button>
<div id="gear"><button class="pbtn" type="button" aria-haspopup="true" aria-label="View settings" data-i18n-aria-label="View settings" title="View settings" data-i18n-title="View settings">${GEAR_ICON}</button><div id="gearmenu">
<div id="language-setting"><select id="ui-language" aria-label="Editor language" data-i18n-aria-label="Language"><option value="eng">English</option><option value="jpn">日本語</option><option value="zho">中文</option></select></div>
<label><input type="checkbox" id="opt-autovalidate"><span data-i18n="Auto validate">Auto validate</span></label>
<label><input type="checkbox" id="opt-autosave"><span data-i18n="Auto save">Auto save</span></label>
<label><input type="checkbox" id="opt-corr"><span data-i18n="Source mapping">Source mapping</span></label>
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
 * Non-doc routes (unknown) → 404 — the caller falls back to normal navigation.
 */
export const pageDataResponse = (site: Site, path: unknown): { status: number; body: unknown } => {
    if (typeof path !== "string" || !path.startsWith("/")) {
        return { status: 400, body: { error: "route must be /<docId>" } };
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
        },
    };
};

const readJson = async (req: IncomingMessage): Promise<Record<string, unknown> | undefined> => {
    try {
        const v: unknown = JSON.parse(await readBody(req));
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

const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
        let data = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
            data += chunk;
            if (data.length > 5_000_000) {
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
            const catalog = readCatalog(root, locale);
            const { lang: _lang, ...fields } = fm;
            catalog[target.id] = { ...fields, body: text.replace(/\n+$/, "") + (text ? "\n" : "") };
            writeCatalog(root, locale, catalog);
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
    const tag = typeof lang === "string" && isLangTag(lang) ? lang : siteLanguages.defaultLang;
    const { lint } = resolveLanguage(tag, siteLanguages.languages);
    const findings = lint ? await lint(typeof body === "string" ? body : "") : [];
    sendJson(res, 200, { findings });
};

// Create a new doc (sidebar create form). The client navigates to the id in the response.
const handleCreate = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJson(req);
    const id = typeof body?.id === "string" ? body.id.trim() : "";
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const parent = typeof body?.parent === "string" && body.parent !== "" ? body.parent : undefined;
    const result = ops.add(id, title, parent);
    sendOp(
        res,
        isOpError(result) ? result : { ...result, path: docPath(loadSite().entries, result.id) },
    );
};

// Add a figure (sidebar file picker / drag-and-drop). Returns the written file name
// (the client inserts :::figure(<file>)).
const handleFigure = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJson(req);
    if (typeof body?.name !== "string" || typeof body?.data !== "string") {
        sendJson(res, 400, { error: "specify an svg / png / webp / jpeg / html file" });
        return;
    }
    sendOp(res, ops.addFigure(body.name, Buffer.from(body.data, "base64")));
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
    const path = join(iconsDir, `${target.id}.svg`);
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
    mkdirSync(iconsDir, { recursive: true });
    writeFileSync(path, svg);
    sendJson(res, 200, { ok: true, icon: svgDataUri(svg) });
};

// Sidebar DnD move (reorder + reparent). Rewrites only manifest.yaml (file / id unchanged).
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

// Change a doc id (= file name = resolution key for URLs / doc: links); doc: links follow.
const handleRename = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJson(req);
    const target = resolveContentFile(body?.file);
    if (!target) {
        sendJson(res, 404, { error: "target doc not found" });
        return;
    }
    const newId = typeof body?.newId === "string" ? body.newId.trim() : "";
    const result = ops.rename(target.id, newId);
    sendOp(
        res,
        isOpError(result) ? result : { ...result, path: docPath(loadSite().entries, result.id) },
    );
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
const fromDist = import.meta.url.endsWith(".js");

/** Client bundle (src/<entry> as an IIFE). Sourcemap for the server, minified for publish. */
export const bundleClient = async (entry: string, publish = false): Promise<string> => {
    const prebuilt = PREBUILT[entry];
    if (fromDist && prebuilt) {
        return readFileSync(join(pkgRoot, "dist", prebuilt), "utf8");
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

export const startServer = async (mode: ServeMode, port = 5179): Promise<void> => {
    // docs.config.mjs (default language / extra adapters) is read once; restart after editing it.
    siteLanguages = await loadSiteLanguages(root);
    compiler = createCompiler(root, { defaultLang: siteLanguages.defaultLang });
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
        const requestUrl = new URL(req.url ?? "/", "http://localhost");
        const requestedLanguage =
            req.headers["x-docs-language"] ??
            requestUrl.searchParams.get("lang") ??
            contentLanguageCode(siteLanguages.defaultLang);
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
                    : mode === "edit" && path === "/assets/ui.js"
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
                if (input?.action === "validate") {
                    try {
                        if (
                            typeof input.file !== "string" ||
                            typeof input.content !== "string" ||
                            isRemoteTextfile(input.file)
                        )
                            throw new Error("Invalid text file tool request");
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
                        sendJson(
                            res,
                            200,
                            await validateTextfileCode(root, language, input.content),
                        );
                    } catch (error) {
                        sendJson(res, 400, {
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                    return;
                }
                const result = textfileResponse(root, input);
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
                        contentLanguageCode(siteLanguages.defaultLang),
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

        if (
            (mode === "edit" && (path === "/_resources" || path.startsWith("/_resources/"))) ||
            path === "/_resources/terms"
        ) {
            const rest = path.slice("/_resources".length).replace(/^\/|\/$/g, "");
            const page = resourcesMain(site, rest);
            if (!page) {
                notFound(res, path);
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
};
