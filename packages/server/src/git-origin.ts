import { execFile } from "node:child_process";
import type { GitContext, GitOrigin } from "../../workspace/src/git-types.js";
import { createGithubOrigin, githubRepository } from "../../workspace/src/github.js";

type Git = (root: string, args: string[], input?: string) => Promise<string>;
export const nativeGitOrigin = async (root: string, git: Git): Promise<GitOrigin | undefined> => {
    const remote = await git(root, ["remote", "get-url", "origin"]).then(
        (value) => value.trim(),
        () => "",
    );
    if (!remote) return undefined;
    const validate = async () => {
        const current = (await git(root, ["remote", "get-url", "origin"])).trim();
        const pushes = (await git(root, ["remote", "get-url", "--push", "--all", "origin"]))
            .trim()
            .split("\n");
        if (current !== remote || pushes.length !== 1 || pushes[0] !== remote)
            throw new Error(
                "Origin must have one matching fetch and push URL. Reload after changing it.",
            );
    };
    const sync = async (action: "fetch" | "pull" | "push", context: GitContext) => {
        await validate();
        if (action === "fetch") {
            await git(root, ["fetch", "origin"]);
            return;
        }
        if (!context.branch || !/^[a-f\d]{40,64}$/i.test(context.head))
            throw new Error("A committed branch is required");
        await git(root, ["check-ref-format", `refs/heads/${context.branch}`]);
        if (
            (await git(root, ["rev-parse", "HEAD"])).trim() !== context.head ||
            (await git(root, ["symbolic-ref", "--short", "HEAD"])).trim() !== context.branch
        )
            throw new Error("Branch changed. Reload before continuing.");
        if (action === "push")
            await git(root, [
                "-c",
                "push.followTags=false",
                "-c",
                "remote.origin.mirror=false",
                "push",
                "--no-force",
                "--no-follow-tags",
                "origin",
                `${context.head}:refs/heads/${context.branch}`,
            ]);
        else {
            if ((await git(root, ["status", "--porcelain"])).trim())
                throw new Error("Commit changes before pulling");
            await git(root, ["fetch", "origin", `refs/heads/${context.branch}`]);
            await git(root, ["-c", "merge.autostash=false", "merge", "--ff-only", "FETCH_HEAD"]);
        }
    };
    const repository = githubRepository(remote);
    if (!repository)
        return {
            name: "Git remote",
            capabilities: ["fetch", "pull", "push"],
            read: async () => ({
                url: /^https?:\/\//.test(remote) ? remote : "",
                defaultBranch: "",
                pullRequests: [],
            }),
            execute: async (context, input) => {
                if (input.action !== "fetch" && input.action !== "pull" && input.action !== "push")
                    throw new Error("Pull requests require a GitHub origin or an origin plugin");
                await sync(input.action, context);
            },
        };
    return createGithubOrigin(
        repository,
        async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
            await validate();
            return new Promise((resolve, reject) => {
                const env: NodeJS.ProcessEnv = {
                    ...process.env,
                    GH_PROMPT_DISABLED: "1",
                    GH_PAGER: "cat",
                };
                delete env.GH_REPO;
                const child = execFile(
                    "gh",
                    [
                        "api",
                        "--hostname",
                        "github.com",
                        path,
                        "--method",
                        method,
                        ...(body === undefined ? [] : ["--input", "-"]),
                    ],
                    {
                        cwd: root,
                        env,
                        encoding: "utf8",
                        timeout: 30_000,
                        maxBuffer: 8 * 1024 * 1024,
                    },
                    (error, stdout, stderr) => {
                        if (error)
                            reject(
                                new Error(
                                    (error as NodeJS.ErrnoException).code === "ENOENT"
                                        ? "Install GitHub CLI and run gh auth login to manage pull requests."
                                        : stderr.trim().slice(0, 2000) || "GitHub request failed",
                                ),
                            );
                        else {
                            try {
                                resolve(JSON.parse(stdout));
                            } catch {
                                reject(new Error("Invalid GitHub response"));
                            }
                        }
                    },
                );
                child.stdin?.on("error", () => {});
                child.stdin?.end(body === undefined ? "" : JSON.stringify(body));
            });
        },
        sync,
    );
};
