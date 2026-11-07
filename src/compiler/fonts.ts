import { createHash } from "node:crypto";
import {
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { basename, extname } from "node:path";
import { localFile } from "../core/files.js";
import { textfilePath } from "./textfile.js";

export const PROJECT_FONTS_DIR = ".dooc/fonts";
export interface ProjectFont {
    name: string;
    family: string;
    source: string;
}

const fontName = (name: string): string => {
    if (!localFile(name) || name.includes("/") || !/\.(ttf|otf|woff2?)$/i.test(name))
        throw new Error("Expected a TTF, OTF, WOFF or WOFF2 file name");
    return name;
};

export const listProjectFonts = (root: string): string[] => {
    const directory = textfilePath(root, PROJECT_FONTS_DIR);
    if (!lstatSync(directory, { throwIfNoEntry: false })) return [];
    return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.(ttf|otf|woff2?)$/i.test(entry.name))
        .map((entry) => fontName(entry.name))
        .sort();
};

export const addProjectFont = (root: string, file: string): string => {
    const name = fontName(basename(file));
    const data = readFileSync(file);
    const extension = extname(name).slice(1).toLowerCase();
    const signature = data.subarray(0, 4).toString("latin1");
    const signatures: Record<string, string[]> = {
        ttf: ["\x00\x01\x00\x00", "true"],
        otf: ["OTTO"],
        woff: ["wOFF"],
        woff2: ["wOF2"],
    };
    if (
        data.length < (extension === "woff2" ? 48 : extension === "woff" ? 44 : 12) ||
        !signatures[extension]?.includes(signature) ||
        (extension.startsWith("woff") && data.readUInt32BE(8) !== data.length)
    )
        throw new Error(`${name}: invalid font header`);
    mkdirSync(textfilePath(root, PROJECT_FONTS_DIR), { recursive: true });
    // Exclusive creation preserves a registered font until it is explicitly removed.
    writeFileSync(textfilePath(root, `${PROJECT_FONTS_DIR}/${name}`), data, { flag: "wx" });
    return `${PROJECT_FONTS_DIR}/${name}`;
};

export const removeProjectFont = (root: string, name: string): void => {
    if (!listProjectFonts(root).includes(fontName(name)))
        throw new Error(`Font not found: ${name}`);
    unlinkSync(textfilePath(root, `${PROJECT_FONTS_DIR}/${name}`));
};

export const loadProjectFonts = (root: string): ProjectFont[] =>
    listProjectFonts(root).map((name) => {
        const data = readFileSync(textfilePath(root, `${PROJECT_FONTS_DIR}/${name}`));
        const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
        return {
            name,
            family: `dooc-font-${hash}`,
            source: `url(data:font/${extname(name).slice(1).toLowerCase()};base64,${data.toString("base64")})`,
        };
    });
