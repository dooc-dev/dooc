import {
    type ExtensionFile,
    type ExtensionSummary,
    extensionFile,
    extensionManifest,
    MAX_EXTENSION_BYTES,
    readExtensionZip,
} from "../core/extension-package.js";

export interface StoredExtension {
    file: string;
    hash: string;
    files: ExtensionFile[];
}
export const extensionBase64 = (bytes: Uint8Array): string => {
    let value = "";
    for (let offset = 0; offset < bytes.length; offset += 8192)
        value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(value);
};
export const extensionBytes = (value: string): Uint8Array =>
    Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
export const readBrowserExtension = (bytes: Uint8Array) =>
    readExtensionZip(bytes, async (data, size) => {
        const stream = new Blob([new Uint8Array(data)])
            .stream()
            .pipeThrough(new DecompressionStream("deflate-raw"));
        const reader = stream.getReader();
        const result = new Uint8Array(size);
        let offset = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (offset + value.length > size) throw new Error("Invalid plugin ZIP size");
                result.set(value, offset);
                offset += value.length;
            }
            if (offset !== size) throw new Error("Invalid plugin ZIP size");
            return result;
        } finally {
            await reader.cancel();
        }
    });

const database = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
        const request = indexedDB.open("dooc-extensions", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("packages");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("Close other dooc tabs to open plugin storage"));
    });
const records = async (scope: string): Promise<StoredExtension[]> => {
    const db = await database();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction("packages");
            const request = transaction
                .objectStore("packages")
                .getAll(IDBKeyRange.bound(`${scope}/`, `${scope}/\uffff`));
            transaction.oncomplete = () => resolve(request.result);
            transaction.onabort = () => reject(transaction.error);
        });
    } finally {
        db.close();
    }
};
const commit = async (scope: string, file: string, base: unknown, next?: StoredExtension) => {
    const db = await database();
    try {
        await new Promise<void>((resolve, reject) => {
            const transaction = db.transaction("packages", "readwrite");
            const store = transaction.objectStore("packages");
            const key = `${scope}/${file}`;
            const request = store.get(key);
            request.onsuccess = () => {
                if ((request.result?.hash ?? null) !== base) {
                    reject(new Error("Plugin changed. Reopen it before saving."));
                    transaction.abort();
                } else if (next) store.put(next, key);
                else store.delete(key);
            };
            transaction.oncomplete = () => resolve();
            transaction.onabort = () =>
                reject(transaction.error ?? new Error("Plugin storage failed"));
        });
    } finally {
        db.close();
    }
};
export const browserExtensionRequest = async (
    scope: string,
    input: Record<string, unknown>,
): Promise<unknown> => {
    const stored = await records(scope);
    const list = (items: StoredExtension[]) => ({
        scope,
        items: items
            .map((item): ExtensionSummary => {
                const pkg = extensionManifest(item.files);
                return {
                    file: item.file,
                    name: pkg.name,
                    icon: pkg.icon,
                    version: pkg.version,
                    hash: item.hash,
                    size: item.files.reduce((sum, file) => sum + file.data.length, 0),
                    enabled: false,
                    plugins: [],
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name)),
    });
    if (input.action === "list") return list(stored);
    const file = extensionFile(input.file);
    const current = stored.find((item) => item.file === file);
    if (input.action === "read") {
        if (!current) throw new Error("Plugin not found");
        return {
            ...current,
            files: current.files.map((entry) => ({
                name: entry.name,
                data: extensionBase64(entry.data),
            })),
        };
    }
    const base = input.action === "install" ? input.base : input.hash;
    if ((current?.hash ?? null) !== base)
        throw new Error("Plugin changed. Reopen it before saving.");
    let files: ExtensionFile[];
    if (input.action === "delete") {
        if (!current) throw new Error("Plugin not found");
        await commit(scope, file, base);
        return list(stored.filter((item) => item.file !== file));
    }
    if (input.action === "install") {
        if (
            typeof input.data !== "string" ||
            input.data.length > Math.ceil((MAX_EXTENSION_BYTES * 4) / 3)
        )
            throw new Error("Choose a ZIP smaller than 16 MiB");
        files = (await readBrowserExtension(extensionBytes(input.data))).files;
    } else if (input.action === "edit" && current) {
        files = current.files;
        const target = files.find((entry) => entry.name === input.path);
        if (!target || typeof input.source !== "string" || input.source.includes("\0"))
            throw new Error("Expected a UTF-8 plugin file");
        target.data = new TextEncoder().encode(input.source);
        if (files.reduce((sum, entry) => sum + entry.data.length, 0) > MAX_EXTENSION_BYTES)
            throw new Error("Plugin exceeds 16 MiB");
        extensionManifest(files);
    } else throw new Error("Unknown plugin action");
    const next = {
        file,
        files,
        hash: [...crypto.getRandomValues(new Uint32Array(4))]
            .map((value) => value.toString(16))
            .join("-"),
    };
    await commit(scope, file, base, next);
    return list([...stored.filter((item) => item.file !== file), next]);
};
