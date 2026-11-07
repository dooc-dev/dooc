import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bundleEntries } from "../compiler/bundle.js";
import { embedBundleUrls } from "../compiler/bundle-urls.js";
import { compileSite } from "../compiler/compile.js";
import { loadProjectFonts } from "../compiler/fonts.js";
import { textfilePath } from "../compiler/textfile.js";
import { zip } from "../compiler/zip.js";
import { loadSiteLanguages } from "./languages.js";

export interface BuildOptions {
    format: "html" | "zip";
    urlPreview?: "embed" | "network";
}

/** Build one artifact from the manifest and its managed content. */
export const buildBundle = async (root: string, options: BuildOptions) => {
    const { format } = options;
    const urlPreview = options.urlPreview ?? "embed";
    if (format !== "html" && format !== "zip") throw new Error("build format must be html | zip");
    if (urlPreview !== "embed" && urlPreview !== "network")
        throw new Error("--url_preview must be embed | network");
    const validate = (path: string) => {
        const compiled = compileSite(path);
        if (compiled.errors.length)
            throw new Error(`Content validation failed:\n${compiled.errors.join("\n")}`);
        return compiled;
    };
    let compiled = validate(root);
    let entries = format === "zip" || urlPreview === "embed" ? bundleEntries(root) : [];
    if (urlPreview === "embed") {
        entries = await embedBundleUrls(root, entries);
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
                ...siteFrom(compiled, config.languages),
                fonts: loadProjectFonts(root),
                codeLanguages: config.codeLanguages,
                codeGrammars: config.codeGrammars,
            },
            await bundleClient("core/schema-graph-global.tsx", true),
            undefined,
            await bundleClient("viewer/code-highlight.ts", true),
            urlPreview === "embed" ? "static" : "network",
        ),
        docs: compiled.docs.length,
    };
};
