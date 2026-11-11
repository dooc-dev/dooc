import { createHash, randomUUID } from "node:crypto";
import {
    existsSync,
    linkSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmdirSync,
    rmSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import { visit } from "unist-util-visit";
import { Document, isSeq, parseDocument } from "yaml";
import { flattenTree, MANIFEST_FILE, serializeManifest } from "../core/content-metadata.js";
import {
    defaultFilePath,
    docFile,
    docIconFile,
    type FileLayout,
    fileExtension,
    isDocumentFileName,
    localFile,
    MAX_FILE_UPLOAD_BYTES,
    parseFileLayout,
} from "../core/files.js";
import { codeBlockAt, parseMdast } from "../core/markdown.js";
import { docPath } from "../core/routing.js";
import { termFileUrl } from "../core/term-reference.js";
import { isRemoteTextfile, parseFileReference } from "../core/textfile.js";
import { assetReferences } from "./asset-references.js";
import { fileSig } from "./file-cache.js";
import { ignoredFiles } from "./ignored-files.js";
import { translationFile, translationFiles, translationLanguages } from "./locales.js";
import { readManifest } from "./manifest.js";
import { textfilePath, writeTextfile } from "./textfile.js";
import { themeNames, themeVariants } from "./theme-variants.js";

// Project settings and translations have their own layout, outside file restructuring.
const reserved = new Set([MANIFEST_FILE, "docs.config.mjs", "node_modules", "dist", "locales"]);
export const managedFile = (file: string): boolean =>
    localFile(file) && !reserved.has(file.split("/")[0] ?? "");

export interface ProjectFile {
    path: string;
    size: number;
    extension: string;
}

const names = new Intl.Collator("en", { numeric: true });
const compareFilePaths = (a: string, b: string): number => {
    const left = a.split("/");
    const right = b.split("/");
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
        const first = left[i] as string;
        const second = right[i] as string;
        if (first === second) continue;
        return (
            Number(i < right.length - 1) - Number(i < left.length - 1) ||
            names.compare(first, second) ||
            (first < second ? -1 : 1)
        );
    }
    return left.length - right.length;
};

export const completeFilePaths = (root: string, prefix: unknown): string[] => {
    if (typeof prefix !== "string" || prefix.length > 4096) throw new Error("Invalid file prefix");
    const slash = prefix.lastIndexOf("/");
    const directory = prefix.slice(0, slash + 1);
    if (prefix && !managedFile(prefix.replace(/\/$/, "")))
        throw new Error("Expected a relative project path");
    const path = directory ? textfilePath(root, directory) : root;
    if (!existsSync(path)) return [];
    const entries = readdirSync(path, { withFileTypes: true })
        .filter(
            (entry) =>
                !entry.isSymbolicLink() &&
                (entry.isFile() || entry.isDirectory()) &&
                managedFile(directory + entry.name) &&
                (directory + entry.name).toLowerCase().startsWith(prefix.toLowerCase()),
        )
        .map((entry) => directory + entry.name + (entry.isDirectory() ? "/" : ""));
    const ignored = ignoredFiles(root, entries);
    return entries
        .filter((file) => !ignored.has(file))
        .sort(compareFilePaths)
        .slice(0, 200);
};
export const projectFiles = (root: string): ProjectFile[] => {
    const result: ProjectFile[] = [];
    const walk = (directory: string) => {
        for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
            const path = directory ? `${directory}/${entry.name}` : entry.name;
            if (!managedFile(path) || entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) walk(path);
            else if (entry.isFile())
                result.push({
                    path,
                    size: statSync(textfilePath(root, path)).size,
                    extension: fileExtension(path),
                });
        }
    };
    walk("");
    const ignored = ignoredFiles(
        root,
        result.map((file) => file.path),
    );
    return result
        .filter((file) => !ignored.has(file.path))
        .sort((a, b) => compareFilePaths(a.path, b.path));
};

