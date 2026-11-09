import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { type ZipEntry, zip } from "../compiler/zip.js";
import {
    MAX_EXTENSION_BYTES,
    MAX_EXTENSION_FILES,
    readExtensionZip,
} from "../core/extension-package.js";

/** Package an already bundled module and its relative assets without running build scripts. */
export const packExtension = async (root: string, output?: string): Promise<Buffer> => {
    const entries: ZipEntry[] = [];
    let size = 0;
    const walk = (folder: string, prefix = "") => {
        for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name),
        )) {
            const path = join(folder, entry.name);
            if (output && resolve(path) === resolve(output)) continue;
            const name = prefix + entry.name;
            if (entry.isSymbolicLink())
                throw new Error(`Plugin assets cannot be symlinks: ${name}`);
            if (name.length > 240) throw new Error("Plugin asset path is too long");
            if (entry.isDirectory()) {
                walk(path, `${name}/`);
                continue;
            }
            if (!entry.isFile()) throw new Error(`Expected a regular plugin asset: ${name}`);
            size += lstatSync(path).size;
            if (size > MAX_EXTENSION_BYTES || entries.length >= MAX_EXTENSION_FILES)
                throw new Error("Plugins are limited to 16 MiB and 256 files");
            entries.push({ name, data: readFileSync(path) });
        }
    };
    walk(root);
    const data = zip(entries);
    await readExtensionZip(data, async (bytes, size) =>
        inflateRawSync(bytes, { maxOutputLength: Math.max(1, size) }),
    );
    return data;
};
