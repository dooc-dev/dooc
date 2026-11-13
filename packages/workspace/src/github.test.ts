import { expect, it, vi } from "vitest";
import { createGithubOrigin, githubRepository } from "./github.js";

const fixture = {
    number: 7,
    title: "Feature",
    body: "Description",
    html_url: "https://github.com/owner/repo/pull/7",
    draft: false,
    state: "open",
    merged_at: null,
    head: { ref: "feature", sha: "abc" },
    base: { ref: "main" },
};
const context = { root: "/repo", branch: "feature", head: "abc" };
it("includes closed and merged pull requests across all result pages", async () => {
    const request = vi.fn(async (path: string) =>
        path === "repos/owner/repo"
            ? { html_url: "https://github.com/owner/repo", default_branch: "main" }
            : path.endsWith("page=1")
              ? Array.from({ length: 100 }, (_, i) => ({ ...fixture, number: i + 1 }))
              : [{ ...fixture, number: 101, state: "closed", merged_at: "2026-01-01" }],
    );
    const origin = createGithubOrigin("owner/repo", request as never, vi.fn());
    const state = await origin.read(context);
    expect(state.pullRequests).toHaveLength(101);
    expect(state.pullRequests.at(-1)?.state).toBe("merged");
    expect(request).toHaveBeenLastCalledWith(
        expect.stringContaining("state=all&sort=updated&direction=desc&per_page=100&page=2"),
    );
    expect(githubRepository("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(githubRepository("https://token@github.com/owner/repo.git")).toBeUndefined();
});
it("requires a pushed head to create a PR and pins the reviewed head when merging", async () => {
    const request = vi.fn(async (path: string, method?: string) =>
        path.endsWith("git/ref/heads/feature")
            ? { object: { sha: "old" } }
            : path.endsWith("/merge")
              ? { merged: true }
              : method
                ? {}
                : fixture,
    );
    const origin = createGithubOrigin("owner/repo", request as never, vi.fn());
    await expect(
        origin.execute(context, {
            action: "createPr",
            title: "New",
            body: "",
            base: "main",
            draft: true,
        }),
    ).rejects.toThrow("Push this branch");
    const previous = {
        number: 7,
        title: "Feature",
        body: "Description",
        url: fixture.html_url,
        head: "feature",
        base: "main",
        headCommit: "abc",
        draft: false,
        status: "Open",
        state: "open" as const,
    };
    await origin.execute(context, { action: "mergePr", number: 7, method: "squash", previous });
    expect(request).toHaveBeenLastCalledWith("repos/owner/repo/pulls/7/merge", "PUT", {
        sha: "abc",
        merge_method: "squash",
    });
    await expect(
        origin.execute(context, {
            action: "updatePr",
            number: 7,
            title: "Updated",
            body: "",
            previous: { ...previous, headCommit: "changed" },
        }),
    ).rejects.toThrow("Pull request changed");
});
