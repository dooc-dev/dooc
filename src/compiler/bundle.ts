// A bundle contains dooc.yaml and its managed source files, assets and local configuration.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { MANIFEST_FILE } from "../core/content-metadata.js";
import { isRemoteTextfile } from "../core/textfile.js";
import { CODE_LANGUAGES_DIR } from "./code-languages.js";
import { CONFIG_FILE } from "./config.js";
import { collectRefs, parseDoc } from "./dialect.js";
import { projectFiles } from "./files.js";
import { PROJECT_FONTS_DIR } from "./fonts.js";
import { readManifest } from "./manifest.js";
import { readTextfile, textfilePath } from "./textfile.js";
import type { ZipEntry } from "./zip.js";

const LAYOUT_DIRS = [
    "content",
    "figures",
    "icons",
    "locales",
    "themes",
    ".dooc/editor-tools",
    PROJECT_FONTS_DIR,
];

export const bundleEntries = (root: string): ZipEntry[] => {
    const entries: ZipEntry[] = [
        ...[CONFIG_FILE, MANIFEST_FILE]
            .filter((name) => existsSync(join(root, name)))
            .map((name) => ({ name, data: readFileSync(join(root, name)) })),
        ...(existsSync(join(root, CODE_LANGUAGES_DIR))
            ? readdirSync(join(root, CODE_LANGUAGES_DIR))
                  .filter(
                      (file) =>
                          !file.startsWith(".") &&
                          file.endsWith(".json") &&
                          statSync(join(root, CODE_LANGUAGES_DIR, file)).isFile(),
                  )
                  .sort()
                  .map((file) => ({
                      name: `${CODE_LANGUAGES_DIR}/${file}`,
                      data: readFileSync(join(root, CODE_LANGUAGES_DIR, file)),
                  }))
            : []),
        ...LAYOUT_DIRS.filter((dir) => existsSync(join(root, dir))).flatMap((dir) =>
            readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
                .filter(
                    (rel) =>
                        !rel
                            .replaceAll("\\", "/")
                            .split("/")
                            .some((seg) => seg.startsWith(".")),
                )
                .map((rel) => `${dir}/${rel.replaceAll("\\", "/")}`)
                .filter((name) => statSync(join(root, name)).isFile())
                .sort()
                .map((name) => ({ name, data: readFileSync(textfilePath(root, name)) })),
        ),
    ];
    const known = new Set(entries.map((entry) => entry.name));
    const layout = readManifest(root).files;
    const mapped = new Set([...(layout?.order ?? []), ...Object.values(layout?.documents ?? {})]);
    for (const file of projectFiles(root))
        if ((file.path.startsWith("files/") || mapped.has(file.path)) && !known.has(file.path))
            entries.push({ name: file.path, data: readFileSync(join(root, file.path)) });
    const bodies = entries
        .filter((entry) => /\.(md|callouth)$/.test(entry.name))
        .map((entry) => entry.data.toString("utf8"));
    const included = new Set(entries.map((entry) => entry.name));
    const { icon } = readManifest(root);
    if (icon && !included.has(posix.normalize(icon))) {
        const name = posix.normalize(icon);
        entries.push({ name, data: Buffer.from(readTextfile(root, icon), "utf8") });
        included.add(name);
    }
    for (const body of bodies) {
        const refs = collectRefs(parseDoc(body).root);
        for (const file of refs.figures) {
            if (included.has(file)) continue;
            try {
                entries.push({ name: file, data: readFileSync(textfilePath(root, file)) });
                included.add(file);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
        }
        for (const file of [...refs.textfiles, ...refs.terms]) {
            if (isRemoteTextfile(file)) continue;
            let text: string;
            try {
                text = readTextfile(root, file);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
                throw error;
            }
            const name = posix.normalize(file);
            if (included.has(name)) continue;
            entries.push({ name, data: Buffer.from(text, "utf8") });
            included.add(name);
            if (name.endsWith(".callouth")) bodies.push(text);
        }
    }
    return entries;
};
