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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isRemoteTextfile } from "../core/textfile.js";
import { readRemoteTextfile } from "./textfile-remote.js";

type Boundary = "*" | { text: string } | { line: number; column?: number };
const BOUNDARY = String.raw`(?:\*|\d+(?::\d+)?|"(?:[^"\\\r\n]|\\.)*")`;
const RANGE_RE = new RegExp(String.raw`^\[\s*(${BOUNDARY})\s*,\s*(${BOUNDARY})\s*\]$`);

export const parseTextfileRange = (range: string): [Boundary, Boundary] => {
    const match = RANGE_RE.exec(range);
    if (!match?.[1] || !match[2])
        throw new Error('range must be [start, end] using line numbers, line:column, "text", or *');
    const boundary = (value: string): Boundary => {
        if (value === "*") return "*";
        if (value.startsWith('"')) {
            const text: string = JSON.parse(value);
            if (!text) throw new Error("range strings must not be empty");
            return { text };
        }
        const [line, column] = value.split(":").map(Number);
        if (
            line == null ||
            !Number.isSafeInteger(line) ||
            line < 1 ||
            (column != null && (!Number.isSafeInteger(column) || column < 1))
        )
            throw new Error("range line and column numbers must be positive integers");
        return { line, ...(column == null ? {} : { column }) };
    };
    return [boundary(match[1]), boundary(match[2])];
};

/** One-based inclusive boundaries; columns count Unicode code points, not UTF-16 units. */
export const selectTextfileRange = (text: string, range?: string): string => {
    if (range == null) return text;
    const [start, end] = parseTextfileRange(range);
    const lineStarts = [
        0,
        ...[...text.matchAll(/\r\n|\n|\r/g)].map((match) => match.index + match[0].length),
    ];
    const offset = (point: Boundary, isEnd: boolean, searchFrom = 0): number => {
        if (point === "*") return isEnd ? text.length : 0;
        if ("text" in point) {
            const found = text.indexOf(point.text, searchFrom);
            if (found < 0)
                throw new Error(
                    `range text ${JSON.stringify(point.text)} was not found${isEnd ? " after the start" : ""}`,
                );
            return found + (isEnd ? point.text.length : 0);
        }
        const from = lineStarts[point.line - 1];
        if (from == null) throw new Error(`range line ${point.line} does not exist`);
        const line = text
            .slice(from, lineStarts[point.line] ?? text.length)
            .replace(/(?:\r\n|\n|\r)$/, "");
        if (point.column == null) return from + (isEnd ? line.length : 0);
        const characters = [...line];
        if (point.column > characters.length)
            throw new Error(`range column ${point.line}:${point.column} does not exist`);
        return from + characters.slice(0, point.column - (isEnd ? 0 : 1)).join("").length;
    };
    const from = offset(start, false);
    const to = offset(end, true, from + (start !== "*" && "text" in start ? start.text.length : 0));
    if (to < from) throw new Error("range end is before its start");
    return text.slice(from, to);
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

export const readTextfile = (root: string, file: string, refresh = false): string => {
    let data: Uint8Array;
    if (isRemoteTextfile(file)) data = readRemoteTextfile(file, refresh);
    else {
        const path = textfilePath(root, file);
        if (!statSync(path).isFile()) throw new Error("expected a regular UTF-8 text file");
        data = readFileSync(path);
    }
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
    if (text.includes("\0")) throw new Error("expected a UTF-8 text file, not binary data");
    return text;
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
    const current = lstatSync(path, { throwIfNoEntry: false }) ? readTextfile(root, file) : null;
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
