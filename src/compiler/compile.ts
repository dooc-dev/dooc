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
import type { ArtifactDoc, DocsArtifact, FigureEntry } from "../core/artifact-types.js";
import type { Block, TocEntry } from "../core/blocks.js";
import { docIdOfFile, flattenTree, MANIFEST_FILE } from "../core/content-metadata.js";
import { validateDocsArtifact } from "../core/docs-json-schema.js";
import { GENERATION } from "../core/generation.js";
import { DEFAULT_LANG } from "../core/language.js";
import { DOC_LINK_SCHEME, type DocRef, parseDocLink } from "../core/routing.js";
import type { Frontmatter } from "../core/taxonomy.js";
import { collectRefs, type ParsedDoc, parseDoc } from "./dialect.js";
import { figureName, loadFigures } from "./figures.js";
import { createFileCache, createSigCache, dirSig } from "./file-cache.js";
import { toBlocks } from "./from-mdast.js";
import { loadIcons, squareSvg } from "./icons.js";
import { contentLanguageCode, isContentLanguage } from "./language-codes.js";
import { readCatalog } from "./locales.js";
import { parseManifestText } from "./manifest.js";
import { assembleDoc } from "./serialize.js";
import { collectTerms, type TermSource } from "./terms.js";
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

// On a doc id rename, makes doc: links in other docs' body text follow it (used by serve.ts's
// /api/rename). `parseDocLink` compares docIds exactly, so it doesn't misfire when oldId is a
// prefix of another id (e.g. "api" and "api-v2"). Only the matching URL part is rewritten; the
// label is left as-is.
export const rewriteDocLinks = (body: string, oldId: string, newId: string): string =>
    body.replace(DOC_LINK_RE, (whole, url: string) =>
        parseDocLink(url) === oldId ? whole.replace(url, `${DOC_LINK_SCHEME}${newId}`) : whole,
    );

/** Extra info for editing (not distributed = not put in docs.json). key = ArtifactDoc.file. */
export interface DocSource {
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
    /** Site default language (BCP 47; docs.config.mjs `defaultLang`). Default: DEFAULT_LANG. */
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
    /** Docs root used to resolve :::textfile paths. */
    root?: string;
    /** Unsaved local file contents, used only for draft previews. */
    textfiles?: ReadonlyMap<string, string>;
    /** file = ArtifactDoc.file (`content/<id>.md`); used to look up a draft's id / parent. */
    docs: readonly (DocRef & { file: string })[];
    /** name → figure (file = `figures/<file>`). */
    figures: { get(name: string): { file: string } | undefined };
    /** Site default language for a draft without front-matter `lang`. Default: DEFAULT_LANG. */
    defaultLang?: string;
    termSources?: readonly TermSource[];
}

interface ParsedFile {
    raw: string;
    parsed: ParsedDoc;
    blocks: Block[];
    toc: TocEntry[];
    lines: number[];
    refs: ArtifactDoc["refs"];
    /** Files referenced by :::figure / :::html (relative to figures/). */
    figureFiles: string[];
}

// Maps mdast line numbers (1-indexed in raw, which includes front-matter) to the body-relative
// lines the editor shows. body is a suffix of raw (parseDoc only strips the front-matter), so
// subtract the number of newlines before it.
const toBodyLines = (raw: string, body: string, lines: number[]): number[] => {
    const before = raw.slice(0, raw.length - body.length).split("\n").length - 1;
    return lines.map((l) => Math.max(1, l - before));
};

