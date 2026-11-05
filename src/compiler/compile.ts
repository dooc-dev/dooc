// The compiler core: reads and validates the docs root's layout convention
// (content/<id>.md + manifest.yaml, figures/) and builds the DocsArtifact
// (= docs.json). The viewer uses it incrementally via createCompiler; build uses it once via
// compileSite + writeArtifact. Nothing is distributed if there is even one validation error.
// Output:
//   artifact/docs.json           = DocsArtifact (body Block AST + toc + terms +
//                                  figure index, generation stamp)
//   artifact/figures/<name>.json = FigureEntry (with markup, lazy-fetched by consumers)
// routing.ts is the SoT for URL / id resolution, inline.ts for inline splitting.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactDoc, DocsArtifact, FigureEntry, TermEntry } from "../core/artifact-types.js";
import type { Block, TocEntry } from "../core/blocks.js";
import { docIdOfFile, flattenTree, MANIFEST_FILE } from "../core/content-metadata.js";
import { validateDocsArtifact } from "../core/docs-json-schema.js";
import { GENERATION } from "../core/generation.js";
import { termMap } from "../core/inline.js";
import { DEFAULT_LANG } from "../core/language.js";
import { defaultPreviewSettings, type PreviewSettings } from "../core/previewers.js";
import { DOC_LINK_SCHEME, type DocRef, parseDocLink } from "../core/routing.js";
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
import { contentLanguageCode, isContentLanguage } from "./language-codes.js";
import { readCatalog } from "./locales.js";
import { parseManifestText, readManifest } from "./manifest.js";
import { assembleDoc } from "./serialize.js";
import { parseTermSource } from "./terms.js";
import { readTextfile, selectTextfileRange } from "./textfile.js";
import { TextfileUnavailable } from "./textfile-remote.js";

export type {
    ArtifactDoc,
    DocsArtifact,
    FigureEntry,
} from "../core/artifact-types.js";

// Collects doc: links (`[label](doc:<docId>)`) in body text; they are checked for resolution
// after all docs are loaded. (serve.ts's validation of edit drafts uses the same collection.)
const DOC_LINK_RE = /\[[^\]]*\]\((doc:[^)]*)\)/g;
export const collectDocLinks = (body: string): string[] =>
    [...body.matchAll(DOC_LINK_RE)]
        .map((m) => m[1] ?? "")
        .filter((u) => u.startsWith(DOC_LINK_SCHEME));

// On a doc id rename, makes doc: links in other docs' body text follow it (used by CLI / MCP).
// `parseDocLink` compares docIds exactly, so it doesn't misfire when oldId is a
// prefix of another id (e.g. "api" and "api-v2"). Only the matching URL part is rewritten; the
// label is left as-is.
export const rewriteDocLinks = (body: string, oldId: string, newId: string): string =>
    body.replace(DOC_LINK_RE, (whole, url: string) =>
        parseDocLink(url) === oldId ? whole.replace(url, `${DOC_LINK_SCHEME}${newId}`) : whole,
    );

/** Extra info for editing (not distributed = not put in docs.json). key = ArtifactDoc.file. */
export interface DocSource {
    terms: TermEntry[];
    /**
     * Raw text on disk (including front-matter). The editor's initial value and the base for
     * detecting external changes.
     */
    raw: string;
    /** Validated front-matter; undefined if broken (ArtifactDoc then uses the id as title). */
    frontmatter: Frontmatter | undefined;
    /**
     * For the editor's source-mapping display: each block's start line, relative to the body
     * (same index as ArtifactDoc.blocks).
     */
    lines: number[];
    /**
     * This doc's validation errors (dialect + resolution of figures/doc: links).
     * No file prefix.
     */
    errors: string[];
}

export interface Compiled {
    previews: PreviewSettings;
    /** Built even with errors (for the viewer). Distribute only when errors.length === 0. */
    artifact: DocsArtifact;
    figures: FigureEntry[];
    sources: Map<string, DocSource>;
    /** Errors not tied to a doc (layout convention / manifest / figures / terms). */
    siteErrors: string[];
    /** All errors (siteErrors + each doc's errors with a file prefix). */
    errors: string[];
    /** Site default language (docs without front-matter `lang` resolve to it). */
    defaultLang: string;
}

export interface CompileOptions {
    /** Selected content language; translations live in locales/<locale>.json. */
    locale?: string;
    /** Override manifest.yaml's defaultLang for programmatic compilation. */
    defaultLang?: string;
}