export const filesSnapshot = (root: string) => {
    const manifest = readManifest(root);
    if (manifest.errors.length) throw new Error(manifest.errors.join("\n"));
    const files = projectFiles(root);
    const layout: FileLayout = manifest.files ?? parseFileLayout({});
    const hash = createHash("sha256");
    hash.update(
        existsSync(join(root, MANIFEST_FILE)) ? readFileSync(join(root, MANIFEST_FILE)) : "",
    );
    for (const file of files)
        hash.update(file.path)
            .update(String(statSync(textfilePath(root, file.path)).mtimeMs))
            .update(String(file.size));
    for (const file of translationFiles(root))
        hash.update(file).update(fileSig(textfilePath(root, file)));
    const docs = flattenTree(manifest.tree);
    return {
        files,
        layout,
        revision: hash.digest("hex"),
        documents: Object.fromEntries(
            docs
                .filter((node) => !node.subformat)
                .map(({ id }) => [docFile(id, layout), docPath(docs, id)]),
        ),
    };
};

export const uploadFile = (root: string, input: Record<string, unknown>): { file: string } => {
    if (typeof input.name !== "string" || !managedFile(input.name) || input.name.includes("/"))
        throw new Error("Invalid file name");
    if (typeof input.data !== "string") throw new Error("Invalid file content");
    const data = Buffer.from(input.data, "base64");
    if (data.length > MAX_FILE_UPLOAD_BYTES) throw new Error("File exceeds 64 MiB");
    if (data.toString("base64") !== input.data) throw new Error("Invalid file content");
    const manifest = readManifest(root);
    if (manifest.errors.length) throw new Error(manifest.errors.join("\n"));
    const initial =
        manifest.files?.defaultLayout !== false ? defaultFilePath(input.name) : input.name;
    const extension = posix.extname(initial);
    const stem = initial.slice(0, initial.length - extension.length);
    let file = initial;
    for (let index = 2; existsSync(textfilePath(root, file)); index++)
        file = `${stem}-${index}${extension}`;
    const path = textfilePath(root, file);
    mkdirSync(dirname(path), { recursive: true });
    const temp = join(dirname(path), `.upload-${randomUUID()}.tmp`);
    try {
        writeFileSync(temp, data, { flag: "wx" });
        linkSync(temp, path);
    } finally {
        rmSync(temp, { force: true });
    }
    return { file };
};

const imageDestination = (source: string): number => {
    let depth = 0;
    for (let i = source.indexOf("["); i < source.length; i++) {
        const char = source[i];
        if (char === "\\") {
            i++;
            continue;
        }
        if (char === "`") {
            const marker = /^`+/.exec(source.slice(i))?.[0] ?? "`";
            const end = source.indexOf(marker, i + marker.length);
            if (end >= 0) {
                i = end + marker.length - 1;
                continue;
            }
        }
        if (char === "[") depth++;
        if (char === "]" && --depth === 0) return source[i + 1] === "(" ? i + 2 : -1;
    }
    return -1;
};