const parseFile = (raw: string): ParsedFile => {
    const parsed = parseDoc(raw);
    const { blocks, toc, lines } = toBlocks(parsed.root, parsed.source);
    const refs = collectRefs(parsed.root);
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

const resolveTextfiles = (
    f: ParsedFile,
    root?: string,
    textfiles?: ReadonlyMap<string, string>,
): ParsedFile => {
    if (!f.blocks.some((b) => b.type === "code" && b.filename)) return f;
    const errors = [...f.parsed.errors];
    const blocks = f.blocks.map((b): Block => {
        if (b.type !== "code" || !b.filename) return b;
        try {
            if (!root) throw new Error("docs root is required to read text files");
            return {
                ...b,
                lines: selectTextfileRange(
                    textfiles?.get(b.filename.replace(/^(\.\/)+/, "")) ??
                        readTextfile(root, b.filename),
                    b.range,
                ).split("\n"),
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
                `:::textfile(${b.filename})${b.range ?? ""}: ${error instanceof Error ? error.message : error}`,
            );
            return b;
        }
    });
    return { ...f, blocks, parsed: { ...f.parsed, errors } };
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

// Validates a single doc: dialect errors, :::figure / :::html targets exist, doc: links resolve.
const docErrors = (
    file: string,
    f: ParsedFile,
    { docs, figures, termSources = [] }: DraftContext,
): string[] => {
    const errors = [...f.parsed.errors];
    const terms = collectTerms([
        ...termSources.filter((source) => source.file !== file),
        { file, entries: f.parsed.terms },
    ]);
    errors.push(...terms.errors);
    for (const id of f.refs.terms)
        if (!terms.entries.some((term) => term.id === id))
            errors.push(`:::term(${id}) is unresolved (check the term ID)`);
    for (const file of f.figureFiles) {
        if (figures.get(figureName(file))?.file !== `figures/${file}`) {
            errors.push(`"${file}" is not in figures/`);
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

export const createCompiler = (root: string, options: CompileOptions = {}): Compiler => {
    if (options.locale && !isContentLanguage(options.locale))
        throw new Error("Expected an ISO 639-3 language code");
    const defaultLang = options.defaultLang ?? DEFAULT_LANG;
    const contentDir = join(root, "content");
    const figuresDir = join(root, "figures");
    const docCache = createFileCache<ParsedFile>();
    const manifestCache = createFileCache<ReturnType<typeof parseManifestText>>();
    const figuresCache = createSigCache<ReturnType<typeof loadFigures>>();

    const compile = (): Compiled => {
        const { figures, errors: figErrors } = figuresCache.get(dirSig(figuresDir), () =>
            loadFigures(figuresDir),
        );
        const siteErrors: string[] = [...figErrors];
        let catalog: ReturnType<typeof readCatalog> = {};
        if (options.locale && options.locale !== contentLanguageCode(defaultLang)) {
            try {
                catalog = readCatalog(root, options.locale);
            } catch (error) {
                siteErrors.push(String(error));
            }
        }
        let title: string | undefined;
        let icon: string | undefined;
        let iconFile: string | undefined;
        const files: { doc: ArtifactDoc; parsed: ParsedFile }[] = [];
        if (!existsSync(contentDir)) {
            siteErrors.push(`${contentDir}: content/ is missing`);
        } else {
            const manifestPath = join(root, MANIFEST_FILE);
            const {
                tree,
                title: manifestTitle,
                icon: manifestIcon,
                errors: manifestErrors,
            } = existsSync(manifestPath)
                ? manifestCache.get(manifestPath, parseManifestText)
                : { tree: [], errors: [`${MANIFEST_FILE} is required`] };
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
            for (const entry of readdirSync(contentDir, { withFileTypes: true })) {
                if (entry.name.startsWith(".")) {
                    continue;
                }
                const id = entry.isFile() ? docIdOfFile(entry.name) : undefined;
                if (id == null) {
                    siteErrors.push(
                        `content/${entry.name}: only <id>.md (lowercase alphanumerics and hyphens) are allowed directly under content/`,
                    );
                    continue;
                }
                onDisk.add(id);
            }
            // Manifest pre-order = artifact order = display order.
            for (const { id, parent } of flattenTree(tree)) {
                const rel = `content/${id}.md`;
                if (!onDisk.delete(id)) {
                    siteErrors.push(`${rel}: listed in ${MANIFEST_FILE} but the file is missing`);
                    continue;
                }
                let parsed = docCache.get(join(contentDir, `${id}.md`), (raw) => parseFile(raw));
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
                    );
                }
                parsed = resolveTextfiles(parsed, root);
                files.push({ doc: toDoc(id, parent, rel, parsed, defaultLang), parsed });
            }
            for (const id of onDisk) {
                siteErrors.push(`content/${id}.md: not registered in ${MANIFEST_FILE}`);
            }
        }

        // Icons are small, so read them every time (no cache).
        const { icons, errors: iconErrors } = loadIcons(
            root,
            new Set(files.map((f) => f.doc.id)),
            iconFile,
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
        const terms = collectTerms(
            files.map(({ doc, parsed }) => ({ file: doc.file, entries: parsed.parsed.terms })),
        );
        siteErrors.push(...terms.errors);

        const artifact: DocsArtifact = {
            generation: GENERATION,
            ...(title === undefined ? {} : { title }),
            ...(icon === undefined ? {} : { icon }),
            docs,
            terms: terms.entries,
            figures: figures.map(({ markup: _markup, ...index }) => index),
        };
        siteErrors.push(...validateDocsArtifact(artifact));

        const ctx: DraftContext = {
            docs,
            figures: new Map(figures.map((f) => [f.name, f])),
            defaultLang,
            termSources: files.map(({ doc, parsed }) => ({
                file: doc.file,
                entries: parsed.parsed.terms,
            })),
        };
        const sources = new Map<string, DocSource>();
        const errors = [...siteErrors];
        for (const { doc, parsed } of files) {
            const errs = docErrors(doc.file, parsed, ctx);
            errors.push(...errs.map((e) => `${doc.file}: ${e}`));
            sources.set(doc.file, {
                raw: parsed.raw,
                frontmatter: parsed.parsed.frontmatter,
                lines: parsed.lines,
                errors: errs,
            });
        }
        return {
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
    const parsed = resolveTextfiles(parseFile(raw), ctx.root, ctx.textfiles);
    return {
        doc: toDoc(known?.id ?? "", known?.parent, file, parsed, ctx.defaultLang ?? DEFAULT_LANG),
        source: {
            raw,
            frontmatter: parsed.parsed.frontmatter,
            lines: parsed.lines,
            errors: docErrors(file, parsed, ctx),
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
