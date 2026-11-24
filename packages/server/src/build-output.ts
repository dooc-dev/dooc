import {
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

/** Publish immutable assets first, then atomically switch the entry point. */
export const writeBuildOutput = (
    path: string,
    bundle: { data: string | Buffer; files?: ReadonlyMap<string, Buffer> },
): void => {
    const directory = dirname(path);
    for (const [name] of bundle.files ?? [])
        if (
            !/^dooc-assets\/[a-zA-Z0-9_./-]+$/.test(name) ||
            name.split("/").some((part) => ["", ".", ".."].includes(part))
        )
            throw new Error(`Invalid build asset path: ${name}`);
    mkdirSync(directory, { recursive: true });
    const stage = mkdtempSync(join(directory, ".dooc-build-"));
    try {
        writeFileSync(join(stage, "artifact"), bundle.data);
        const pending: string[] = [];
        for (const [name, data] of bundle.files ?? []) {
            const parts = name.split("/");
            for (let i = 1; i < parts.length; i++) {
                const parent = join(directory, ...parts.slice(0, i));
                const stat = lstatSync(parent, { throwIfNoEntry: false });
                if (stat && !stat.isDirectory())
                    throw new Error(`Build asset directory is not a regular directory: ${parent}`);
            }
            const target = join(directory, name);
            const stat = lstatSync(target, { throwIfNoEntry: false });
            if (stat) {
                if (!stat.isFile() || !readFileSync(target).equals(data))
                    throw new Error(`Build asset conflicts with an existing file: ${target}`);
                continue;
            }
            const staged = join(stage, name);
            mkdirSync(dirname(staged), { recursive: true });
            writeFileSync(staged, data);
            pending.push(name);
        }
        for (const name of pending) {
            const target = join(directory, name);
            mkdirSync(dirname(target), { recursive: true });
            renameSync(join(stage, name), target);
        }
        renameSync(join(stage, "artifact"), path);
    } finally {
        rmSync(stage, { recursive: true, force: true });
    }
};
