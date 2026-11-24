import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PluginTransport } from "../../../plugins/src/transport.js";
import { embedBundleUrls } from "../../engine/src/compiler/bundle-urls.js";
import { compileSite } from "../../engine/src/compiler/compile.js";
import { exportEntries } from "../../engine/src/compiler/export.js";
import { filesSnapshot } from "../../engine/src/compiler/files.js";
import { loadProjectFonts } from "../../engine/src/compiler/fonts.js";
import { manifestFile, projectRoot, readManifest } from "../../engine/src/compiler/manifest.js";
import { prepareStoredVersion } from "../../engine/src/compiler/stored-versions.js";
import { textfilePath } from "../../engine/src/compiler/textfile.js";
import { versionInput } from "../../engine/src/compiler/version-input.js";
import { zip } from "../../engine/src/compiler/zip.js";
import { walkBlocks } from "../../engine/src/core/blocks.js";
import { selectCodeGrammars } from "../../engine/src/core/code-grammars.js";
import { parseVersionConfig } from "../../engine/src/core/document-version.js";
import { type PreviewSettings, parsePreviewSettings } from "../../engine/src/core/previewers.js";
import type { PublishOutput } from "../../frontend/src/document-application.js";
import { loadBuildPlugins, pluginSnapshot } from "./build-plugins.js";
import { buildSize, checkBuildSize, type SplitBuildOptions, splitBuild } from "./build-split.js";
import { createDocumentVersions } from "./document-versions.js";
import { loadSiteLanguages } from "./languages.js";
import { loadReaderPlugins } from "./plugin-config.js";
import { prepareDocumentSources } from "./remote-manifests.js";
import { gitHeadFile, sourceFileBase } from "./workspace.js";

export interface BuildOptions extends SplitBuildOptions {
    format: "html" | "zip";
    urlPreview?: "embed" | "network";
    mode?: "static" | "live";
    auth?: "external";
    /** Public directory URL corresponding to the manifest directory, embedded in HTML. */
    sourceUrl?: string;
    download?: "easy" | "normal" | "block";
    /** Trusted server module used for static snapshots, never serialized into HTML. */
    pluginModule?: string;
    /** Build-time authenticated reads; live HTML receives its transport at runtime. */
    pluginTransport?: PluginTransport;
    previews?: PreviewSettings;
}

export interface BuildResult {
    data: string | Buffer;
    /** Additional files relative to the HTML entry point's directory. */
    files?: ReadonlyMap<string, Buffer>;
    /** Actual bytes of the entry point and its unique output files. */
    bytes?: number;
    docs: number;
    warnings?: string[];
    version?: string;
    revision?: string;
    commitVersion?: () => void;
}

export { writeBuildOutput } from "./build-output.js";

