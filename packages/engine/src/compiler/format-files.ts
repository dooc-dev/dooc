import { flattenTree, type ParsedManifest } from "../core/content-metadata.js";
import { fenceFormat, fileFormat } from "../core/formats.js";
import { managedFile, projectFiles } from "./files.js";
import { statSync } from "./host.js";
import { assertNotIgnored } from "./ignored-files.js";
import { textfilePath } from "./textfile.js";

/** Resolve explicit sources against the same workspace snapshot used by Files. */
export const formatFiles = (
    root: string,
    manifest: ParsedManifest,
    available: readonly string[] = projectFiles(root).map((file) => file.path),
): { files: string[]; errors: { file: string; message: string }[] } => {
    const files = new Set<string>();
    const errors: { file: string; message: string }[] = [];
    const paths = new Set(available);
    const known = new Set([
        ...available.map(fileFormat),
        ...Object.keys(manifest.formats ?? {}),
        ...Object.values(manifest.includedFormats ?? {}).flatMap(Object.keys),
    ]);
    const listed = new Set(
        flattenTree(manifest.tree).flatMap((node) =>
            node.format ? [known.has(node.format) ? node.format : fenceFormat(node.format)] : [],
        ),
    );
    for (const file of paths) if (listed.has(fileFormat(file))) files.add(file);
    for (const settings of [manifest.formats, ...Object.values(manifest.includedFormats ?? {})]) {
        for (const [format, sources] of Object.entries(settings ?? {})) {
            for (const file of sources.files ?? []) {
                try {
                    assertNotIgnored(root, file);
                    if (!paths.has(file) || !statSync(textfilePath(root, file)).isFile())
                        throw new Error("File is not available in the workspace");
                    files.add(file);
                } catch (error) {
                    errors.push({
                        file,
                        message: String(error instanceof Error ? error.message : error),
                    });
                }
            }
            for (const folder of sources.folders ?? []) {
                try {
                    if (folder !== "." && !managedFile(folder))
                        throw new Error("Folder is not available in the workspace");
                    if (folder !== ".") assertNotIgnored(root, `${folder}/`);
                    const directory = statSync(textfilePath(root, folder), {
                        throwIfNoEntry: false,
                    });
                    if (directory && !directory.isDirectory())
                        throw new Error("Expected a directory");
                    for (const file of paths)
                        if (
                            (folder === "." || file.startsWith(`${folder}/`)) &&
                            fileFormat(file) === format
                        )
                            files.add(file);
                } catch (error) {
                    errors.push({
                        file: folder,
                        message: String(error instanceof Error ? error.message : error),
                    });
                }
            }
        }
    }
    return { files: [...files].sort(), errors };
};
