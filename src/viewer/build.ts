import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { embedBundleUrls } from "../compiler/bundle-urls.js";
import { compileSite } from "../compiler/compile.js";
import { exportEntries } from "../compiler/export.js";
import { loadProjectFonts } from "../compiler/fonts.js";
import { textfilePath } from "../compiler/textfile.js";
import { zip } from "../compiler/zip.js";
import { type PreviewSettings, parsePreviewSettings } from "../core/previewers.js";
import type { PluginTransport } from "../plugins/transport.js";
import { loadBuildPlugins, pluginSnapshot } from "./build-plugins.js";
import { loadSiteLanguages } from "./languages.js";
import { loadViewerPlugins } from "./plugin-config.js";
import { sourceFileBase } from "./workspace.js";

export interface BuildOptions {
    format: "html" | "zip";
    urlPreview?: "embed" | "network";
    mode?: "static" | "live";
    auth?: "external";
    /** Public directory URL corresponding to the manifest directory, embedded in HTML. */
    sourceUrl?: string;
    /** Trusted server module used for static snapshots, never serialized into HTML. */
    pluginModule?: string;
    /** Build-time authenticated reads; live HTML receives its transport at runtime. */
    pluginTransport?: PluginTransport;
    previews?: PreviewSettings;
}

/** Build one artifact from the manifest and its managed content. */
export const buildBundle = async (root: string, options: BuildOptions) => {
    const { format } = options;
    if (options.sourceUrl !== undefined && format !== "html")
        throw new Error("Source URL applies to HTML builds only");
    const sourceBase = format === "html" ? sourceFileBase(root, options.sourceUrl) : undefined;
    const urlPreview = options.urlPreview ?? (options.mode === "live" ? "network" : "embed");
    if (options.mode !== undefined && !["static", "live"].includes(options.mode))
        throw new Error("build mode must be static | live");
    if (options.mode && format !== "html")
        throw new Error("Build modes apply to HTML; use export for source ZIPs");
    if (options.auth !== undefined && (options.auth !== "external" || options.mode !== "live"))
        throw new Error("External authentication requires live HTML");
    if (options.mode === "static" && urlPreview !== "embed")
        throw new Error("Static HTML requires embedded resources");
    if (options.mode === "live" && urlPreview !== "network")
        throw new Error("Live HTML requires network resources");
    if (format !== "html" && format !== "zip") throw new Error("build format must be html | zip");
    if (urlPreview !== "embed" && urlPreview !== "network")
        throw new Error("--url_preview must be embed | network");
    const previews =
        options.previews ??
        parsePreviewSettings({
            domains: (await loadViewerPlugins(options.pluginModule)).allowedDomains ?? [],
        });
    const validate = (path: string) => {
        const compiled = compileSite(path, { previews });
        if (compiled.errors.length)
            throw new Error(`Content validation failed:\n${compiled.errors.join("\n")}`);
        return compiled;
    };
    let entries = exportEntries(root);
    let compiled = validate(root);
    if (urlPreview === "embed") {
        const plugins =
            format === "html" && !options.pluginTransport
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
            compiled = validate(temp);
        } finally {
            rmSync(temp, { recursive: true, force: true });
        }
    }
    if (format === "zip") return { data: zip(entries), docs: compiled.docs.length };
    const config = await loadSiteLanguages(root);
    const { bundleClient, publishHtml, siteFrom } = await import("./serve.js");
    return {
        data: publishHtml(
            {
                ...siteFrom(compiled, config.languages, config),
                sourceBase,
                fonts: loadProjectFonts(root),
            },
            await bundleClient("core/schema-graph-global.tsx"),
            undefined,
            await bundleClient("viewer/code-highlight.ts"),
            options.mode === "live" ? "live" : urlPreview === "embed" ? "static" : "network",
            options.mode === "live" ? await bundleClient("viewer/published-plugins.ts") : "",
            compiled.docs.some((doc) => doc.subformat)
                ? await bundleClient("viewer/published-subformats.ts")
                : "",
        ),
        docs: compiled.docs.length,
    };
};