/** Rewrite destinations only: examples, labels, titles and code stay byte-for-byte intact. */
export const rewriteFileLinks = (raw: string, moves: ReadonlyMap<string, string>): string => {
    if (!moves.size) return raw;
    const changes: { from: number; to: number; text: string }[] = [];
    visit(parseMdast(raw), (node) => {
        if (node.type === "code" && node.lang === "callouth" && node.position) {
            const block = codeBlockAt(raw, node.position.start.offset ?? 0);
            const before = block.code.split("\n");
            const after = rewriteFileLinks(block.code, moves).split("\n");
            for (const [index, text] of after.entries()) {
                const from = block.offsets[index];
                if (text !== before[index] && from !== undefined)
                    changes.push({ from, to: from + (before[index]?.length ?? 0), text });
            }
        }
        if (node.type !== "image" && node.type !== "link" && node.type !== "definition") return;
        let file: string;
        try {
            file = parseFileReference(node.url).file.replace(/^(\.\/)+/, "");
        } catch {
            return;
        }
        if (isRemoteTextfile(file)) return;
        const next = moves.get(file);
        if (!next) return;
        const from = node.position?.start.offset;
        const to = node.position?.end.offset;
        if (from === undefined || to === undefined)
            throw new Error(`Cannot update reference: ${node.url}`);
        const source = raw.slice(from, to);
        const head =
            node.type === "definition"
                ? /^\[[\s\S]*?\]:\s*/.exec(source)?.[0].length
                : node.type === "image"
                  ? imageDestination(source)
                  : source.indexOf(
                        "](",
                        Math.max(0, (node.children.at(-1)?.position?.end.offset ?? from) - from),
                    ) + 2;
        if (!head || head < 2) throw new Error(`Cannot update reference: ${node.url}`);
        const start = head + (source.slice(head).match(/^\s*/)?.[0].length ?? 0);
        let end = start;
        if (source[start] === "<") end = source.indexOf(">", start) + 1;
        else {
            let depth = 0;
            for (; end < source.length; end++) {
                const ch = source[end];
                if (ch === "\\") {
                    end++;
                    continue;
                }
                if (ch === "(") depth++;
                if (ch === ")") {
                    if (!depth) break;
                    depth--;
                }
                if (/\s/.test(ch ?? "")) break;
            }
        }
        if (end <= start) throw new Error(`Cannot update reference: ${node.url}`);
        const check = parseMdast(`[x](${source.slice(start, end)})`).children[0];
        if (
            check?.type !== "paragraph" ||
            check.children[0]?.type !== "link" ||
            check.children[0].url !== node.url
        )
            throw new Error(`Cannot update reference: ${node.url}`);
        const fragment = node.url.includes("#") ? node.url.slice(node.url.indexOf("#")) : "";
        changes.push({ from: from + start, to: from + end, text: termFileUrl(next) + fragment });
    });
    for (const change of changes.sort((a, b) => b.from - a.from))
        raw = raw.slice(0, change.from) + change.text + raw.slice(change.to);
    return raw;
};