/** Build one artifact from the manifest and its managed content. */
export const buildBundle = async (root: string, options: BuildOptions): Promise<BuildResult> => {
    const format = options.format;
    for (const key of ["split", "compress", "warningsAsErrors"] as const)
        if (options[key] !== undefined && typeof options[key] !== "boolean")
            throw new Error(`${key} must be a boolean`);
    const maxFileSize = buildSize(options.maxFileSize, "--max-file-size");
    const maxBuildSize = buildSize(options.maxBuildSize, "--max-build-size");
    const split = !!(options.split || options.compress || maxFileSize || maxBuildSize);
    if (split && format !== "html")
        throw new Error("Split builds, compression and size limits apply to HTML only");
    if (options.download !== undefined && !["easy", "normal", "block"].includes(options.download))
        throw new Error("download must be easy | normal | block");
    if (options.download !== undefined && format !== "html")
        throw new Error("Download modes apply to HTML builds only");
    if (options.sourceUrl !== undefined && format !== "html")
        throw new Error("Source URL applies to HTML builds only");
    const sourceBase = format === "html" ? sourceFileBase(root, options.sourceUrl) : undefined;
    const urlPreview = options.urlPreview ?? (options.mode === "live" ? "network" : "embed");
    if (options.mode !== undefined && !["static", "live"].includes(options.mode))
        throw new Error("build mode must be static | live");
    if (options.mode && format !== "html") throw new Error("Build modes apply to HTML only");
    if (options.auth !== undefined && (options.auth !== "external" || options.mode !== "live"))
        throw new Error("External authentication requires live HTML");
    if (options.mode === "static" && urlPreview !== "embed")
        throw new Error("Static HTML requires embedded resources");
    if (options.mode === "live" && urlPreview !== "network")
        throw new Error("Live HTML requires network resources");
    if (format !== "html" && format !== "zip") throw new Error("build format must be html | zip");
    if (urlPreview !== "embed" && urlPreview !== "network")
        throw new Error("--url_preview must be embed | network");
    if (format === "zip" && urlPreview !== "embed")
        throw new Error("ZIP builds require embedded URL resources; use HTML for network mode");
    const previews =
        options.previews ??
        parsePreviewSettings({
            domains: (await loadReaderPlugins(options.pluginModule)).allowedDomains ?? [],
        });
    const validate = (path: string, locale?: string) => {
        const compiled = compileSite(path, { previews, locale });
        if (compiled.errors.length)
            throw new Error(`Content validation failed:\n${compiled.errors.join("\n")}`);
        return compiled;
    };
    await prepareDocumentSources(root);
    let entries = exportEntries(root);
    const versionConfig = readManifest(root).version;
    if (
        versionConfig &&
        [versionConfig.minor, versionConfig.patch].includes("git") &&
        !gitHeadFile(root)
    )
        throw new Error("Git versioning requires a Git workspace");
    const stored =
        versionConfig &&
        ([versionConfig.minor, versionConfig.patch].includes("hash") || !gitHeadFile(root))
            ? prepareStoredVersion(root, versionConfig)
            : undefined;
    let version = stored?.version;
    let revision: string | undefined;
    if (!stored && gitHeadFile(root)) {
        const catalog = createDocumentVersions(root);
        try {
            const current = (await catalog.list()).find((row) => row.current);
            if (current) {
                const committed = await catalog.open(current.revision);
                const expected = versionInput(
                    committed,
                    readManifest(committed).version ?? parseVersionConfig({}),
                );
                const actual = versionInput(root, versionConfig ?? parseVersionConfig({}), entries);
                version =
                    current.version +
                    (JSON.stringify(expected) === JSON.stringify(actual) ? "" : "+dirty");
                revision = current.revision;
            }
        } finally {
            catalog.close();
        }
    }
    const downloadSources =
        options.download === "easy"
            ? new Map(entries.map(({ name, data }) => [name, data]))
            : undefined;
    let compiled = validate(root);
    if (urlPreview === "embed") {
        const plugins =
            format !== "zip" && !options.pluginTransport
                ? await loadBuildPlugins(root, options.pluginModule)
                : undefined;
        try {
            const request = options.pluginTransport ?? plugins?.request;
            entries = await embedBundleUrls(
                root,
                entries,
                request ? pluginSnapshot(request) : undefined,
            );
        } finally {
            plugins?.dispose();
        }
        const temp = mkdtempSync(join(tmpdir(), "dooc-bundle-"));
        try {
            for (const entry of entries) {
                const path = textfilePath(temp, entry.name);
                mkdirSync(dirname(path), { recursive: true });
                writeFileSync(path, entry.data);
            }
            compiled = validate(projectRoot(join(temp, manifestFile(root))));
        } finally {
            rmSync(temp, { recursive: true, force: true });
        }
    }
    if (format === "zip")
        return {
            data: zip(entries),
            docs: compiled.docs.length,
            version,
            revision,
            commitVersion: stored?.commit,
        };
    const config = await loadSiteLanguages(root);
    const { bundleClient, bundleGraph, publishHtml, siteFrom } = await import("./serve.js");
    const linkable = new Set(filesSnapshot(root).files.map((file) => file.path));
    const site = {
        ...siteFrom(compiled, config.languages, config),
        root,
        sourceBase,
        fonts: loadProjectFonts(root),
        download: options.download ?? "normal",
        readLinkedFile: (file: string) =>
            linkable.has(file) ? readFileSync(textfilePath(root, file)) : undefined,
    };
    if (options.download === "easy")
        site.ctx.downloads = new Map(
            entries.map(({ name, data }) => [
                name,
                `data:application/octet-stream;base64,${(downloadSources?.get(name) ?? data).toString("base64")}`,
            ]),
        );
    const blocks = walkBlocks(site.entries.flatMap((entry) => entry.blocks));
    const code = blocks.flatMap((block) =>
        block.type === "code" && block.lang !== "mermaid" && !block.unavailable && !block.subformat
            ? [block]
            : [],
    );
    site.codeGrammars = selectCodeGrammars(
        site.codeGrammars ?? [],
        code.map((block) => block.lang ?? "text"),
    );
    const diagrams = blocks.some(
        (block) =>
            block.type === "schemaGraph" ||
            (block.type === "code" && block.lang === "mermaid" && !block.unavailable),
    );
    const [graphJs, codeJs, pluginJs, subformatJs] = await Promise.all([
        diagrams && !split ? bundleClient("schema-graph-global.tsx") : "",
        code.length ? bundleClient("code-highlight.ts") : "",
        options.mode === "live" && blocks.some((block) => block.type === "external")
            ? bundleClient("published-plugins.ts")
            : "",
        compiled.docs.some((doc) => doc.subformat || doc.library) ||
        blocks.some((block) => block.type === "code" && block.subformat)
            ? bundleClient("published-subformats.ts")
            : "",
    ]);
    const render = (output?: PublishOutput): string => {
        const html = publishHtml(
            site,
            graphJs,
            undefined,
            codeJs,
            options.mode === "live" ? "live" : urlPreview === "embed" ? "static" : "network",
            pluginJs,
            subformatJs,
            output,
        );
        return version
            ? html.replace(
                  "</head>",
                  `<meta name="dooc-version" content="${version}">${revision ? `<meta name="dooc-revision" content="${revision}">` : ""}</head>`,
              )
            : html;
    };
    const output = split
        ? await splitBuild(
              render,
              options,
              site.fonts.map((font) => font.source),
              diagrams ? await bundleGraph() : undefined,
          )
        : { data: render(), files: undefined, warnings: [] };
    if (options.warningsAsErrors && output.warnings.length)
        throw new Error(`Build warnings treated as errors:\n${output.warnings.join("\n")}`);
    const bytes = split
        ? checkBuildSize(
              new Map([["index.html", Buffer.from(output.data)], ...(output.files ?? [])]),
              maxFileSize,
              maxBuildSize,
          )
        : Buffer.byteLength(output.data);
    return {
        ...output,
        bytes,
        docs: compiled.docs.length,
        version,
        revision,
        commitVersion: stored?.commit,
    };
};
