import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { WorkspaceSource } from "../core/workspace.js";

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
