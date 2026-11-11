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
import { dirname, join, posix } from "node:path";
import {
    flattenTree,
    insertDoc,
    isDocId,
    moveDoc,
    type ParsedManifest,
    removeDoc,
    renameDoc,
    subformatPageId,
} from "../core/content-metadata.js";
import {
    defaultFilePath,
    docIconFile,
    fileDocumentId,
    isDocumentFileName,
    parseFileLayout,
} from "../core/files.js";
import { parseDocLink } from "../core/routing.js";
import { collectDocLinks, compileSite } from "./compile.js";
import { figureName, figureUploadName } from "./figures.js";
import { filesSnapshot, projectFiles, rewriteFileLinks, updateFiles } from "./files.js";
import { translationFile, translationFiles, translationLanguages } from "./locales.js";
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

    // Read before rewriting dooc.yaml. If it's broken, don't write (= don't clobber
    // hand-written content).
    const loadTree = (): OpResult<ParsedManifest> => {
        const manifest = readManifest(root);
        return manifest.errors.length > 0
            ? { error: manifest.errors.join(" / "), status: 409 }
            : manifest;
    };

    const existingDoc = (id: unknown): OpResult<{ id: string }> =>
        typeof id === "string" &&
        isDocId(id) &&
        !flattenTree(readManifest(root).tree).some((node) => node.id === id && node.subformat) &&
        existsSync(docPath(id))
            ? { id }
            : { error: `doc "${String(id)}" not found`, status: 404 };

    // Include extracted callout sources and unregistered Markdown files in reference checks.
    const referenceFiles = (): string[] =>
        [...projectFiles(root).map((file) => file.path), ...translationFiles(root)].filter((file) =>
            /\.(md|callouth)$/.test(file),
        );
    const referencingFiles = (id: string, removed: readonly string[]): string[] => {
        const target = docFile(id, readManifest(root).files);
        return referenceFiles()
            .filter(
                (file) =>
                    !removed.includes(file) &&
                    collectDocLinks(readFileSync(textfilePath(root, file), "utf8")).some(
                        (url) => parseDocLink(url)?.file === target,
                    ),
            )
            .map((file) => file.replace(/^content\//, ""));
    };

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
        if (loaded.format === "nested") {
            const file =
                loaded.files?.defaultLayout !== false
                    ? defaultFilePath(filename ?? `${id}.md`)
                    : `content/${filename ?? `${id}.md`}`;
            id = fileDocumentId(file);
            loaded.files ??= parseFileLayout({});
            loaded.files.documents[id] = file;
        }
        const tree = insertDoc(loaded.tree, id, parent);
        if (!tree) {
            return { error: `duplicate id "${id}" or missing parent "${parent}"`, status: 409 };
        }
        if (
            loaded.format !== "nested" &&
            (filename !== undefined || loaded.files?.defaultLayout !== false)
        ) {
            loaded.files ??= parseFileLayout({});
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

    const addSubformat = (
        ext: string,
        title: string,
        parent?: string,
    ): OpResult<{ id: string }> => {
        const loaded = loadTree();
        if (isOpError(loaded)) return loaded;
        if (!loaded.subformats?.some((format) => format.ext === ext) || !title.trim())
            return { error: "Choose an existing subformat and enter a title", status: 400 };
        const id = subformatPageId(ext);
        const tree = insertDoc(loaded.tree, id, parent, { subformat: ext, title: title.trim() });
        if (!tree) return { error: "Page already exists or parent is missing", status: 409 };
        writeManifest(root, tree, loaded);
        return { id };
    };

    const renameSubformat = (id: string, title: string): OpResult<{ id: string }> => {
        const loaded = loadTree();
        if (isOpError(loaded)) return loaded;
        if (!title.trim()) return { error: "title is required", status: 400 };
        const visit = (nodes: typeof loaded.tree): boolean =>
            nodes.some((node) => {
                if (node.id === id && node.subformat) {
                    node.title = title.trim();
                    return true;
                }
                return visit(node.children);
            });
        if (!visit(loaded.tree)) return { error: "Subformat page not found", status: 404 };
        writeManifest(root, loaded.tree, loaded);
        return { id };
    };

    /**
     * Reorders and reparents. Rewrites only dooc.yaml. Omitted index = after the last child
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
     * Renames content/<old>.md and updates the manifest id and the file links (exact match) in
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
        const manifest = readManifest(root);
        if (manifest.format === "nested") {
            const name = newId.endsWith(".md") ? newId : `${newId}.md`;
            if (!isDocumentFileName(name))
                return { error: "Enter a Markdown file name", status: 400 };
            try {
                const file = docFile(oldId, manifest.files);
                const next = posix.join(posix.dirname(file), name);
                const moves = new Map([[file, next]]);
                const updatedRefs = referenceFiles().filter((path) => {
                    const raw = readFileSync(textfilePath(root, path), "utf8");
                    return rewriteFileLinks(raw, moves) !== raw;
                }).length;
                updateFiles(root, {
                    action: "rename",
                    file,
                    name,
                    revision: filesSnapshot(root).revision,
                });
                return {
                    id: fileDocumentId(next),
                    updatedRefs,
                };
            } catch (error) {
                return {
                    error: error instanceof Error ? error.message : String(error),
                    status: 409,
                };
            }
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
            return { error: "doc is not in dooc.yaml", status: 404 };
        }
        const oldFile = docFile(oldId, loaded.files);
        const mapped = loaded.files && Object.hasOwn(loaded.files.documents, oldId);
        const newFile = mapped ? oldFile : docFile(newId, loaded.files);
        const moves = new Map(oldFile === newFile ? [] : [[oldFile, newFile]]);
        try {
            for (const language of translationLanguages(root)) {
                const from = translationFile(oldFile, language);
                const to = translationFile(newFile, language);
                if (from === to) continue;
                if (existsSync(textfilePath(root, to)))
                    return { error: `translation file "${to}" already exists`, status: 409 };
                if (existsSync(textfilePath(root, from))) moves.set(from, to);
            }
        } catch (error) {
            return { error: String(error), status: 409 };
        }
        const writes: { file: string; body: string }[] = [];
        let updatedRefs = 0;
        // Validate every rewrite before renaming files or changing the manifest.
        try {
            for (const file of referenceFiles()) {
                const raw = readFileSync(textfilePath(root, file), "utf8");
                const body = rewriteFileLinks(raw, moves);
                if (body !== raw) {
                    writes.push({ file: moves.get(file) ?? file, body });
                    updatedRefs++;
                }
            }
        } catch (error) {
            return { error: error instanceof Error ? error.message : String(error), status: 409 };
        }
        if (loaded.files && Object.hasOwn(loaded.files.documents, oldId)) {
            loaded.files.documents[newId] = docFile(oldId, loaded.files);
            delete loaded.files.documents[oldId];
        } else renameSync(docPath(oldId), docPath(newId));
        if (loaded.files?.icons && Object.hasOwn(loaded.files.icons, oldId)) {
            loaded.files.icons[newId] = docIconFile(oldId, loaded.files);
            delete loaded.files.icons[oldId];
        } else if (existsSync(iconPath(oldId))) renameSync(iconPath(oldId), iconPath(newId));
        for (const [from, to] of moves) {
            if (from === oldFile) continue;
            const path = textfilePath(root, to);
            mkdirSync(dirname(path), { recursive: true });
            renameSync(textfilePath(root, from), path);
        }
        writeManifest(root, tree, loaded);
        for (const { file, body } of writes) writeFileSync(textfilePath(root, file), body);
        return { id: newId, updatedRefs };
    };

    /**
     * Removes the doc from the manifest and deletes the .md (and icon). Docs with children are
     * not deleted. If other docs reference it via file links, refuses without force and returns
     * referencedBy. parent = the deleted doc's parent.
     */
    const remove = (
        id: string,
        force = false,
    ): OpResult<{ parent: string | undefined; danglingRefs: number }> => {
        const manifest = loadTree();
        if (isOpError(manifest)) return manifest;
        const page = flattenTree(manifest.tree).find((node) => node.id === id && node.subformat);
        if (page) {
            const tree = removeDoc(manifest.tree, id);
            if (!tree) return { error: "doc has children (move / delete them first)", status: 409 };
            const removedIcon = iconPath(id);
            if (manifest.files?.icons) delete manifest.files.icons[id];
            writeManifest(root, tree, manifest);
            if (existsSync(removedIcon)) unlinkSync(removedIcon);
            return { parent: page.parent, danglingRefs: 0 };
        }
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
        const file = docFile(id, loaded.files);
        let removed: string[];
        let referencedBy: string[];
        try {
            removed = [
                file,
                ...translationLanguages(root).map((lang) => translationFile(file, lang)),
            ];
            for (const file of removed) textfilePath(root, file);
            referencedBy = referencingFiles(id, removed);
        } catch (error) {
            return { error: String(error), status: 409 };
        }
        if (referencedBy.length > 0 && !force) {
            return {
                error: `${referencedBy.length} doc(s) reference it via file links`,
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
        }
        writeManifest(root, tree, loaded);
        unlinkSync(removedPath);
        if (existsSync(removedIcon)) {
            unlinkSync(removedIcon);
        }
        for (const file of removed.slice(1)) {
            const path = textfilePath(root, file);
            if (existsSync(path)) unlinkSync(path);
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
        if (manifest.files?.defaultLayout !== false) {
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
     * Deletes a figure. If a doc references it via a Markdown link or embed, refuses without force and returns
     * referencedBy.
     */
    const removeFigure = (name: string, force = false): OpResult<{ file: string }> => {
        const file = figureFiles().get(name);
        if (!file) {
            return { error: `figure "${name}" not found`, status: 404 };
        }
        const referencedBy = [
            ...new Set(
                [undefined, ...translationLanguages(root)].flatMap((locale) =>
                    compileSite(root, { locale, defaultLang: "und" })
                        .docs.filter((d) => d.refs.figures.includes(name))
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
        addSubformat,
        renameSubformat,
        move,
        rename,
        remove,
        write,
        addFigure,
        removeFigure,
    };
};

export type DocOps = ReturnType<typeof createDocOps>;
