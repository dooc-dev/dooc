import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { manifestFile } from "../../engine/src/compiler/manifest.js";
import { textfilePath } from "../../engine/src/compiler/textfile.js";
import type { ZipEntry } from "../../engine/src/compiler/zip.js";

/**
 * Default artifact path. HTML is published from build/ and archives are handed over from dist/,
 * so serving the HTML folder never exposes an archive. Named manifests get their own subfolder.
 */
export const outputFile = (
    root: string,
    format: "html" | "zip",
    github = false,
    directory?: string,
): string =>
    join(
        directory ??
            join(
                root,
                format === "html" ? "build" : "dist",
                manifestFile(root).replace(/\.?dooc\.yaml$/, ""),
            ),
        github ? `bundle.github.${format}` : format === "html" ? "index.html" : "bundle.zip",
    );

/** Install companions before the entry point, restoring the previous directory on failure. */
export const writeBuildOutput = (
    path: string,
    bundle: { data: string | Buffer; files?: readonly ZipEntry[] },
): void => {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true });
    const stage = mkdtempSync(join(directory, ".dooc-build-"));
    const companions = join(directory, "bundle.github");
    const backup = join(stage, "previous");
    let installed = false;
    let previous = false;
    let committed = false;
    try {
        writeFileSync(join(stage, "artifact"), bundle.data);
        for (const file of bundle.files ?? []) {
            if (!file.name.startsWith("bundle.github/"))
                throw new Error(`Invalid build companion: ${file.name}`);
            const target = textfilePath(stage, file.name);
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, file.data);
        }
        if (bundle.files?.length) {
            if (lstatSync(companions, { throwIfNoEntry: false })) {
                if (
                    !lstatSync(companions).isDirectory() ||
                    !existsSync(join(companions, "dooc-github.json")) ||
                    JSON.parse(readFileSync(join(companions, "dooc-github.json"), "utf8"))
                        .schemaVersion !== 1
                )
                    throw new Error(`Output directory is not a dooc GitHub build: ${companions}`);
                renameSync(companions, backup);
                previous = true;
            }
            renameSync(join(stage, "bundle.github"), companions);
            installed = true;
        }
        renameSync(join(stage, "artifact"), path);
        committed = true;
    } catch (error) {
        if (installed) rmSync(companions, { recursive: true, force: true });
        if (previous) renameSync(backup, companions);
        throw error;
    } finally {
        if (committed || !existsSync(backup)) rmSync(stage, { recursive: true, force: true });
    }
};
