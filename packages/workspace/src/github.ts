import type {
    GitContext,
    GitOrigin,
    GitOriginAction,
    GitOriginState,
    GitPullRequest,
} from "./git-types.js";

export const githubRepository = (url: string): string | undefined =>
    /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)?.[1];

type PullRequest = {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    draft: boolean;
    state: string;
    merged_at: string | null;
    mergeable_state?: string;
    head: { ref: string; sha: string };
    base: { ref: string };
};
const pullRequest = (pr: PullRequest): GitPullRequest => ({
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    url: pr.html_url,
    head: pr.head.ref,
    headCommit: pr.head.sha,
    base: pr.base.ref,
    draft: pr.draft,
    status: [
        pr.merged_at ? "Merged" : pr.state === "closed" ? "Closed" : "Open",
        pr.mergeable_state,
    ]
        .filter(Boolean)
        .join(" · "),
    state: pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : "open",
});

export const createGithubOrigin = (
    repository: string,
    request: <T>(path: string, method?: string, body?: unknown) => Promise<T>,
    sync: (action: "fetch" | "pull" | "push", context: GitContext) => Promise<void>,
): GitOrigin => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid GitHub repository");
    const prefix = `repos/${repository}`;
    return {
        name: "GitHub",
        capabilities: ["fetch", "pull", "push", "createPr", "updatePr", "mergePr"],
        async read(): Promise<GitOriginState> {
            const info = await request<{ html_url: string; default_branch: string }>(prefix);
            const pullRequests: GitPullRequest[] = [];
            for (let page = 1; ; page++) {
                const items = await request<PullRequest[]>(
                    `${prefix}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`,
                );
                pullRequests.push(...items.map(pullRequest));
                if (items.length < 100) break;
            }
            return { url: info.html_url, defaultBranch: info.default_branch, pullRequests };
        },
        async execute(context, input: GitOriginAction) {
            if (input.action === "fetch" || input.action === "pull" || input.action === "push")
                return sync(input.action, context);
            if (input.action === "createPr") {
                const remote = await request<{ object: { sha: string } }>(
                    `${prefix}/git/ref/heads/${encodeURIComponent(context.branch)}`,
                );
                if (remote.object.sha !== context.head)
                    throw new Error("Push this branch before creating a pull request");
                await request(`${prefix}/pulls`, "POST", {
                    title: input.title,
                    body: input.body,
                    head: context.branch,
                    base: input.base,
                    draft: input.draft,
                });
                return;
            }
            if (input.action !== "updatePr" && input.action !== "mergePr")
                throw new Error("Unsupported pull request operation");
            const current = pullRequest(
                await request<PullRequest>(`${prefix}/pulls/${input.number}`),
            );
            if (
                current.headCommit !== input.previous.headCommit ||
                current.title !== input.previous.title ||
                current.body !== input.previous.body ||
                current.state !== "open"
            )
                throw new Error("Pull request changed. Reload before continuing.");
            if (input.action === "updatePr")
                await request(`${prefix}/pulls/${input.number}`, "PATCH", {
                    title: input.title,
                    body: input.body,
                });
            else {
                if (current.draft) throw new Error("Draft pull requests cannot be merged");
                const result = await request<{ merged: boolean; message: string }>(
                    `${prefix}/pulls/${input.number}/merge`,
                    "PUT",
                    { sha: current.headCommit, merge_method: input.method },
                );
                if (!result.merged)
                    throw new Error(result.message || "Pull request could not be merged");
            }
        },
    };
};

export const githubFetch =
    (token: () => string | undefined) =>
    async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
        if (!path.startsWith("repos/") || path.includes("..") || path.startsWith("//"))
            throw new Error("Invalid GitHub API path");
        const secret = token();
        const response = await fetch(`https://api.github.com/${path}`, {
            method,
            credentials: "omit",
            redirect: "error",
            referrerPolicy: "no-referrer",
            signal: AbortSignal.timeout(30000),
            headers: {
                accept: "application/vnd.github+json",
                ...(secret ? { authorization: `Bearer ${secret}` } : {}),
                ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const result = await response.json();
        if (!response.ok)
            throw new Error(
                typeof result.message === "string"
                    ? result.message
                    : `GitHub request failed (${response.status})`,
            );
        return result as T;
    };
