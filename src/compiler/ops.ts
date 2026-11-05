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
import { dirname, join } from "node:path";
import {
    flattenTree,
    insertDoc,
    isDocId,
    moveDoc,
    type ParsedManifest,
    removeDoc,
    renameDoc,
} from "../core/content-metadata.js";
import { defaultFilePath, docIconFile, isDocumentFileName } from "../core/files.js";
import { parseDocLink } from "../core/routing.js";
import { collectDocLinks, compileSite, rewriteDocLinks } from "./compile.js";
import { figureName, figureUploadName } from "./figures.js";
import { catalogLanguages, readCatalog, writeCatalog } from "./locales.js";
import { docFile, readManifest, writeManifest } from "./manifest.js";
import { assembleDoc } from "./serialize.js";
import { textfilePath } from "./textfile.js";

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
    const figuresDir = join(root, "figures");
    const docPath = (id: string): string =>
        textfilePath(root, docFile(id, readManifest(root).files));
    const iconPath = (id: string): string =>
        textfilePath(root, docIconFile(id, readManifest(root).files));

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
    const loadTree = (): OpResult<ParsedManifest> => {
        const manifest = readManifest(root);
        return manifest.errors.length > 0
            ? { error: manifest.errors.join(" / "), status: 409 }
            : manifest;
    };

    const existingDoc = (id: unknown): OpResult<{ id: string }> =>
        typeof id === "string" && isDocId(id) && existsSync(docPath(id))
            ? { id }
            : { error: `doc "${String(id)}" not found`, status: 404 };

    // Files whose body text references id via a doc: link (<id>.md directly under content/,
    // excluding the doc itself).
    const referencingFiles = (id: string): string[] =>
        flattenTree(readManifest(root).tree)
            .filter((doc) => doc.id !== id)
            .filter((doc) =>
                collectDocLinks(readFileSync(docPath(doc.id), "utf8")).some(
                    (url) => parseDocLink(url) === id,
                ),
            )
            .map((doc) => `${doc.id}.md`);

    /** Creates a document and appends it as the last child of parent. */
    const add = (
        id: string,
        title: string,
        parent?: string,
        filename?: string,
    ): OpResult<{ id: string }> => {
        if (!title) {
            return { error: "title is required", status: 400 };
        }
        if (!isDocId(id)) {
            return { error: "id must be lowercase alphanumerics and hyphens", status: 400 };
        }
        if (filename !== undefined && !isDocumentFileName(filename))
            return { error: "Enter a file name ending in .md", status: 400 };
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
        if (filename !== undefined || loaded.files?.defaultLayout) {
            loaded.files ??= { defaultLayout: false, documents: {}, order: [] };
            loaded.files.documents[id] = loaded.files.defaultLayout
                ? defaultFilePath(filename ?? `${id}.md`)
                : `content/${filename}`;
        }
        const file = textfilePath(root, docFile(id, loaded.files));
        if (existsSync(file)) return { error: "File already exists", status: 409 };
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, assembleDoc({ title }, ""), { flag: "wx" });
        writeManifest(root, tree, loaded);
        return { id };
    };

    const addFile = (name: string, title: string, parent?: string): OpResult<{ id: string }> => {
        if (!isDocumentFileName(name))
            return { error: "Enter a file name ending in .md", status: 400 };
        const loaded = loadTree();
        if (isOpError(loaded)) return loaded;
        const ids = new Set(flattenTree(loaded.tree).map((doc) => doc.id));
        const stem =
            name
                .slice(0, -3)
                .normalize("NFKD")
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "") || "doc";
        let id = stem;
        for (let index = 2; ids.has(id) || existsSync(docPath(id)); index++)
            id = `${stem}-${index}`;
        return add(id, title, parent, name);
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
        writeManifest(root, tree, loaded);
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
        if (loaded.files && Object.hasOwn(loaded.files.documents, oldId)) {
            loaded.files.documents[newId] = docFile(oldId, loaded.files);
            delete loaded.files.documents[oldId];
        } else renameSync(docPath(oldId), docPath(newId));
        if (loaded.files?.icons && Object.hasOwn(loaded.files.icons, oldId)) {
            loaded.files.icons[newId] = docIconFile(oldId, loaded.files);
            delete loaded.files.icons[oldId];
        } else if (existsSync(iconPath(oldId))) renameSync(iconPath(oldId), iconPath(newId));
        writeManifest(root, tree, loaded);
        let updatedRefs = 0;
        for (const { id } of flattenTree(tree)) {
            const p = docPath(id);
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
        const removedPath = docPath(id);
        const removedIcon = iconPath(id);
        if (loaded.files) {
            delete loaded.files.documents[id];
            if (loaded.files.icons) delete loaded.files.icons[id];
            loaded.files.order = loaded.files.order.filter(
                (file) => join(root, file) !== removedPath,
            );
        }
        writeManifest(root, tree, loaded);
        unlinkSync(removedPath);
        if (existsSync(removedIcon)) {
            unlinkSync(removedIcon);
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
    const addFigure = (file: string, data: Buffer): OpResult<{ file: string; path?: string }> => {
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
        const manifest = loadTree();
        if (isOpError(manifest)) return manifest;
        if (manifest.files?.defaultLayout) {
            const initial = defaultFilePath(upload);
            let path = initial;
            const ext = upload.slice(figureName(upload).length);
            for (let i = 2; existsSync(textfilePath(root, path)); i++) {
                if (readFileSync(textfilePath(root, path)).equals(data))
                    return { file: path.split("/").pop() as string, path };
                path = `${initial.slice(0, -ext.length)}-${i}${ext}`;
            }
            const target = textfilePath(root, path);
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, data, { flag: "wx" });
            return { file: path.split("/").pop() as string, path };
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
            compileSite(root).figures.map((f) => [
                f.name,
                f.file.startsWith("figures/") ? f.file.slice(8) : f.file,
            ]),
        );

    /**
     * Deletes a figure. If a doc references it via a Markdown embed, refuses without force and returns
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
        unlinkSync(textfilePath(root, file.includes("/") ? file : `figures/${file}`));
        return { file };
    };

    return {
        contentDir: join(root, "content"),
        figuresDir,
        loadTree,
        referencingFiles,
        figureFiles,
        add,
        addFile,
        move,
        rename,
        remove,
        write,
        addFigure,
        removeFigure,
    };
};

export type DocOps = ReturnType<typeof createDocOps>;