export interface Compiler {
    /**
     * Compiles the whole docs root (content/ figures/). Unchanged files hit the
     * cache.
     */
    compile(): Compiled;
}

/** Site context needed to check a draft's references (doc: link targets / figures). */
export interface DraftContext {
    previews?: PreviewSettings;
    /** Docs root used to resolve embedded file paths. */
    root?: string;
    /** Unsaved local file contents, used only for draft previews. */
    textfiles?: ReadonlyMap<string, string>;
    /** file = ArtifactDoc.file (`content/<id>.md`); used to look up a draft's id / parent. */
    docs: readonly (DocRef & { file: string })[];
    /** name → figure (file = `figures/<file>`). */
    figures: { get(name: string): { file: string } | undefined };
    /** Site default language for a draft without front-matter `lang`. Default: DEFAULT_LANG. */
    defaultLang?: string;
}

interface ParsedFile {
    raw: string;
    parsed: ParsedDoc;
    blocks: Block[];
    toc: TocEntry[];
    lines: number[];
    refs: ArtifactDoc["refs"];
    /** Visual assets referenced by Markdown embeds (relative to figures/). */
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
        parsed,
        blocks,
        toc,
        lines: toBodyLines(raw, parsed.body, lines),
        refs: { figures: figureFiles.map(figureName), terms: refs.terms },
        figureFiles,
    };
};

