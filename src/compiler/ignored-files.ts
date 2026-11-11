import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";

/** Use Git's tracked-file and exclude rules; standalone folders use their .gitignore files. */
export const ignoredFiles = (root: string, files: readonly string[]): Set<string> => {
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
