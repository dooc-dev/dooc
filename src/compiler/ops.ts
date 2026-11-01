// Write operations on the docs root (create / move / rename / delete docs and save body text;
// add / remove figures). Shared by the viewer's edit API, the CLI (doc / figure) and MCP.
// Failures are returned as { error, status } (status is HTTP-like) with no partial updates.
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
    type DocNode,
    docIdOfFile,
    flattenTree,
    insertDoc,
    isDocId,
    moveDoc,
    removeDoc,
    renameDoc,
} from "../core/content-metadata.js";
import { parseDocLink } from "../core/routing.js";
import { collectDocLinks, compileSite, rewriteDocLinks } from "./compile.js";
import { figureName, figureUploadName } from "./figures.js";
import { ICONS_DIR } from "./icons.js";
import { catalogLanguages, readCatalog, writeCatalog } from "./locales.js";
import { readManifest, writeManifest } from "./manifest.js";
import { assembleDoc } from "./serialize.js";

export interface OpError {
    error: string;
    status: 400 | 404 | 409;
    referencedBy?: string[];
}

export type OpResult<T> = T | OpError;

export const isOpError = (r: unknown): r is OpError =>
    typeof r === "object" && r != null && "error" in r;

export { assembleDoc } from "./serialize.js";

export const createDocOps = (root: string) => {
    const contentDir = join(root, "content");
    const figuresDir = join(root, "figures");
    const iconsDir = join(root, ICONS_DIR);
    const docPath = (id: string): string => join(contentDir, `${id}.md`);
    const iconPath = (id: string): string => join(iconsDir, `${id}.svg`);

    const loadCatalogs = (): OpResult<{
        catalogs: { lang: string; catalog: ReturnType<typeof readCatalog> }[];
    }> => {
        try {
            return {
                catalogs: catalogLanguages(root).map((lang) => ({
                    lang,
                    catalog: readCatalog(root, lang),
                })),
            };
        } catch (error) {
            return { error: String(error), status: 409 };
        }
    };

    // Read before rewriting manifest.yaml. If it's broken, don't write (= don't clobber
    // hand-written content).
    const loadTree = (): OpResult<{ tree: DocNode[] }> => {
        const { tree, errors } = readManifest(root);
        return errors.length > 0 ? { error: errors.join(" / "), status: 409 } : { tree };
    };

    const existingDoc = (id: unknown): OpResult<{ id: string }> =>
        typeof id === "string" && isDocId(id) && existsSync(docPath(id))
            ? { id }
            : { error: `doc "${String(id)}" not found`, status: 404 };

    // Files whose body text references id via a doc: link (<id>.md directly under content/,
    // excluding the doc itself).
    const referencingFiles = (id: string): string[] =>
        readdirSync(contentDir)
            .filter((f) => f !== `${id}.md` && docIdOfFile(f) != null)
            .filter((f) =>
                collectDocLinks(readFileSync(join(contentDir, f), "utf8")).some(
                    (url) => parseDocLink(url) === id,
                ),
            );

    /** Creates content/<id>.md (title only) and appends it as the last child of parent. */
    const add = (id: string, title: string, parent?: string): OpResult<{ id: string }> => {
        if (!title) {
            return { error: "title is required", status: 400 };
        }
        if (!isDocId(id)) {
            return { error: "id must be lowercase alphanumerics and hyphens", status: 400 };
        }
        if (existsSync(docPath(id))) {
            return { error: `id "${id}" is already in use`, status: 409 };
        }
        const loaded = loadTree();
        if (isOpError(loaded)) {
            return loaded;
        }
        const tree = insertDoc(loaded.tree, id, parent);
        if (!tree) {
            return { error: `duplicate id "${id}" or missing parent "${parent}"`, status: 409 };
        }
        mkdirSync(contentDir, { recursive: true });
        writeFileSync(docPath(id), assembleDoc({ title }, ""));
        writeManifest(root, tree);
        return { id };
    };

    /**
     * Reorders and reparents. Rewrites only manifest.yaml. Omitted index = after the last child
     * of parent.
     */
    const move = (id: string, parent?: string, index?: number): OpResult<{ id: string }> => {
        const loaded = loadTree();
        if (isOpError(loaded)) {
            return loaded;
        }
        const at =
            index ??
            flattenTree(loaded.tree).filter((n) => n.parent === parent && n.id !== id).length;
        const tree = moveDoc(loaded.tree, id, parent, at);
        if (!tree) {
            return {
                error: "cannot move to that position (under its own descendant / unknown doc / index out of range)",
                status: 409,
            };
        }
        writeManifest(root, tree);
        return { id };
    };

    /**
     * Renames content/<old>.md and updates the manifest id and the doc: links (exact match) in
     * every doc's body text to follow.
     */
    const rename = (
        oldId: string,
        newId: string,
    ): OpResult<{ id: string; updatedRefs: number }> => {
        const target = existingDoc(oldId);
        if (isOpError(target)) {
            return target;
        }
        if (newId === "" || newId === oldId) {
            return { id: oldId, updatedRefs: 0 };
        }
        if (!isDocId(newId)) {
            return { error: "id must be a slug (lowercase alphanumerics, hyphens)", status: 400 };
        }
        if (existsSync(docPath(newId))) {
            return { error: `id "${newId}" is already in use`, status: 409 };
        }
        const loaded = loadTree();
        if (isOpError(loaded)) {
            return loaded;
        }
        const tree = renameDoc(loaded.tree, oldId, newId);
        if (!tree) {
            return { error: "doc is not in manifest.yaml", status: 404 };
        }
        const translations = loadCatalogs();
        if (isOpError(translations)) return translations;
        if (translations.catalogs.some(({ catalog }) => Object.hasOwn(catalog, newId))) {
            return { error: `translation id "${newId}" is already in use`, status: 409 };
        }
        renameSync(docPath(oldId), docPath(newId));
        if (existsSync(iconPath(oldId))) {
            renameSync(iconPath(oldId), iconPath(newId));
        }
        writeManifest(root, tree);
        let updatedRefs = 0;
        for (const f of readdirSync(contentDir).filter((n) => docIdOfFile(n) != null)) {
            const p = join(contentDir, f);
            const raw = readFileSync(p, "utf8");
            const next = rewriteDocLinks(raw, oldId, newId);
            if (next !== raw) {
                writeFileSync(p, next);
                updatedRefs += 1;
            }
        }
        for (const { lang, catalog } of translations.catalogs) {
            const translated = Object.hasOwn(catalog, oldId) ? catalog[oldId] : undefined;
            if (translated) {
                catalog[newId] = translated;
                delete catalog[oldId];
            }
            for (const entry of Object.values(catalog)) {
                const next = rewriteDocLinks(entry.body, oldId, newId);
                if (next !== entry.body) {
                    entry.body = next;
                    updatedRefs += 1;
                }
            }
            writeCatalog(root, lang, catalog);
        }
        return { id: newId, updatedRefs };
    };

    /**
     * Removes the doc from the manifest and deletes the .md (and icon). Docs with children are
     * not deleted. If other docs reference it via doc: links, refuses without force and returns
     * referencedBy. parent = the deleted doc's parent.
     */
    const remove = (
        id: string,
        force = false,
    ): OpResult<{ parent: string | undefined; danglingRefs: number }> => {
        const target = existingDoc(id);
        if (isOpError(target)) {
            return target;
        }
        const loaded = loadTree();
        if (isOpError(loaded)) {
            return loaded;
        }
        const tree = removeDoc(loaded.tree, id);
        if (!tree) {
            return { error: "doc has children (move / delete them first)", status: 409 };
        }
        const translations = loadCatalogs();
        if (isOpError(translations)) return translations;
        const referencedBy = [
            ...referencingFiles(id),
            ...translations.catalogs.flatMap(({ lang, catalog }) =>
                Object.entries(catalog)
                    .filter(
                        ([key, entry]) =>
                            key !== id &&
                            collectDocLinks(entry.body).some((url) => parseDocLink(url) === id),
                    )
                    .map(([key]) => `locales/${lang}.json:${key}`),
            ),
        ];
        if (referencedBy.length > 0 && !force) {
            return {
                error: `${referencedBy.length} doc(s) reference it via doc: links`,
                status: 409,
                referencedBy,
            };
        }
        const parent = flattenTree(loaded.tree).find((n) => n.id === id)?.parent;
        writeManifest(root, tree);
        unlinkSync(docPath(id));
        if (existsSync(iconPath(id))) {
            unlinkSync(iconPath(id));
        }
        for (const { lang, catalog } of translations.catalogs) {
            if (Object.hasOwn(catalog, id)) {
                delete catalog[id];
                writeCatalog(root, lang, catalog);
            }
        }
        return { parent, danglingRefs: referencedBy.length };
    };

    /** Overwrites an existing doc's full raw text (including front-matter). */
    const write = (id: string, raw: string): OpResult<{ id: string }> => {
        const target = existingDoc(id);
        if (isOpError(target)) {
            return target;
        }
        writeFileSync(docPath(id), raw.endsWith("\n") ? raw : `${raw}\n`);
        return { id };
    };

    /**
     * Writes a figure to figures/. file = the original file name (its extension decides the
     * kind). A figure name is shared across extensions, so if the same stem already exists,
     * -2, -3… is appended (if the same name with the same content exists, returns it without
     * writing).
     */
    const addFigure = (file: string, data: Buffer): OpResult<{ file: string }> => {
        const upload = figureUploadName(file);
        if (!upload) {
            return { error: "specify an svg / png / webp / jpeg / html file", status: 400 };
        }
        if (
            data.length === 0 ||
            (upload.endsWith(".svg") && !data.toString("utf8").includes("<svg"))
        ) {
            return { error: `${upload} has invalid content`, status: 400 };
        }
        mkdirSync(figuresDir, { recursive: true });
        const taken = new Map(readdirSync(figuresDir).map((f) => [figureName(f), f]));
        const ext = upload.slice(figureName(upload).length);
        let name = figureName(upload);
        for (let i = 2; taken.has(name); i += 1) {
            const existing = taken.get(name);
            if (
                existing === `${name}${ext}` &&
                readFileSync(join(figuresDir, existing)).equals(data)
            ) {
                return { file: existing };
            }
            name = `${figureName(upload)}-${i}`;
        }
        writeFileSync(join(figuresDir, `${name}${ext}`), data);
        return { file: `${name}${ext}` };
    };

    /** Files in figures/ (figure name → file). */
    const figureFiles = (): Map<string, string> =>
        new Map(
            existsSync(figuresDir)
                ? readdirSync(figuresDir).map((f) => [figureName(f), f] as const)
                : [],
        );

    /**
     * Deletes a figure. If a doc references it via :::figure, refuses without force and returns
     * referencedBy.
     */
    const removeFigure = (name: string, force = false): OpResult<{ file: string }> => {
        const file = figureFiles().get(name);
        if (!file) {
            return { error: `figure "${name}" not found`, status: 404 };
        }
        const translations = loadCatalogs();
        if (isOpError(translations)) return translations;
        const referencedBy = [
            ...new Set(
                [undefined, ...translations.catalogs.map(({ lang }) => lang)].flatMap((locale) =>
                    compileSite(root, { locale, defaultLang: "und" })
                        .artifact.docs.filter((d) => d.refs.figures.includes(name))
                        .map((d) => d.id),
                ),
            ),
        ];
        if (referencedBy.length > 0 && !force) {
            return {
                error: `${referencedBy.length} doc(s) reference it`,
                status: 409,
                referencedBy,
            };
        }
        unlinkSync(join(figuresDir, file));
        return { file };
    };

    return {
        contentDir,
        figuresDir,
        loadTree,
        referencingFiles,
        figureFiles,
        add,
        move,
        rename,
        remove,
        write,
        addFigure,
        removeFigure,
    };
};

export type DocOps = ReturnType<typeof createDocOps>;
