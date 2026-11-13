import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { WorkspaceSource } from "../../engine/src/core/workspace.js";

/** Git worktrees use a .git file pointing at their own metadata directory. */
const gitMetadata = (root: string): { head: string; directory: string } | undefined => {
    let directory = realpathSync(root);
    for (;;) {
        const git = join(directory, ".git");
        try {
            const target = statSync(git).isDirectory()
                ? git
                : /^gitdir: (.+)\r?\n?$/.exec(readFileSync(git, "utf8"))?.[1];
            const head = target ? join(resolve(directory, target.trim()), "HEAD") : undefined;
            return head && existsSync(head) ? { head, directory } : undefined;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
        }
        const parent = dirname(directory);
        if (parent === directory) return undefined;
        directory = parent;
    }
};

export const gitHeadFile = (root: string): string | undefined => gitMetadata(root)?.head;

/**
 * Changes whenever HEAD, a ref or the repository config changes (and the index when asked), so Git
 * answers can be reused between requests. Reads metadata files only; undefined outside Git.
 */
export const gitSignature = (root: string, index = false): string | undefined => {
    try {
        const git = gitMetadata(root);
        if (!git) return undefined;
        const directory = dirname(git.head);
        const commondir = join(directory, "commondir");
        const common = existsSync(commondir)
            ? resolve(directory, readFileSync(commondir, "utf8").trim())
            : directory;
        const head = readFileSync(git.head, "utf8").trim();
        const ref = /^ref: (.+)$/.exec(head)?.[1];
        const sig = (path: string) => {
            const stat = statSync(path, { throwIfNoEntry: false });
            return stat ? `${stat.mtimeMs}:${stat.size}` : "";
        };
        return [
            head,
            // A loose ref keeps its size across commits, so its content is the signature.
            ...(ref
                ? [directory, common].map((base) =>
                      existsSync(join(base, ref)) ? readFileSync(join(base, ref), "utf8") : "",
                  )
                : []),
            sig(join(common, "packed-refs")),
            sig(join(common, "reftable", "tables.list")),
            sig(join(common, "config")),
            index ? sig(join(directory, "index")) : "",
        ].join("|");
    } catch {
        return undefined;
    }
};

/** Read only local metadata; no Git commands, credentials or network access are needed. */
export const readWorkspaceSource = (root: string): WorkspaceSource => {
    const git = gitMetadata(root);
    if (git) {
        try {
            const common = join(dirname(git.head), "commondir");
            const repo = basename(
                existsSync(common)
                    ? dirname(resolve(dirname(git.head), readFileSync(common, "utf8").trim()))
                    : git.directory,
            );
            const head = readFileSync(git.head, "utf8").trim();
            const branch = /^ref: refs\/heads\/(.+)$/.exec(head)?.[1];
            if (branch) return { protocol: "git", repo, branch };
            if (/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(head))
                return { protocol: "git", repo, branch: `HEAD (${head.slice(0, 7)})` };
        } catch {
            // Unreadable Git metadata must not prevent access to the document files.
        }
    }
    return { protocol: "storage", folder: basename(resolve(root)) || root, service: "Local" };
};

/** Resolve source links locally; published HTML must not depend on Git or the build directory. */
export const sourceFileBase = (root: string, sourceUrl?: string): string => {
    if (sourceUrl !== undefined) {
        const url = new URL(sourceUrl);
        if (
            !["https:", "http:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
        )
            throw new Error(
                "Source URL must be an HTTP(S) directory URL without credentials, query or fragment",
            );
        url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
        return url.href;
    }
    const directory = realpathSync(root);
    const signature = gitSignature(directory);
    if (signature !== undefined && sourceBase?.key === `${directory}|${signature}`)
        return sourceBase.value;
    const value = readSourceFileBase(directory);
    if (signature !== undefined) sourceBase = { key: `${directory}|${signature}`, value };
    return value;
};

let sourceBase: { key: string; value: string } | undefined;

const readSourceFileBase = (directory: string): string => {
    const metadata = gitMetadata(directory);
    const workspace = readWorkspaceSource(directory);
    const prefix = metadata ? relative(metadata.directory, directory).split(sep).join("/") : "";
    const fallback = `${[
        workspace.protocol === "git" ? workspace.repo : basename(metadata?.directory ?? directory),
        prefix,
    ]
        .filter(Boolean)
        .join("/")}/`;
    if (!metadata) return fallback;
    try {
        const git = (...args: string[]) =>
            execFileSync("git", ["-C", directory, ...args], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 2_000,
            }).trim();
        const remote = new URL(
            git("config", "--get", "remote.origin.url").replace(
                /^git@github\.com:/,
                "https://github.com/",
            ),
        );
        const repository = /^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.pathname);
        if (remote.hostname !== "github.com" || !repository) return fallback;
        const head = git("rev-parse", "HEAD");
        if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(head)) return fallback;
        return `https://github.com/${repository[1]}/${repository[2]}/blob/${head}/${prefix ? `${prefix.split("/").map(encodeURIComponent).join("/")}/` : ""}`;
    } catch {
        return fallback;
    }
};
