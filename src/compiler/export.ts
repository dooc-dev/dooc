import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { posix } from "node:path";
import { visit } from "unist-util-visit";
import { flattenTree, MANIFEST_FILE } from "../core/content-metadata.js";
import { docFile, docIconFile, fileExtension, localFile } from "../core/files.js";
import { contentLinks, parseMdast } from "../core/markdown.js";
import { isRemoteTextfile, parseFileReference } from "../core/textfile.js";
import { assetReferences } from "./asset-references.js";
import { CODE_LANGUAGES_DIR } from "./code-languages.js";
import { CONFIG_FILE } from "./config.js";
import { collectRefs } from "./dialect.js";
import { projectFiles } from "./files.js";
import { PROJECT_FONTS_DIR } from "./fonts.js";
import { assertNotIgnored, ignoredFiles } from "./ignored-files.js";
import { siteContentLanguages, translationFile } from "./locales.js";
import { readManifest } from "./manifest.js";
import { readTextfile, textfilePath } from "./textfile.js";
import { themeVariants } from "./theme-variants.js";
import { type ZipEntry, zip } from "./zip.js";

/** Collect source dependencies without executing configuration, plugins or remote requests. */
export const exportEntries = (root: string): ZipEntry[] => {
    const manifest = readManifest(root);
    if (manifest.errors.length) throw new Error(manifest.errors.join("\n"));
    const entries = new Map<string, ZipEntry>();
    const add = (file: string): void => {
        file = file.replace(/^(\.\/)+/, "");
        if (entries.has(file)) return;
        const settingsFile = [PROJECT_FONTS_DIR, CODE_LANGUAGES_DIR, ".dooc/editor-tools"].some(
            (dir) => file.startsWith(`${dir}/`) && localFile(file.slice(dir.length + 1)),
        );
        // References are already URL-decoded; # and ? are literal filename characters here.
        if (!localFile(file.replace(/[?#]/g, "_")) && !settingsFile)
            throw new Error(`Invalid export dependency: ${file}`);
        const path = textfilePath(root, file);
        assertNotIgnored(root, file);
        if (!statSync(path).isFile()) throw new Error(`Expected a regular source file: ${file}`);
        entries.set(file, { name: file, data: readFileSync(path) });
        for (const variant of Object.values(themeVariants(root, file))) add(variant);
    };
    const optional = (file: string) => {
        if (existsSync(textfilePath(root, file)) && !ignoredFiles(root, [file]).has(file))
            add(file);
    };
    add(MANIFEST_FILE);
    optional(CONFIG_FILE);
    for (const { id, subformat } of flattenTree(manifest.tree)) {
        if (subformat) continue;
        const file = docFile(id, manifest.files);
        add(file);
        if (manifest.files?.icons?.[id]) add(docIconFile(id, manifest.files));
        else optional(docIconFile(id, manifest.files));
        for (const language of siteContentLanguages(root, manifest))
            optional(translationFile(file, language));
    }
    for (const file of new Set([manifest.icon, ...Object.values(manifest.themeIcons ?? {})]))
        if (file) add(file);
    const files = projectFiles(root);
    for (const format of manifest.subformats ?? []) {
        add(format.schema);
        for (const file of files) if (file.extension === format.ext) add(file.path);
    }
    for (const dir of [PROJECT_FONTS_DIR, CODE_LANGUAGES_DIR, ".dooc/editor-tools"]) {
        const path = textfilePath(root, dir);
        if (!existsSync(path)) continue;
        for (const file of readdirSync(path, { recursive: true, withFileTypes: true }))
            if (file.isFile())
                optional(posix.join(dir, posix.relative(path, file.parentPath), file.name));
    }
    const relative = (source: string, file: string) => {
        if (!source || source.startsWith("#") || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(source)) return;
        if (source.startsWith("/"))
            throw new Error(`Export dependencies must be relative: ${source}`);
        const path = decodeURIComponent(source.split(/[?#]/)[0] ?? "");
        if (!path) return;
        const dependency = posix.normalize(posix.join(posix.dirname(file), path));
        add(dependency);
        return dependency;
    };
    const schemas = new Set(manifest.subformats?.map((format) => format.schema));
    for (const file of schemas) {
        const refs = (value: unknown): void => {
            if (!value || typeof value !== "object") return;
            for (const [key, child] of Object.entries(value)) {
                if (key === "$ref" && typeof child === "string") {
                    const dependency = relative(child, file);
                    if (dependency) schemas.add(dependency);
                } else refs(child);
            }
        };
        refs(JSON.parse(entries.get(file)?.data.toString("utf8") ?? ""));
    }
    // Map iteration visits dependencies appended while walking the graph, once per path.
    for (const entry of entries.values()) {
        const ext = fileExtension(entry.name);
        if (["md", "callouth"].includes(ext)) {
            const tree = parseMdast(entry.data.toString("utf8"));
            const refs = collectRefs(tree);
            for (const file of refs.figures) if (!isRemoteTextfile(file)) add(file);
            for (const file of [...refs.terms, ...refs.textfiles])
                if (!isRemoteTextfile(file)) {
                    readTextfile(root, file);
                    add(file);
                }
            const reference = (url: string) => {
                if (/^(?:[a-z][\w+.-]*:|[/#])/i.test(url)) return;
                add(parseFileReference(url).file.replace(/^(\.\/)+/, ""));
            };
            visit(tree, "image", (node) => reference(node.url));
            for (const link of contentLinks(tree)) reference(link.url);
        } else if (["html", "htm", "svg", "css"].includes(ext))
            assetReferences(entry.data.toString("utf8"), ext, (url, embedded) => {
                if (embedded) relative(url, entry.name);
                return url;
            });
    }
    return [...entries.values()];
};

export const exportBundle = (root: string): Buffer => zip(exportEntries(root));
