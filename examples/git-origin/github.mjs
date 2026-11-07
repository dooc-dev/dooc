import { execFile } from "node:child_process";

// Run with: dooc edit <docs-root> --viewer-plugins ./examples/git-origin/github.mjs
// Authentication belongs to the user's Git credential helper / gh session, not dooc.
const run = (root, command, args, input = "") => new Promise((resolve, reject) => {
    const env = { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" };
    delete env.GH_REPO;
    const child = execFile(command, args, { cwd: root, env, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim().slice(0, 2000) || `${command} is unavailable`));
        else resolve(stdout);
    });
    child.stdin?.on("error", () => { /* execFile reports process failures. */ });
    child.stdin?.end(input);
});

const repository = async (root) => {
    const remote = (await run(root, "git", ["remote", "get-url", "origin"])).trim();
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote);
    if (!match) throw new Error("This adapter requires a GitHub HTTPS or SSH origin without embedded credentials.");
    const pushes = (await run(root, "git", ["remote", "get-url", "--push", "--all", "origin"])).trim().split("\n");
    if (pushes.length !== 1 || pushes[0] !== remote) throw new Error("Origin must have a single matching fetch and push URL.");
    return match[1];
};

const fields = "number,title,body,url,headRefName,baseRefName,headRefOid,isDraft,mergeStateStatus,reviewDecision";
const pullRequest = (pr) => ({
    number: pr.number, title: pr.title, body: pr.body, url: pr.url,
    head: pr.headRefName, base: pr.baseRefName, headCommit: pr.headRefOid,
    draft: pr.isDraft, status: [pr.mergeStateStatus, pr.reviewDecision].filter(Boolean).join(" · "),
});

export const githubOrigin = {
    name: "GitHub · origin",
    capabilities: ["fetch", "pull", "push", "createPr", "updatePr", "mergePr"],
    async read({ root }) {
        const repo = await repository(root);
        const [info, requests] = await Promise.all([
            run(root, "gh", ["repo", "view", repo, "--json", "url,defaultBranchRef"]),
            // shortcut: show the latest 100 open PRs; add pagination for larger repositories.
            run(root, "gh", ["pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", fields]),
        ]);
        const data = JSON.parse(info);
        return { url: data.url, defaultBranch: data.defaultBranchRef?.name ?? "", pullRequests: JSON.parse(requests).map(pullRequest) };
    },
    async execute({ root, branch, head }, request) {
        const repo = await repository(root);
        if (request.action === "fetch") {
            await run(root, "git", ["fetch", "origin"]);
        } else if (request.action === "pull" || request.action === "push" || request.action === "createPr") {
            if (!branch || branch.startsWith("-") || !/^[a-f\d]{40,64}$/.test(head)) throw new Error("A committed branch is required.");
            await run(root, "git", ["check-ref-format", `refs/heads/${branch}`]);
            if ((await run(root, "git", ["rev-parse", "HEAD"])).trim() !== head ||
                (await run(root, "git", ["symbolic-ref", "--short", "HEAD"])).trim() !== branch) throw new Error("Branch changed. Reload before continuing.");
            if (request.action === "push") {
                // Push only the reviewed commit to the same branch, never force or mirror.
                await run(root, "git", ["-c", "push.followTags=false", "-c", "remote.origin.mirror=false", "push", "--no-force", "--no-follow-tags", "origin", `${head}:refs/heads/${branch}`]);
            } else if (request.action === "pull") {
                if ((await run(root, "git", ["status", "--porcelain"])).trim()) throw new Error("Commit changes before pulling.");
                await run(root, "git", ["fetch", "origin", `refs/heads/${branch}`]);
                await run(root, "git", ["-c", "merge.autostash=false", "merge", "--ff-only", "FETCH_HEAD"]);
            } else {
                const remoteHead = (await run(root, "git", ["ls-remote", "--heads", "origin", `refs/heads/${branch}`])).split(/\s/)[0];
                if (remoteHead !== head) throw new Error("Push this branch before creating a pull request.");
                await run(root, "gh", ["pr", "create", "--repo", repo, "--head", branch, "--base", request.base, "--title", request.title, "--body-file", "-", ...(request.draft ? ["--draft"] : [])], request.body);
            }
        } else {
            const pr = String(request.number);
            const current = pullRequest(JSON.parse(await run(root, "gh", ["pr", "view", pr, "--repo", repo, "--json", fields])));
            if (JSON.stringify(current) !== JSON.stringify(request.previous)) throw new Error("Pull request changed. Reload before continuing.");
            if (request.action === "updatePr") {
                await run(root, "gh", ["pr", "edit", pr, "--repo", repo, "--title", request.title, "--body-file", "-"], request.body);
            } else if (request.action === "mergePr") {
                if (current.draft || !["merge", "squash", "rebase"].includes(request.method) || !/^[a-f\d]{40,64}$/.test(current.headCommit)) throw new Error("Pull request cannot be merged.");
                // Remote protections remain authoritative; never use admin bypass or delete branches.
                await run(root, "gh", ["pr", "merge", pr, "--repo", repo, `--${request.method}`, "--match-head-commit", current.headCommit]);
            } else throw new Error("Unsupported origin operation.");
        }
    },
};

export default { plugins: [], gitOrigin: githubOrigin };
