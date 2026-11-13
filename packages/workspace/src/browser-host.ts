import { sha256 } from "@noble/hashes/sha2.js";
import { Buffer } from "buffer/";
import { deflateSync } from "fflate";
import { fs } from "memfs";
import path from "path-browserify";

export { fs };
export const {
    existsSync,
    linkSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmdirSync,
    rmSync,
    statSync,
    unlinkSync,
    writeFileSync,
} = fs;
export const { open, readFile, stat } = fs.promises;
export const { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep } = path;
export const randomUUID = (): string => crypto.randomUUID();

export const createHash = (algorithm: string) => {
    if (algorithm !== "sha256") throw new Error(`Unsupported hash: ${algorithm}`);
    const digest = sha256.create();
    const hash = {
        update(value: string | Uint8Array) {
            digest.update(typeof value === "string" ? new TextEncoder().encode(value) : value);
            return hash;
        },
        digest(encoding: "hex") {
            return Buffer.from(digest.digest()).toString(encoding);
        },
    };
    return hash;
};

export { fileURLToPath, pathToFileURL } from "./browser-url.js";

export const isDeepStrictEqual = (left: unknown, right: unknown): boolean => {
    if (Object.is(left, right)) return true;
    if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
    if (Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left);
    return (
        keys.length === Object.keys(right).length &&
        keys.every(
            (key) =>
                Object.hasOwn(right, key) &&
                isDeepStrictEqual(
                    (left as Record<string, unknown>)[key],
                    (right as Record<string, unknown>)[key],
                ),
        )
    );
};

export const crc32 = (bytes: Uint8Array): number => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
};
export const deflateRawSync = (bytes: Uint8Array): Buffer => Buffer.from(deflateSync(bytes));

export const execFileSync = (): never => {
    throw Object.assign(new Error("External commands require the Node server"), { code: "ENOENT" });
};
export const execFile = execFileSync;
export const spawnSync = () => ({
    status: null,
    stdout: "",
    stderr: "",
    error: Object.assign(new Error("Git runs in the workspace adapter"), { code: "ENOENT" }),
});

// The enclosing worker is terminated by its owner if document rendering exceeds its deadline.
export const runInNewContext = (code: string, context: { render(): unknown }): unknown => {
    if (code !== "render()") throw new Error("Only the built-in geometry renderer is supported");
    return context.render();
};

export async function fetchPublicFile(
    url: string,
    validate?: (contentType: string) => void,
    progress?: (received: number, total?: number) => void,
): Promise<Buffer> {
    const parsed = new URL(url);
    if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        parsed.port ||
        !parsed.hostname.includes(".") ||
        /^(?:[\d.]+|\[.*\])$/.test(parsed.hostname) ||
        /(?:^|\.)(?:local|localhost)$/.test(parsed.hostname)
    )
        throw new Error("Expected a public HTTPS URL without credentials");
    const response = await fetch(parsed, {
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(12000),
    });
    if (!response.ok)
        throw new Error(response.status === 404 ? "NOT_FOUND" : "Could not load file");
    validate?.(response.headers.get("content-type") ?? "");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty response");
    const chunks: Uint8Array[] = [];
    const length = response.headers.get("content-length");
    const total =
        length !== null &&
        /^\d+$/.test(length) &&
        Number.isSafeInteger(Number(length)) &&
        !response.headers.get("content-encoding")
            ? Number(length)
            : undefined;
    let size = 0;
    try {
        progress?.(0, total);
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            progress?.(size, total);
            if (size > 2 * 1024 * 1024) throw new Error("File exceeds 2 MiB");
            chunks.push(value);
        }
    } finally {
        await reader.cancel();
    }
    return Buffer.concat(chunks);
}
