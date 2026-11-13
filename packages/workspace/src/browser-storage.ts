import { Buffer } from "buffer/";
import { fs } from "./browser-host.js";

export type FileSnapshot = Map<string, Uint8Array>;
type Directory = FileSystemDirectoryHandle & {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};
const same = (left?: Uint8Array, right?: Uint8Array): boolean =>
    left === undefined || right === undefined
        ? left === right
        : left.length === right.length && left.every((byte, i) => byte === right[i]);

export const readDirectory = async (
    directory: FileSystemDirectoryHandle,
): Promise<FileSnapshot> => {
    const files: FileSnapshot = new Map();
    let size = 0;
    const visit = async (handle: Directory, prefix = "") => {
        for await (const [name, item] of handle.entries()) {
            if (!name || name === "." || name === ".." || /[\\/\0]/.test(name))
                throw new Error("Invalid storage file name");
            const path = prefix + name;
            if (item.kind === "directory") await visit(item as Directory, `${path}/`);
            else {
                const file = await (item as FileSystemFileHandle).getFile();
                size += file.size;
                if (size > 128 * 1024 * 1024)
                    throw new Error("Workspace exceeds the browser's 128 MiB working limit");
                files.set(path, new Uint8Array(await file.arrayBuffer()));
            }
        }
    };
    await visit(directory as Directory);
    return files;
};

export const memoryFiles = (root: string): FileSnapshot => {
    const result: FileSnapshot = new Map();
    const visit = (directory: string, prefix = "") => {
        for (const name of fs.readdirSync(directory) as string[]) {
            const path = `${directory}/${name}`;
            const stat = fs.lstatSync(path);
            if (stat.isSymbolicLink()) throw new Error("Symbolic links require the Node server");
            if (stat.isDirectory()) visit(path, `${prefix}${name}/`);
            else
                result.set(`${prefix}${name}`, new Uint8Array(fs.readFileSync(path) as Uint8Array));
        }
    };
    if (fs.existsSync(root)) visit(root);
    return result;
};

export const replaceMemory = (root: string, files: FileSnapshot): void => {
    for (const file of files.keys()) {
        if (
            file
                .split("/")
                .some((part) => !part || part === "." || part === ".." || /[\\\0]/.test(part))
        )
            throw new Error("Invalid storage path");
        const parts = file.split("/");
        while (parts.length > 1) {
            parts.pop();
            if (files.has(parts.join("/")))
                throw new Error("Storage path is both a file and a directory");
        }
    }
    const before = memoryFiles(root);
    for (const path of before.keys()) if (!files.has(path)) fs.unlinkSync(`${root}/${path}`);
    for (const [path, data] of files) {
        if (same(before.get(path), data)) continue;
        const target = `${root}/${path}`;
        // Obsolete files are gone, so a directory blocking a new file contains only empty directories.
        if (fs.existsSync(target) && fs.statSync(target).isDirectory())
            fs.rmSync(target, { recursive: true });
        fs.mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
        fs.writeFileSync(target, Buffer.from(data));
    }
    fs.mkdirSync(root, { recursive: true });
};

const parentDirectory = async (root: FileSystemDirectoryHandle, path: string, create: boolean) => {
    const parts = path.split("/");
    if (parts.some((part) => !part || part === "." || part === ".." || /[\\\0]/.test(part)))
        throw new Error("Invalid storage path");
    const name = parts.pop();
    if (!name) throw new Error("Invalid storage path");
    let parent = root;
    for (const part of parts) parent = await parent.getDirectoryHandle(part, { create });
    return { parent, name };
};
const diskFile = async (
    root: FileSystemDirectoryHandle,
    path: string,
): Promise<Uint8Array | undefined> => {
    try {
        const { parent, name } = await parentDirectory(root, path, false);
        return new Uint8Array(
            await (await (await parent.getFileHandle(name)).getFile()).arrayBuffer(),
        );
    } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError") return undefined;
        throw error;
    }
};
const writeFile = async (root: FileSystemDirectoryHandle, path: string, bytes?: Uint8Array) => {
    const { parent, name } = await parentDirectory(root, path, bytes !== undefined);
    if (bytes === undefined) {
        await parent.removeEntry(name);
        return;
    }
    const previous = await diskFile(root, path);
    let writable: FileSystemWritableFileStream | undefined;
    try {
        writable = await (await parent.getFileHandle(name, { create: true })).createWritable();
        await writable.write(new Uint8Array(bytes));
        await writable.close();
    } catch (error) {
        await writable?.abort().catch(() => {});
        if (previous === undefined && (await diskFile(root, path))?.length === 0)
            await parent.removeEntry(name);
        throw error;
    }
};

export const changedFiles = (before: FileSnapshot, after: FileSnapshot): string[] => {
    return [...new Set([...before.keys(), ...after.keys()])].filter(
        (path) => !same(before.get(path), after.get(path)),
    );
};

/** Preflight every changed file and restore completed writes if a later write fails. */
export const persistFiles = async (
    root: FileSystemDirectoryHandle,
    before: FileSnapshot,
    after: FileSnapshot,
) => {
    const changed = changedFiles(before, after);
    for (const path of changed)
        if (!same(await diskFile(root, path), before.get(path)))
            throw new Error(`File changed outside dooc: ${path}. Reload before saving.`);
    const written: string[] = [];
    try {
        for (const path of changed) {
            await writeFile(root, path, after.get(path));
            written.push(path);
        }
    } catch (error) {
        const failed: string[] = [];
        for (const path of written.reverse()) {
            try {
                if (!same(await diskFile(root, path), after.get(path)))
                    throw new Error("Changed during recovery");
                await writeFile(root, path, before.get(path));
            } catch {
                failed.push(path);
            }
        }
        if (failed.length)
            throw new Error(
                `Saving failed; recovery requires attention for: ${failed.join(", ")}. ${String(error)}`,
            );
        throw error;
    }
};