const resolveFiles = (
    f: ParsedFile,
    root?: string,
    textfiles?: ReadonlyMap<string, string>,
): ParsedFile => {
    if (!f.refs.terms.length && !f.blocks.some((b) => b.type === "code" && b.filename)) return f;
    const errors = [...f.parsed.errors];
    const terms = [...f.parsed.terms];
    const blocks = f.blocks.map((b): Block => {
        if (b.type !== "code" || !b.filename) return b;
        try {
            if (!root) throw new Error("docs root is required to read text files");
            const source = selectTextfileRange(
                textfiles?.get(b.filename.replace(/^(\.\/)+/, "")) ??
                    readTextfile(root, b.filename),
                b.range,
            );
            const parsed =
                b.range === undefined && !isRemoteTextfile(b.filename)
                    ? parseContentSource(
                          b.lang ?? "",
                          source,
                          b.filename.replace(/^(\.\/)+/, ""),
                          b.alt,
                      )
                    : undefined;
            if (parsed) {
                errors.push(
                    ...parsed.errors.map(
                        (error) => `${b.filename}: L${error.line + 1}: ${error.message}`,
                    ),
                );
                for (const block of parsed.blocks)
                    if (block.type === "term") terms.push(block.entry);
                if (parsed.blocks[0]) return parsed.blocks[0];
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
    });
    for (const file of f.refs.terms) {
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
        refs: {
            ...f.refs,
            terms: [
                ...new Set([
                    ...f.refs.terms,
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
): ArtifactDoc => ({
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
    for (const url of collectDocLinks(f.parsed.body)) {
        const id = parseDocLink(url);
        if (!id) {
            errors.push(`doc: link "${url}" is invalid (doc:<docId>)`);
            continue;
        }
        if (!docs.some((d) => d.id === id)) {
            errors.push(`doc: link "${url}" is unresolved (check the docId)`);
        }
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
        const visualFiles = projectFiles(root)
            .map((file) => file.path)
            .filter((file) => /\.(svg|html|png|webp|jpe?g)$/.test(file));
        const { figures, errors: figErrors } = figuresCache.get(
            dirSig(figuresDir) +
                visualFiles.map((file) => `${file}:${fileSig(textfilePath(root, file))}`).join("|"),
            () => loadFigures(figuresDir, visualFiles),
        );
        const siteErrors: string[] = figErrors.filter((error) => error.startsWith("figures/"));
        let catalog: ReturnType<typeof readCatalog> = {};
        if (options.locale && options.locale !== contentLanguageCode(defaultLang)) {
            try {
                catalog = readCatalog(root, options.locale);
            } catch (error) {
                siteErrors.push(String(error));
            }
        }
        let previews = defaultPreviewSettings();
        let title: string | undefined;
        let icon: string | undefined;
        let iconFile: string | undefined;
        const files: { doc: ArtifactDoc; parsed: ParsedFile }[] = [];
        if (!existsSync(contentDir) && !manifest.files) {
            siteErrors.push(`${contentDir}: content/ is missing`);
        } else {
            const {
                tree,
                title: manifestTitle,
                icon: manifestIcon,
                previews: manifestPreviews,
                errors: manifestErrors,
            } = manifest;
            previews = manifestPreviews ?? defaultPreviewSettings();
            const nextPreviewKey = JSON.stringify(previews);
            if (nextPreviewKey !== previewKey) {
                docCache = createFileCache<ParsedFile>();
                previewKey = nextPreviewKey;
            }
            title = manifestTitle;
            iconFile = manifestIcon;
            if (iconFile) {
                try {
                    icon = squareSvg(readTextfile(root, iconFile));
                    if (!icon)
                        throw new Error("expected an SVG with a viewBox or width and height");
                } catch (error) {
                    siteErrors.push(
                        `${MANIFEST_FILE}: icon ${iconFile}: ${error instanceof Error ? error.message : error}`,
                    );
                }
            }
            siteErrors.push(...manifestErrors);
            // Directly under content/: flat <id>.md files only (no folders).
            const onDisk = new Set<string>();
            for (const entry of existsSync(contentDir)
                ? readdirSync(contentDir, { withFileTypes: true })
                : []) {
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
            // Manifest pre-order = artifact order = display order.
            for (const { id, parent } of flattenTree(tree)) {
                const rel = docFile(id, manifest.files);
                if (rel.startsWith("content/")) {
                    const diskId = docIdOfFile(rel.slice("content/".length));
                    if (diskId) onDisk.delete(diskId);
                }
                let path: string;
                try {
                    path = textfilePath(root, rel);
                } catch (error) {
                    siteErrors.push(`${rel}: ${error}`);
                    continue;
                }
                if (!existsSync(path)) {
                    siteErrors.push(`${rel}: listed in ${MANIFEST_FILE} but the file is missing`);
                    continue;
                }
                let parsed = docCache.get(path, (raw) => parseFile(raw, previews, rel));
                if (options.locale && options.locale !== contentLanguageCode(defaultLang)) {
                    const translation = Object.hasOwn(catalog, id) ? catalog[id] : undefined;
                    parsed = parseFile(
                        assembleDoc(
                            {
                                ...(translation ?? parsed.parsed.frontmatter ?? { title: id }),
                                lang: options.locale,
                            },
                            translation?.body ?? parsed.parsed.body,
                        ),
                        previews,
                        rel,
                    );
                }
                parsed = resolveFiles(parsed, root);
                files.push({ doc: toDoc(id, parent, rel, parsed, defaultLang), parsed });
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
        );
        siteErrors.push(...iconErrors);
        for (const { doc } of files) {
            const icon = icons.get(doc.id);
            if (icon != null) {
                doc.icon = icon;
            }
        }
        const docs = files.map((f) => f.doc);
        if (docs.length === 0) {
            siteErrors.push(`${contentDir}: no docs`);
        }

        const artifact: DocsArtifact = {
            generation: GENERATION,
            ...(title === undefined ? {} : { title }),
            ...(icon === undefined ? {} : { icon }),
            docs,
            terms: [...termMap(files.flatMap(({ parsed }) => parsed.parsed.terms)).values()],
            figures: figures.map(({ markup: _markup, ...index }) => index),
        };
        siteErrors.push(...validateDocsArtifact(artifact));

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
                raw: parsed.raw,
                frontmatter: parsed.parsed.frontmatter,
                lines: parsed.lines,
                errors: errs,
            });
        }
        return {
            previews,
            artifact,
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
): { doc: ArtifactDoc; source: DocSource } => {
    const known = ctx.docs.find((d) => d.file === file);
    const previews = ctx.previews ?? (ctx.root ? readManifest(ctx.root).previews : undefined);
    const parsed = resolveFiles(parseFile(raw, previews, file), ctx.root, ctx.textfiles);
    return {
        doc: toDoc(known?.id ?? "", known?.parent, file, parsed, ctx.defaultLang ?? DEFAULT_LANG),
        source: {
            terms: parsed.parsed.terms,
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

/** Writes artifact/ (docs.json + figures/*.json); skipped on errors. */
export const writeArtifact = (compiled: Compiled, out: string): boolean => {
    if (compiled.errors.length > 0 || validateDocsArtifact(compiled.artifact).length > 0) {
        return false;
    }
    rmSync(out, { recursive: true, force: true });
    mkdirSync(join(out, "figures"), { recursive: true });
    writeFileSync(join(out, "docs.json"), JSON.stringify(compiled.artifact));
    for (const fig of compiled.figures) {
        writeFileSync(join(out, "figures", `${fig.name}.json`), JSON.stringify(fig));
    }
    return true;
};
