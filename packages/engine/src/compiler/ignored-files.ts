import ignore, { type Ignore } from "ignore";
import {
    dirname,
    existsSync,
    join,
    posix,
    readFileSync,
    realpathSync,
    relative,
    resolve,
    sep,
    spawnSync,
    statSync,
} from "./host.js";

let cached: Map<string, Map<string, boolean>> | undefined;
let scope: Map<string, unknown> | undefined;

/** Share Git checks within one synchronous read, never across requests or writes. */
export const withIgnoredFilesCache = <T>(read: () => T): T => {
    if (cached) return read();
    cached = new Map();
    scope = new Map();
    try {
        return read();
    } finally {
        cached = undefined;
        scope = undefined;
    }
};

/** Reuse one disk answer inside withIgnoredFilesCache; outside it every call reads again. */
export const withinRead = <T>(key: string, read: () => T): T => {
    if (!scope) return read();
    if (!scope.has(key)) scope.set(key, read());
    return scope.get(key) as T;
};

/** Use Git's tracked-file and exclude rules; standalone folders use their .gitignore files. */
export const ignoredFiles = (root: string, files: readonly string[]): Set<string> => {
    if (!cached) return readIgnoredFiles(root, files);
    const key = resolve(root);
    let known = cached.get(key);
    if (!known) {
        known = new Map();
        cached.set(key, known);
    }
    const missing = [...new Set(files.filter((file) => !known.has(file)))];
    if (missing.length) {
        const ignored = readIgnoredFiles(root, missing);
        for (const file of missing) known.set(file, ignored.has(file));
    }
    return new Set(files.filter((file) => known.get(file)));
};

const readIgnoredFiles = (root: string, files: readonly string[]): Set<string> => {
    if (!files.length) return new Set();
    const hasGit = (directory: string) =>
        existsSync(join(directory, ".git", "HEAD")) ||
        statSync(join(directory, ".git"), { throwIfNoEntry: false })?.isFile();
    let repository = resolve(root);
    while (!hasGit(repository) && dirname(repository) !== repository)
        repository = dirname(repository);
    const inRepository = hasGit(repository);
    if (inRepository) {
        const result = spawnSync("git", ["-C", root, "check-ignore", "--stdin", "-z"], {
            input: `${files.join("\0")}\0`,
            encoding: "utf8",
            timeout: 2_000,
            maxBuffer: 5_000_000,
            windowsHide: true,
        });
        if (result.status === 0 || result.status === 1)
            return new Set(result.stdout.split("\0").filter(Boolean));
        if ((result.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT")
            throw new Error(
                `Cannot check ignored files: ${result.error?.message ?? result.stderr.trim()}`,
            );
    }
    const ignoreRoot = inRepository ? repository : root;
    const prefix = relative(ignoreRoot, root).split(sep).join("/");

    const rules = new Map<string, Ignore>();
    const readRules = (directory: string) => {
        let matcher = rules.get(directory);
        if (!matcher) {
            const path = join(ignoreRoot, directory, ".gitignore");
            matcher = ignore().add(existsSync(path) ? readFileSync(path, "utf8") : "");
            rules.set(directory, matcher);
        }
        return matcher;
    };
    return new Set(
        files.filter((file) => {
            const normalized = posix.join(prefix, file);
            const parts = normalized.replace(/\/$/, "").split("/");
            const matchers: Ignore[] = [];
            for (let i = 0; i < parts.length; i++) {
                const directory = parts.slice(0, i).join("/");
                matchers.push(readRules(directory));
                let ignored = false;
                for (const [base, matcher] of matchers.entries()) {
                    const path =
                        parts.slice(base, i + 1).join("/") +
                        (i < parts.length - 1 || file.endsWith("/") ? "/" : "");
                    const result = matcher.test(path);
                    if (result.ignored || result.unignored) ignored = result.ignored;
                }
                if (ignored) return true;
            }
            return false;
        }),
    );
};

export const assertNotIgnored = (root: string, file: string): void => {
    const path = join(root, file);
    const resolved = existsSync(path)
        ? relative(realpathSync(root), realpathSync(path)).split(sep).join("/")
        : file;
    if (ignoredFiles(root, [...new Set([file, resolved])]).size)
        throw new Error(`Referenced file is ignored by Git ignore rules: ${file}`);
};
