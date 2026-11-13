import { afterEach, expect, it } from "vitest";
import { fs } from "./browser-host.js";
import {
    changedFiles,
    type FileSnapshot,
    memoryFiles,
    persistFiles,
    replaceMemory,
} from "./browser-storage.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const snapshot = (data: Record<string, string>): FileSnapshot =>
    new Map(Object.entries(data).map(([key, value]) => [key, bytes(value)]));
const memoryRoot = "/browser-storage-test";
afterEach(() => fs.rmSync(memoryRoot, { recursive: true, force: true }));

it("synchronizes file/directory replacements without removing unrelated files", () => {
    replaceMemory(memoryRoot, snapshot({ "chapter/nested/intro.md": "old", "keep.md": "keep" }));
    const file = snapshot({ chapter: "new", "keep.md": "keep" });
    replaceMemory(memoryRoot, file);
    expect(memoryFiles(memoryRoot)).toEqual(file);
    const directory = snapshot({ "chapter/intro.md": "again", "keep.md": "keep" });
    replaceMemory(memoryRoot, directory);
    expect(memoryFiles(memoryRoot)).toEqual(directory);
});

it("rejects conflicting snapshot paths before changing memory", () => {
    const before = snapshot({ "keep.md": "keep" });
    replaceMemory(memoryRoot, before);
    expect(() =>
        replaceMemory(memoryRoot, snapshot({ chapter: "file", "chapter/intro.md": "nested" })),
    ).toThrow("both a file and a directory");
    expect(memoryFiles(memoryRoot)).toEqual(before);
});

const directory = (initial: Record<string, string>, fail?: string) => {
    const data = snapshot(initial);
    const root = {
        getFileHandle: async (name: string, { create = false } = {}) => {
            if (!data.has(name)) {
                if (!create) throw new DOMException("Missing", "NotFoundError");
                data.set(name, bytes(""));
            }
            return {
                getFile: async () => ({ arrayBuffer: async () => data.get(name)?.buffer }),
                createWritable: async () => {
                    if (name === fail) throw new Error("Disk full");
                    let value: Uint8Array;
                    return {
                        write: async (next: Uint8Array) => {
                            value = next;
                        },
                        close: async () => {
                            data.set(name, value);
                        },
                        abort: async () => {},
                    };
                },
            };
        },
        removeEntry: async (name: string) => {
            data.delete(name);
        },
    } as unknown as FileSystemDirectoryHandle;
    return { root, data };
};
it("preflights the entire save before overwriting an externally changed file", async () => {
    const { root, data } = directory({ a: "old", b: "external" });
    await expect(
        persistFiles(root, snapshot({ a: "old", b: "old" }), snapshot({ a: "new", b: "new" })),
    ).rejects.toThrow("File changed outside dooc: b");
    expect(data).toEqual(snapshot({ a: "old", b: "external" }));
});
it("rolls back completed writes and removes an empty new file after storage failure", async () => {
    const { root, data } = directory({ a: "old" }, "b");
    await expect(
        persistFiles(root, snapshot({ a: "old" }), snapshot({ a: "new", b: "new" })),
    ).rejects.toThrow("Disk full");
    expect(data).toEqual(snapshot({ a: "old" }));
});

it("reports added, changed and deleted paths for browser change notifications", () => {
    expect(
        changedFiles(
            snapshot({
                "content/a.md": "old",
                "content/b.md": "same",
                "content/deleted.md": "old",
            }),
            snapshot({ "content/a.md": "new", "content/b.md": "same", "content/new.md": "new" }),
        ),
    ).toEqual(["content/a.md", "content/deleted.md", "content/new.md"]);
});
