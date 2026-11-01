// Collects the zip entries for the layout-convention part of the docs root
// (content/ figures/ icons/, plus docs.config.mjs if present).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE } from "./config.js";
import type { ZipEntry } from "./zip.js";

const LAYOUT_DIRS = ["content", "figures", "icons", "locales"];

export const exportEntries = (root: string): ZipEntry[] => [
    ...(existsSync(join(root, CONFIG_FILE))
        ? [{ name: CONFIG_FILE, data: readFileSync(join(root, CONFIG_FILE)) }]
        : []),
    ...LAYOUT_DIRS.filter((dir) => existsSync(join(root, dir))).flatMap((dir) =>
        readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
            .map((rel) => `${dir}/${rel.replaceAll("\\", "/")}`)
            .filter((name) => !name.split("/").some((seg) => seg.startsWith(".")))
            .filter((name) => statSync(join(root, name)).isFile())
            .sort()
            .map((name) => ({ name, data: readFileSync(join(root, name)) })),
    ),
];
