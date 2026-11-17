import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { manifestFile } from "../../engine/src/compiler/manifest.js";

/**
 * Default artifact path. HTML is published from build/ and archives are handed over from dist/,
 * so serving the HTML folder never exposes an archive. Named manifests get their own subfolder.
 */
export const outputFile = (root: string, format: "html" | "zip", directory?: string): string =>
    join(
        directory ??
            join(
                root,
                format === "html" ? "build" : "dist",
                manifestFile(root).replace(/\.?dooc\.yaml$/, ""),
            ),
        format === "html" ? "index.html" : "bundle.zip",
    );

/** Replace only the artifact, through a temporary file so a failed write keeps the previous one. */
export const writeBuildOutput = (path: string, bundle: { data: string | Buffer }): void => {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true });
    const stage = mkdtempSync(join(directory, ".dooc-build-"));
    try {
        writeFileSync(join(stage, "artifact"), bundle.data);
        renameSync(join(stage, "artifact"), path);
    } finally {
        rmSync(stage, { recursive: true, force: true });
    }
};