export const updateFiles = (root: string, input: Record<string, unknown>) => {
    const snapshot = filesSnapshot(root);
    if (input.revision !== snapshot.revision)
        throw new Error("Files changed. Reload before retrying.");
    const manifest = readManifest(root);
    const layout = snapshot.layout;
    const paths = snapshot.files.map((file) => file.path);
    const moves = new Map<string, string>();
    if (input.action === "layout") {
        if (typeof input.enabled !== "boolean") throw new Error("Invalid layout setting");
        layout.defaultLayout = input.enabled;
    } else if (input.action === "restructure") {
        const taken = new Set(paths);
        for (const file of paths) {
            if (file.startsWith("themes/")) continue;
            let target = defaultFilePath(file);
            if (target === file) continue;
            const ext = posix.extname(target);
            const stem = target.slice(0, target.length - ext.length);
            for (let index = 2; taken.has(target); index++) target = `${stem}-${index}${ext}`;
            taken.add(target);
            moves.set(file, target);
        }
    } else if (input.action === "rename") {
        if (typeof input.file !== "string" || !paths.includes(input.file))
            throw new Error("File not found");
        if (!localFile(input.name) || input.name.includes("/"))
            throw new Error("Invalid file name");
        if (
            flattenTree(manifest.tree).some(
                ({ id, subformat }) => !subformat && docFile(id, layout) === input.file,
            ) &&
            !isDocumentFileName(input.name)
        )
            throw new Error("Enter a file name ending in .md");
        const target = posix.join(posix.dirname(input.file), input.name);
        if (!managedFile(target)) throw new Error("Invalid file name");
        if (target !== input.file) moves.set(input.file, target);
    } else if (input.action === "move") {
        if (
            !Array.isArray(input.paths) ||
            !input.paths.length ||
            input.paths.some((path) => !managedFile(path)) ||
            typeof input.directory !== "string" ||
            (input.directory && !managedFile(input.directory))
        )
            throw new Error("Invalid move");
        const selected = (input.paths as string[]).filter(
            (path, i, all) => !all.some((parent, j) => i !== j && path.startsWith(`${parent}/`)),
        );
        const directory = input.directory;
        const picked = paths.filter((path) =>
            selected.some((item) => path === item || path.startsWith(`${item}/`)),
        );
        if (
            !picked.length ||
            selected.some(
                (path) => !picked.some((file) => file === path || file.startsWith(`${path}/`)),
            )
        )
            throw new Error("File not found");
        for (const item of selected) {
            if (directory === item || directory.startsWith(`${item}/`))
                throw new Error("Cannot move a folder into itself");
            const target = directory
                ? `${directory}/${posix.basename(item)}`
                : posix.basename(item);
            if (
                manifest.defaultSubformatFolder === item ||
                manifest.defaultSubformatFolder?.startsWith(`${item}/`)
            )
                manifest.defaultSubformatFolder =
                    target + manifest.defaultSubformatFolder.slice(item.length);
            for (const file of picked.filter(
                (path) => path === item || path.startsWith(`${item}/`),
            )) {
                const next = target + file.slice(item.length);
                if (next !== file) moves.set(file, next);
            }
        }
    } else throw new Error("Unknown file action");
    for (const [source, target] of [...moves]) {
        for (const [theme, file] of Object.entries(themeVariants(root, source, themeNames(root))))
            moves.set(file, `themes/${theme}/${target}`);
    }
    const translated = translationFiles(root);
    for (const language of translationLanguages(root)) {
        for (const [source, target] of [...moves]) {
            if (!source.endsWith(".md") || source.startsWith("locales/")) continue;
            const file = translationFile(source, language);
            if (translated.includes(file)) moves.set(file, translationFile(target, language));
        }
    }
    if (new Set(moves.values()).size !== moves.size) throw new Error("Duplicate destination");
    for (const target of moves.values()) {
        const path = textfilePath(root, target);
        if (existsSync(path)) throw new Error(`File already exists: ${target}`);
    }
    for (const { id, subformat } of flattenTree(manifest.tree)) {
        if (subformat) continue;
        const file = docFile(id, layout);
        if (moves.has(file)) layout.documents[id] = moves.get(file) as string;
        const icon = docIconFile(id, layout);
        if (moves.has(icon)) {
            layout.icons ??= {};
            layout.icons[id] = moves.get(icon) as string;
        }
    }
    const rawManifest = existsSync(join(root, MANIFEST_FILE))
        ? readFileSync(join(root, MANIFEST_FILE), "utf8")
        : null;
    const parsed = parseDocument(rawManifest ?? "docs: []\n");
    const yaml = isSeq(parsed.contents) ? new Document({ docs: parsed.toJS() }) : parsed;
    manifest.files = layout;
    if (manifest.icon && moves.has(manifest.icon)) manifest.icon = moves.get(manifest.icon);
    if (manifest.themeIcons)
        for (const [theme, file] of Object.entries(manifest.themeIcons))
            manifest.themeIcons[theme] = moves.get(file) ?? file;
    for (const subformat of manifest.subformats ?? [])
        subformat.schema = moves.get(subformat.schema) ?? subformat.schema;
    if (manifest.format !== "nested") {
        yaml.set("files", layout);
        if (manifest.icon) yaml.set("icon", manifest.icon);
        if (manifest.subformats) yaml.set("subformats", manifest.subformats);
        if (manifest.defaultSubformatFolder)
            yaml.set("default_subformat_folder", manifest.defaultSubformatFolder);
    }
    const writes: { file: string; data: Buffer; base: Buffer | null; mode?: number }[] = [];
    const links = new Map(moves);
    for (const file of [...paths, ...translated].filter((file) =>
        /\.(md|callouth|html|htm|svg|css)$/.test(file),
    )) {
        const base = readFileSync(textfilePath(root, file));
        const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(base);
        const next = /\.(md|callouth)$/.test(file)
            ? rewriteFileLinks(raw, moves)
            : moves.size
              ? assetReferences(raw, fileExtension(file), (url) => {
                    if (!url || /^(?:[a-z][\w+.-]*:|[/#])/i.test(url)) return url;
                    const path = decodeURIComponent(url.split(/[?#]/)[0] ?? "");
                    if (!path) return url;
                    const source = posix.normalize(posix.join(posix.dirname(file), path));
                    const target = moves.get(source) ?? source;
                    const owner = moves.get(file) ?? file;
                    if (target === source && posix.dirname(owner) === posix.dirname(file))
                        return url;
                    const relative = posix.relative(posix.dirname(owner), target);
                    return (
                        relative.split("/").map(encodeURIComponent).join("/") +
                        url.slice(url.search(/[?#]|$/))
                    );
                })
              : raw;
        const data = Buffer.from(next);
        if (base.equals(data)) continue;
        links.delete(file);
        const target = moves.get(file) ?? file;
        writes.push({
            file: target,
            data,
            base: target === file ? base : null,
            mode: statSync(textfilePath(root, file)).mode,
        });
    }
    writes.push({
        file: MANIFEST_FILE,
        base: rawManifest === null ? null : Buffer.from(rawManifest),
        data: Buffer.from(
            manifest.format === "nested"
                ? serializeManifest(manifest.tree, manifest)
                : yaml.toString(),
        ),
    });
    const originalModes = new Map(
        [...moves.keys()].map((file) => [file, statSync(textfilePath(root, file)).mode]),
    );
    const originals = new Map(
        [...moves.keys()].map((file) => [
            file,
            {
                signature: fileSig(textfilePath(root, file)),
                data: links.has(file) ? undefined : readFileSync(textfilePath(root, file)),
            },
        ]),
    );
    const linked: [string, string][] = [];
    const completed: typeof writes = [];
    const removed: string[] = [];
    try {
        for (const [source, target] of links) {
            const destination = textfilePath(root, target);
            mkdirSync(dirname(destination), { recursive: true });
            linkSync(textfilePath(root, source), destination);
            linked.push([source, target]);
        }
        for (const write of writes) {
            const path = textfilePath(root, write.file);
            mkdirSync(dirname(path), { recursive: true });
            if (write.base === null)
                writeFileSync(path, write.data, { flag: "wx", mode: write.mode });
            else if (
                !writeTextfile(
                    root,
                    write.file,
                    write.data.toString("utf8"),
                    write.base.toString("utf8"),
                )
            )
                throw new Error(`File changed: ${write.file}`);
            completed.push(write);
        }
        for (const [file, base] of originals) {
            if (fileSig(textfilePath(root, file)) !== base.signature)
                throw new Error(`File changed: ${file}`);
        }
        for (const file of originals.keys()) {
            unlinkSync(textfilePath(root, file));
            removed.push(file);
        }
    } catch (error) {
        for (const file of removed) {
            const original = originals.get(file);
            if (original?.data)
                writeFileSync(textfilePath(root, file), original.data, {
                    flag: "wx",
                    mode: originalModes.get(file),
                });
            else linkSync(textfilePath(root, moves.get(file) as string), textfilePath(root, file));
        }
        for (const write of completed.reverse()) {
            const path = textfilePath(root, write.file);
            if (!readFileSync(path).equals(write.data)) continue;
            if (write.base === null) unlinkSync(path);
            else writeFileSync(path, write.base);
        }
        for (const [source, target] of linked) {
            const src = textfilePath(root, source);
            const dest = textfilePath(root, target);
            if (existsSync(dest) && statSync(src).ino === statSync(dest).ino) unlinkSync(dest);
        }
        throw error;
    }
    for (const file of moves.keys()) {
        let dir = posix.dirname(file);
        while (dir !== ".") {
            try {
                rmdirSync(join(root, dir));
            } catch {
                break;
            }
            dir = posix.dirname(dir);
        }
    }
    return filesSnapshot(root);
};
