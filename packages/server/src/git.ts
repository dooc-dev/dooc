import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { manifestFile } from "../../engine/src/compiler/manifest.js";
import type {
    GitChange,
    GitContext,
    GitOrigin,
    GitOriginAction,
    GitState,
} from "../../workspace/src/git-types.js";
import { nativeGitOrigin } from "./git-origin.js";
import { readWorkspaceSource } from "./workspace.js";

export const git = (root: string, args: string[], input = ""): Promise<string> =>
    new Promise((resolve, reject) => {
        const child = execFile(
            "git",
            // Stash uses pathspec magic internally when cleaning its saved untracked files.
            [
                args[0] === "stash" ? "--no-literal-pathspecs" : "--literal-pathspecs",
                "-C",
                root,
                ...args,
            ],
            {
                encoding: "utf8",
                timeout: 30_000,
                maxBuffer: 8 * 1024 * 1024,
                env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
            },
            (error, stdout, stderr) => {
                if (error) reject(new Error(stderr.trim().slice(0, 2000) || "Git command failed"));
                else resolve(stdout);
            },
        );
        child.stdin?.on("error", () => {
            /* execFile reports process failures. */
        });
        child.stdin?.end(input);
    });

export const parseGitChanges = (status: string): GitChange[] => {
    const records = status.split("\0");
    const changes: GitChange[] = [];
    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        if (!record) continue;
        const index = record[0] ?? " ";
        const worktree = record[1] ?? " ";
        changes.push({ path: record.slice(3), index, worktree });
        if (/[RC]/.test(index + worktree)) i++;
    }
    return changes;
};

export const gitWorktrees = async (root: string): Promise<Map<string, string>> => {
    const worktrees = new Map<string, string>();
    for (const record of (await git(root, ["worktree", "list", "--porcelain", "-z"])).split(
        "\0\0",
    )) {
        const fields = record.split("\0");
        const branch = fields.find((field) => field.startsWith("branch refs/heads/"));
        const path = fields.find((field) => field.startsWith("worktree "));
        if (branch && path)
            worktrees.set(
                branch.slice("branch refs/heads/".length),
                path.slice("worktree ".length),
            );
    }
    return worktrees;
};

export const gitManifestPath = (root: string, repository: string): string =>
    relative(repository, join(root, manifestFile(root))).replaceAll("\\", "/");

export const hasGitManifest = (root: string, manifest: string, ref?: string): Promise<boolean> =>
    ref === undefined
        ? stat(join(root, manifest)).then(
              (value) => value.isFile(),
              () => false,
          )
        : git(root, ["cat-file", "-t", `${ref}:${manifest}`]).then(
              (value) => value.trim() === "blob",
              () => false,
          );

const text = (value: unknown, limit: number, empty = false): string => {
    if (
        typeof value !== "string" ||
        value.length > limit ||
        value.includes("\0") ||
        (!empty && !value.trim())
    )
        throw new Error("Invalid Git request text");
    return value;
};

export const validateGitOrigin = (value: unknown): GitOrigin => {
    const origin = value as GitOrigin;
    if (
        !origin ||
        typeof origin !== "object" ||
        typeof origin.name !== "string" ||
        !origin.name.trim() ||
        typeof origin.read !== "function" ||
        typeof origin.execute !== "function" ||
        !Array.isArray(origin.capabilities) ||
        origin.capabilities.some(
            (action) =>
                !["fetch", "pull", "push", "createPr", "updatePr", "mergePr"].includes(action),
        )
    )
        throw new Error("Git origin requires a name, capabilities, read and execute handlers");
    return origin;
};

