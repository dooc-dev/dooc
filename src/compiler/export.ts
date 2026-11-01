// Collects the zip entries for the layout-convention part of the docs root
// (content/ figures/ icons/, plus manifest.yaml and docs.config.mjs if present).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_FILE } from "../core/content-metadata.js";
import { CODE_LANGUAGES_DIR } from "./code-languages.js";
import { CONFIG_FILE } from "./config.js";
import type { ZipEntry } from "./zip.js";

const LAYOUT_DIRS = ["content", "figures", "icons", "locales", ".document-system/editor-tools"];

export const exportEntries = (root: string): ZipEntry[] => [
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
            .map((name) => ({ name, data: readFileSync(join(root, name)) })),
    ),
];
