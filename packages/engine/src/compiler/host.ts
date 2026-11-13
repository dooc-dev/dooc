// The only door between the engine and the machine it runs on. Engine modules import the
// platform through this file and nothing else, so a browser build swaps in another host module
// (bundler substitution of this path) and the rest runs unchanged. Under Node this is a plain
// re-export, which keeps module mocks and stack traces exactly as they were.
// Keep the list minimal: every name here is one a browser host has to provide.
export { execFile, execFileSync, spawnSync } from "node:child_process";
export { createHash, randomUUID } from "node:crypto";
export {
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
} from "node:fs";
export { open, readFile, stat } from "node:fs/promises";
export {
    basename,
    dirname,
    extname,
    isAbsolute,
    join,
    posix,
    relative,
    resolve,
    sep,
} from "node:path";
export { fileURLToPath, pathToFileURL } from "node:url";
export { isDeepStrictEqual } from "node:util";
export { runInNewContext } from "node:vm";
export { crc32, deflateRawSync } from "node:zlib";
// Network access with its address checks is the host's business too.
export { fetchPublicFile } from "./public-file.js";
