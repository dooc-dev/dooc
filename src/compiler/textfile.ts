import { randomUUID } from "node:crypto";
import {
    linkSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { open, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isRemoteTextfile, parseTextfileRange } from "../core/textfile.js";
import { assertNotIgnored } from "./ignored-files.js";

import { readRemoteTextfile, readRemoteTextfileAsync } from "./textfile-remote.js";

export { parseTextfileRange } from "../core/textfile.js";

/** Select whole lines, preserving their original separators and excluding the final separator. */
export const selectTextfileRange = (text: string, range?: string): string => {
    if (range === undefined) return text;
    const [start, end] = parseTextfileRange(range);
    const starts = [
        0,
        ...[...text.matchAll(/\r\n|\n|\r/g)]
            .map((match) => match.index + match[0].length)
            .filter((offset) => offset < text.length),
    ];
    const from = starts[start - 1];
    if (from === undefined) throw new Error(`range line ${start} does not exist`);
    if (starts[end - 1] === undefined) throw new Error(`range line ${end} does not exist`);
    return text.slice(from, starts[end] ?? text.length).replace(/(?:\r\n|\n|\r)$/, "");
};

/** Embedded files must stay inside the docs root, including symlink targets. */
export const textfilePath = (root: string, file: string): string => {
    if (
        !file.trim() ||
        /^[a-z][a-z\d+.-]*:/i.test(file) ||
        /[\0\r\n]/.test(file) ||
        isAbsolute(file) ||
        file.includes("\\") ||
        file.split("/").includes("..")
    )
        throw new Error("expected a relative file path inside the docs root");
    const path = resolve(root, file);
    let ancestor = path;
    while (!lstatSync(ancestor, { throwIfNoEntry: false })) ancestor = dirname(ancestor);
    let resolvedAncestor: string;
    try {
        resolvedAncestor = realpathSync(ancestor);
    } catch {
        throw new Error("cannot resolve the file path (check symlink targets)");
    }
    const resolved = resolve(resolvedAncestor, relative(ancestor, path));
    const rel = relative(realpathSync(root), resolved);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new Error("file is outside the docs root");
    return resolved;
};

export const readTextfile = (
    root: string,
    file: string,
    refresh = false,
    domains: readonly string[] = [],
): string => {
    let data: Uint8Array;
    if (isRemoteTextfile(file)) {
        data = readRemoteTextfile(file, domains, refresh);
    } else {
        const path = textfilePath(root, file);
        assertNotIgnored(root, file);
        if (!statSync(path).isFile()) throw new Error("expected a regular UTF-8 text file");
        data = readFileSync(path);
    }
    return decodeTextfile(data);
};

const decodeTextfile = (data: Uint8Array): string => {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
    if (text.includes("\0")) throw new Error("expected a UTF-8 text file, not binary data");
    return text;
};

export const readTextfileAsync = async (
    root: string,
    file: string,
    refresh = false,
    domains: readonly string[] = [],
): Promise<string> => {
    if (isRemoteTextfile(file)) {
        return decodeTextfile(await readRemoteTextfileAsync(file, domains, refresh));
    }
    const path = textfilePath(root, file);
    assertNotIgnored(root, file);
    if (!(await stat(path)).isFile()) throw new Error("expected a regular UTF-8 text file");
    const handle = await open(path, "r");
    try {
        if (!(await handle.stat()).isFile()) throw new Error("expected a regular UTF-8 text file");
        return decodeTextfile(await handle.readFile());
    } finally {
        await handle.close();
    }
};

/** Compare before writing; null means create only, never overwrite an existing file. */
export const writeTextfile = (
    root: string,
    file: string,
    content: string,
    base: string | null,
): boolean => {
    if (/[\0\uD800-\uDFFF]/u.test(content)) throw new Error("expected UTF-8 text");
    const path = textfilePath(root, file);
    const exists = lstatSync(path, { throwIfNoEntry: false });
    const current = exists ? readTextfile(root, file) : null;
    if (current !== base) return false;
    mkdirSync(dirname(path), { recursive: true });
    const temp = join(dirname(path), `.textfile-${randomUUID()}.tmp`);
    try {
        writeFileSync(temp, content, {
            flag: "wx",
            mode: current === null ? 0o666 : statSync(path).mode,
        });
        if (current === null) linkSync(temp, path);
        else renameSync(temp, path);
    } finally {
        rmSync(temp, { force: true });
    }
    return true;
};
