import { Buffer } from "buffer/";
import { createTwoFilesPatch } from "diff";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { createHash, fs } from "./browser-host.js";
import type { GitOriginAction, GitState } from "./git-types.js";
import { createGithubOrigin, githubFetch, githubRepository } from "./github.js";

export interface BrowserGitOptions {
    url?: string;
    corsProxy?: string;
    username?: string;
    token?: string;
    author?: { name: string; email: string };
}
export const gitOptions = (dir: string, options: BrowserGitOptions) => ({
    fs,
    http,
    dir,
    // Only a proxy explicitly chosen in the workspace dialog may receive credentials.
    corsProxy: options.corsProxy ?? "",
    onAuth: (url: string) => {
        if (!options.token || !options.url || new URL(url).origin !== new URL(options.url).origin)
            return { cancel: true };
        return { username: options.username || "token", password: options.token };
    },
});

export const createBrowserGit = (
    root: string,
    options: BrowserGitOptions,
    label = root.split("/").at(-1) || "Repository",
) => {
    const args = gitOptions(root, options);
    const remote = async () =>
        ((await git.getConfig({ fs, dir: root, path: "remote.origin.url" })) as
            | string
            | undefined) ?? options.url;
    const base = async (file: string, ref = "HEAD"): Promise<string | null> => {
        try {
            const oid = await git.resolveRef({ fs, dir: root, ref });
            const { blob } = await git.readBlob({ fs, dir: root, oid, filepath: file });
            return new TextDecoder("utf-8", { fatal: true }).decode(blob);
        } catch {
            return null;
        }
    };
    const state = async (): Promise<GitState> => {
        const branch = (await git.currentBranch({ fs, dir: root, fullname: false })) ?? "";
        const head = await git.resolveRef({ fs, dir: root, ref: "HEAD" }).catch(() => "");
        const matrix = await git.statusMatrix({ fs, dir: root });
        const changes = matrix
            .filter(([, h, w, s]) => h !== w || h !== s)
            .map(([path, h, w, s]) => ({
                path,
                index:
                    h === 0 && s === 0 ? "?" : h === s ? " " : s === 0 ? "D" : h === 0 ? "A" : "M",
                worktree: h === 0 && s === 0 ? "?" : w === s ? " " : w === 0 ? "D" : "M",
            }));
        const hash = createHash("sha256").update(JSON.stringify([branch, head, matrix]));
        for (const file of [".git/index", ".git/config"])
            if (fs.existsSync(`${root}/${file}`))
                hash.update(fs.readFileSync(`${root}/${file}`) as Uint8Array);
        for (const { path } of changes)
            if (fs.existsSync(`${root}/${path}`))
                hash.update(fs.readFileSync(`${root}/${path}`) as Uint8Array);
        const tracking = branch
            ? await git
                  .resolveRef({ fs, dir: root, ref: `refs/remotes/origin/${branch}` })
                  .catch(() => "")
            : "";
        let ahead = 0,
            behind = 0;
        if (head && tracking && head !== tracking) {
            const local = new Set((await git.log({ fs, dir: root, ref: head })).map((c) => c.oid));
            const upstream = new Set(
                (await git.log({ fs, dir: root, ref: tracking })).map((c) => c.oid),
            );
            ahead = [...local].filter((oid) => !upstream.has(oid)).length;
            behind = [...upstream].filter((oid) => !local.has(oid)).length;
        }
        return {
            localCapabilities: [],
            repo: label,
            branch,
            head,
            version: hash.digest("hex"),
            branches: await git.listBranches({ fs, dir: root }),
            changes,
            upstream: tracking ? `origin/${branch}` : "",
            ahead,
            behind,
        };
    };
    const execute = async (input: Record<string, unknown>) => {
        const current = await state();
        const url = await remote();
        options.url = url;
        const remoteUrl = url?.startsWith("https://") ? new URL(url) : undefined;
        if (remoteUrl && (remoteUrl.username || remoteUrl.password))
            throw new Error(
                "Remove embedded credentials from the Git remote URL and use the token field",
            );
        const repository = url && githubRepository(url);
        if (
            url &&
            !/^https:\/\//.test(url) &&
            ["fetch", "pull", "push"].includes(String(input.action))
        )
            throw new Error(
                "Browser Git requires an HTTPS remote; use the Node server for SSH remotes",
            );
        const sync = async (action: "fetch" | "pull" | "push") => {
            if (action === "pull" && current.changes.length)
                throw new Error("Commit changes before pulling");
            if (action === "fetch") await git.fetch({ ...args, prune: false });
            else if (action === "pull")
                await git.pull({
                    ...args,
                    remote: "origin",
                    ref: current.branch,
                    remoteRef: current.branch,
                    fastForwardOnly: true,
                    author: options.author,
                });
            else
                await git.push({
                    ...args,
                    remote: "origin",
                    ref: current.head,
                    remoteRef: current.branch,
                    force: false,
                });
        };
        const origin = repository
            ? createGithubOrigin(
                  repository,
                  githubFetch(() => options.token),
                  sync,
              )
            : undefined;
        if (input.action === "read" || input.action === "branches") {
            if (origin && input.action === "read") {
                try {
                    current.origin = {
                        ...(await origin.read({
                            root,
                            branch: current.branch,
                            head: current.head,
                        })),
                        name: origin.name,
                        capabilities: origin.capabilities,
                    };
                } catch (error) {
                    current.originError = String(error);
                    current.origin = {
                        name: origin.name,
                        capabilities: origin.capabilities,
                        url: "",
                        defaultBranch: "",
                        pullRequests: [],
                    };
                }
            } else if (url)
                current.origin = {
                    url,
                    defaultBranch: "",
                    pullRequests: [],
                    name: "Git remote",
                    capabilities: ["fetch", "pull", "push"],
                };
            return current;
        }
        if (input.version !== current.version)
            throw new Error("Repository changed. Reload before continuing.");
        const path = typeof input.path === "string" ? input.path : "";
        if (["diff", "stage", "unstage"].includes(String(input.action))) {
            if (!current.changes.some((c) => c.path === path))
                throw new Error("Changed file not found");
            if (input.action === "stage") {
                if (fs.existsSync(`${root}/${path}`))
                    await git.add({ fs, dir: root, filepath: path });
                else await git.remove({ fs, dir: root, filepath: path });
            } else if (input.action === "unstage")
                await git.resetIndex({ fs, dir: root, filepath: path });
            else {
                const data = fs.existsSync(`${root}/${path}`)
                    ? Buffer.from(fs.readFileSync(`${root}/${path}`) as Uint8Array)
                    : Buffer.alloc(0);
                const staged = (
                    await git.walk({
                        fs,
                        dir: root,
                        trees: [git.STAGE()],
                        map: async (file, entries) => {
                            if (file !== path || !entries[0]) return undefined;
                            const oid = await entries[0].oid();
                            return oid
                                ? (await git.readBlob({ fs, dir: root, oid })).blob
                                : undefined;
                        },
                    })
                ).find(Boolean) as Uint8Array | undefined;
                const index = staged ? Buffer.from(staged) : Buffer.alloc(0);
                const head = (await base(path)) ?? "";
                return {
                    diff:
                        data.includes(0) || index.includes(0)
                            ? "Binary file"
                            : Math.max(data.length, index.length, head.length) > 1024 * 1024
                              ? "File too large to preview"
                              : (head === index.toString("utf8")
                                    ? ""
                                    : createTwoFilesPatch(
                                          path,
                                          path,
                                          head,
                                          index.toString("utf8"),
                                          "HEAD",
                                          "Index",
                                      )) +
                                (index.equals(data)
                                    ? ""
                                    : createTwoFilesPatch(
                                          path,
                                          path,
                                          index.toString("utf8"),
                                          data.toString("utf8"),
                                          "Index",
                                          "Working tree",
                                      )),
                };
            }
        } else if (input.action === "commit") {
            if (
                typeof input.message !== "string" ||
                !input.message.trim() ||
                input.message.length > 65536
            )
                throw new Error("Enter a commit message");
            if (!current.changes.some((c) => ![" ", "?"].includes(c.index)))
                throw new Error("No staged changes");
            await git.commit({ fs, dir: root, message: input.message, author: options.author });
        } else if (["fetch", "pull", "push"].includes(String(input.action)))
            await sync(input.action as "fetch" | "pull" | "push");
        else if (origin && ["createPr", "updatePr", "mergePr"].includes(String(input.action))) {
            const previous = (
                await origin.read({ root, branch: current.branch, head: current.head })
            ).pullRequests.find((pr) => pr.number === input.number);
            if (
                input.action !== "createPr" &&
                (!previous || JSON.stringify(previous) !== input.revision)
            )
                throw new Error("Pull request changed. Reload before continuing.");
            if (
                input.action === "mergePr" &&
                !["merge", "squash", "rebase"].includes(String(input.method))
            )
                throw new Error("Invalid merge method");
            if (
                input.action === "createPr" &&
                (typeof input.base !== "string" ||
                    !input.base.trim() ||
                    input.base.length > 256 ||
                    typeof input.draft !== "boolean")
            )
                throw new Error("Choose a base branch and draft state");
            if (
                input.action !== "createPr" &&
                (!Number.isSafeInteger(input.number) || Number(input.number) < 1)
            )
                throw new Error("Invalid pull request number");
            if (
                input.action !== "mergePr" &&
                (typeof input.title !== "string" ||
                    !input.title.trim() ||
                    input.title.length > 256 ||
                    typeof input.body !== "string" ||
                    input.body.length > 65536)
            )
                throw new Error("Enter a title and description");
            await origin.execute({ root, branch: current.branch, head: current.head }, {
                ...input,
                previous,
            } as unknown as GitOriginAction);
        } else throw new Error("This Git operation is not available in this workspace");
        return { ok: true };
    };
    return { state, base, execute };
};