/** Serialize UI operations; Git's own locks still arbitrate with other Git clients. */
export const createGitHandler = (documentRoot: string, getOrigin: () => GitOrigin | undefined) => {
    let busy = false;
    let lastOrigin = getOrigin();
    let originRevision = 0;
    const snapshot = async (): Promise<{ state: GitState; context: GitContext }> => {
        if (lastOrigin !== getOrigin()) {
            lastOrigin = getOrigin();
            originRevision++;
        }
        const root = (await git(documentRoot, ["rev-parse", "--show-toplevel"])).trim();
        const [branch, head, status, branches, upstream, remote, unstaged, staged, stash] =
            await Promise.all([
                git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then(
                    (s) => s.trim(),
                    () => "",
                ),
                git(root, ["rev-parse", "--verify", "HEAD"]).then(
                    (s) => s.trim(),
                    () => "",
                ),
                git(root, [
                    "status",
                    "--porcelain=v1",
                    "-z",
                    "--untracked-files=all",
                    "--no-renames",
                ]),
                git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
                git(root, ["rev-parse", "--abbrev-ref", "@{upstream}"]).then(
                    (s) => s.trim(),
                    () => "",
                ),
                git(root, ["config", "--get-regexp", "^remote\\.origin\\."]).catch(() => ""),
                git(root, ["diff", "--raw", "--no-abbrev", "--no-renames"]),
                git(root, ["diff", "--cached", "--raw", "--no-abbrev", "--no-renames"]),
                git(root, ["stash", "list", "-1", "--format=%H%x00%gs"]),
            ]);
        const changes = parseGitChanges(status);
        const hash = createHash("sha256").update(
            JSON.stringify([
                root,
                branch,
                head,
                status,
                remote,
                unstaged,
                staged,
                stash,
                originRevision,
            ]),
        );
        for (const change of changes) {
            const path = join(root, change.path);
            try {
                const stat = await lstat(path);
                // Index object IDs cover staged content; timestamps also cover untracked and binary files.
                hash.update(JSON.stringify([change.path, stat.size, stat.mtimeMs, stat.ctimeMs]));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                hash.update(`deleted:${change.path}`);
            }
        }
        const counts =
            upstream && head
                ? (await git(root, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]))
                      .trim()
                      .split(/\s+/)
                : [];
        return {
            context: { root, branch, head },
            state: {
                repo: (() => {
                    const source = readWorkspaceSource(root);
                    return source.protocol === "git"
                        ? (source.repo ?? basename(root))
                        : basename(root);
                })(),
                branch,
                head,
                version: hash.digest("hex"),
                branches: branches.trim().split("\n").filter(Boolean),
                changes,
                ...(stash
                    ? {
                          stash: {
                              id: stash.split("\0")[0] ?? "",
                              label: stash.split("\0")[1]?.trim() ?? "",
                          },
                      }
                    : {}),
                upstream,
                ahead: Number(counts[0] ?? 0),
                behind: Number(counts[1] ?? 0),
            },
        };
    };
    return async (input: Record<string, unknown> | undefined): Promise<unknown> => {
        if (!input || typeof input.action !== "string") throw new Error("Invalid Git action");
        if (busy) throw new Error("A Git operation is running. Reload when it finishes.");
        busy = true;
        try {
            const { state, context } = await snapshot();
            const configuredOrigin = getOrigin();
            const origin = configuredOrigin ?? (await nativeGitOrigin(context.root, git));
            if (input.action === "read" || input.action === "branches") {
                if (input.action === "branches") {
                    const manifest = gitManifestPath(documentRoot, context.root);
                    const worktrees = await gitWorktrees(context.root);
                    const available = await Promise.all(
                        state.branches.map((branch) => {
                            const path = worktrees.get(branch);
                            return hasGitManifest(
                                path ?? context.root,
                                manifest,
                                path ? undefined : `refs/heads/${branch}`,
                            );
                        }),
                    );
                    state.branchWorkspaces = {
                        manifest,
                        unavailable: state.branches.filter((_, index) => !available[index]),
                        canCreate: await hasGitManifest(context.root, manifest, "HEAD"),
                    };
                }
                if (origin && input.action === "read") {
                    try {
                        state.origin = {
                            ...(await origin.read(context)),
                            name: origin.name,
                            capabilities: origin.capabilities,
                        };
                    } catch (error) {
                        state.origin = {
                            name: origin.name,
                            capabilities: origin.capabilities,
                            url: "",
                            defaultBranch: "",
                            pullRequests: [],
                        };
                        state.originError =
                            error instanceof Error ? error.message : "Origin unavailable";
                    }
                }
                return state;
            }
            if (input.version !== state.version)
                throw new Error("Repository changed. Reload before continuing.");
            const stashChanges = async () => {
                if (state.stash)
                    throw new Error("Stash is occupied. Restore it before stashing more changes.");
                if (!context.head)
                    throw new Error("Create the first commit before stashing changes.");
                if (!state.changes.length) throw new Error("No changes to stash");
                await git(context.root, [
                    "stash",
                    "push",
                    "--include-untracked",
                    "--message",
                    "dooc",
                ]);
                if (
                    (
                        await git(context.root, [
                            "status",
                            "--porcelain=v1",
                            "--untracked-files=all",
                        ])
                    ).trim()
                )
                    throw new Error(
                        "Some changes could not be stashed. The saved stash has been kept.",
                    );
            };
            if (["diff", "stage", "unstage"].includes(input.action)) {
                const path = text(input.path, 4096);
                const change = state.changes.find((item) => item.path === path);
                if (!change) throw new Error("Changed file not found");
                if (input.action === "diff") {
                    if (change.index === "?") {
                        const absolute = join(context.root, path);
                        const stat = await lstat(absolute);
                        if (stat.size > 1024 * 1024) return { diff: "File too large to preview" };
                        const data = stat.isSymbolicLink()
                            ? Buffer.from(await readlink(absolute))
                            : await readFile(absolute);
                        return { diff: data.includes(0) ? "Binary file" : data.toString("utf8") };
                    }
                    const args = ["--no-ext-diff", "--no-textconv", "--", path];
                    const [staged, working] = await Promise.all([
                        git(context.root, ["diff", "--cached", ...args]),
                        git(context.root, ["diff", ...args]),
                    ]);
                    return { diff: `${staged}${working}` };
                }
                await git(
                    context.root,
                    input.action === "stage"
                        ? ["add", "--", path]
                        : context.head
                          ? ["restore", "--staged", "--", path]
                          : ["rm", "--cached", "--", path],
                );
            } else if (input.action === "stash") {
                await stashChanges();
            } else if (input.action === "restoreStash") {
                if (!state.stash) throw new Error("Stash is empty");
                if (state.changes.length)
                    throw new Error("Commit changes before restoring the stash");
                // Git keeps the stash when restoration conflicts, including staged and untracked files.
                try {
                    await git(context.root, ["stash", "pop", "--index", "stash@{0}"]);
                } catch (error) {
                    throw new Error(
                        `Stash restore failed; the stash has been kept. ${error instanceof Error ? error.message : ""}`,
                    );
                }
            } else if (input.action === "commit") {
                const message = text(input.message, 65_536);
                if (!state.changes.some((change) => ![" ", "?"].includes(change.index)))
                    throw new Error("No staged changes");
                await git(context.root, ["commit", "--file=-"], message);
            } else if (input.action === "switch" || input.action === "branch") {
                const branch = text(input.branch, 256);
                if (branch.startsWith("-") || branch.includes("\n"))
                    throw new Error("Invalid branch");
                await git(context.root, ["check-ref-format", `refs/heads/${branch}`]);
                if (input.action === "switch" && !state.branches.includes(branch))
                    throw new Error("Branch not found");
                if (input.action === "switch" && branch === state.branch) return { ok: true };
                const stash = input.action === "switch" && state.changes.length > 0;
                if (stash) {
                    if (input.stash !== true)
                        throw new Error("Commit changes or stash them before switching branches");
                    await stashChanges();
                }
                try {
                    await git(
                        context.root,
                        input.action === "branch"
                            ? ["switch", "-c", branch]
                            : ["switch", "--no-guess", branch],
                    );
                } catch (error) {
                    if (!stash) throw error;
                    throw new Error(
                        `Branch switch failed; your changes remain in the stash. ${error instanceof Error ? error.message : ""}`,
                    );
                }
            } else {
                if (!origin?.capabilities.includes(input.action as GitOriginAction["action"]))
                    throw new Error("Origin operation is not available");
                let request: GitOriginAction;
                if (
                    input.action === "fetch" ||
                    input.action === "pull" ||
                    input.action === "push"
                ) {
                    if (input.action !== "fetch" && (!context.branch || !context.head))
                        throw new Error("A committed branch is required");
                    if (input.action === "pull" && state.changes.length)
                        throw new Error("Commit changes before pulling");
                    request = { action: input.action };
                } else if (input.action === "createPr") {
                    if (!context.branch || !context.head)
                        throw new Error("A committed branch is required");
                    if (typeof input.draft !== "boolean") throw new Error("Invalid draft setting");
                    request = {
                        action: "createPr",
                        title: text(input.title, 256),
                        body: text(input.body, 65_536, true),
                        base: text(input.base, 256),
                        draft: input.draft,
                    };
                } else if (input.action === "updatePr" || input.action === "mergePr") {
                    if (!Number.isSafeInteger(input.number) || Number(input.number) < 1)
                        throw new Error("Invalid pull request number");
                    const previous = (await origin.read(context)).pullRequests.find(
                        (pr) => pr.number === input.number,
                    );
                    if (!previous || JSON.stringify(previous) !== input.revision)
                        throw new Error("Pull request changed. Reload before continuing.");
                    if (input.action === "updatePr") {
                        request = {
                            action: "updatePr",
                            number: previous.number,
                            previous,
                            title: text(input.title, 256),
                            body: text(input.body, 65_536, true),
                        };
                    } else {
                        if (!["merge", "squash", "rebase"].includes(String(input.method)))
                            throw new Error("Invalid merge method");
                        if (previous.draft) throw new Error("Draft pull requests cannot be merged");
                        request = {
                            action: "mergePr",
                            number: previous.number,
                            previous,
                            method: input.method as "merge" | "squash" | "rebase",
                        };
                    }
                } else throw new Error("Invalid Git action");
                if (getOrigin() !== configuredOrigin)
                    throw new Error("Origin changed. Reload before continuing.");
                await origin.execute(context, request);
            }
            return { ok: true };
        } finally {
            busy = false;
        }
    };
};
