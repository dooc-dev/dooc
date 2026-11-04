// Standard JSON catalogs: locales/<ISO 639-3>.json, keyed by stable document id.
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isDocId } from "../core/content-metadata.js";
import { parseDoc } from "./dialect.js";
import { isContentLanguage } from "./language-codes.js";

export interface Translation {
    title: string;
    body: string;
}
export type Catalog = Record<string, Translation>;

export const localePath = (root: string, lang: string): string => {
    if (!isContentLanguage(lang)) throw new Error("Expected an ISO 639-3 language code");
    return join(root, "locales", `${lang}.json`);
};

export const catalogLanguages = (root: string): string[] => {
    const dir = join(root, "locales");
    return existsSync(dir)
        ? readdirSync(dir)
              .filter((name) => name.endsWith(".json") && isContentLanguage(name.slice(0, -5)))
              .map((name) => name.slice(0, -5))
              .sort()
        : [];
};

export const readCatalog = (root: string, lang: string): Catalog => {
    const file = localePath(root, lang);
    if (!existsSync(file)) return {};
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${file}: expected a JSON object`);
    for (const [id, entry] of Object.entries(value)) {
        if (
            !isDocId(id) ||
            !entry ||
            typeof entry !== "object" ||
            Array.isArray(entry) ||
            typeof entry.title !== "string" ||
            typeof entry.body !== "string" ||
            Object.keys(entry).some((key) => !["title", "body"].includes(key))
        ) {
            throw new Error(
                `${file}: invalid translation for "${id}" (title and body are required)`,
            );
        }
    }
    return value as Catalog;
};

export const writeCatalog = (root: string, lang: string, catalog: Catalog): void => {
    const file = localePath(root, lang);
    mkdirSync(join(root, "locales"), { recursive: true });
    const temp = `${file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(catalog, null, 2)}\n`);
    renameSync(temp, file);
};

export const setDocTranslation = (
    root: string,
    sourceLanguage: string,
    id: string,
    language: string,
    added: boolean,
): void => {
    if (!isDocId(id)) throw new Error("Invalid document id");
    if (language === sourceLanguage) throw new Error("Source language cannot be removed");
    const catalog = readCatalog(root, language);
    const source = readFileSync(join(root, "content", `${id}.md`), "utf8");
    if (added === Object.hasOwn(catalog, id)) return;
    if (added) {
        const doc = parseDoc(source);
        catalog[id] = { title: doc.frontmatter?.title ?? id, body: doc.body };
    } else delete catalog[id];
    writeCatalog(root, language, catalog);
};
