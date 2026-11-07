import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
    calls: [] as { command: string; args: string[]; body: string }[],
    changed: false,
    pushed: true,
}));
vi.mock("node:child_process", () => ({
    execFile: vi.fn(
        (
            command: string,
            args: string[],
            _options: unknown,
            callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
            const call = { command, args, body: "" };
            mock.calls.push(call);
            let result = "";
            if (command === "git") {
                if (args[0] === "remote") result = "git@github.com:team/project.git\n";
                if (args[0] === "rev-parse") result = `${"a".repeat(40)}\n`;
                if (args[0] === "symbolic-ref") result = "topic\n";
                if (args[0] === "ls-remote")
                    result = `${(mock.pushed ? "a" : "b").repeat(40)}\trefs/heads/topic\n`;
            } else if (args[0] === "repo")
                result = JSON.stringify({
                    url: "https://github.com/team/project",
                    defaultBranchRef: { name: "main" },
                });
            else if (["list", "view"].includes(args[1] ?? "")) {
                const pr = {
                    number: 1,
                    title: mock.changed ? "Changed" : "Title",
                    body: "Body",
                    url: "https://github.com/team/project/pull/1",
                    headRefName: "topic",
                    baseRefName: "main",
                    headRefOid: "a".repeat(40),
                    isDraft: false,
                    mergeStateStatus: "CLEAN",
                    reviewDecision: "APPROVED",
                };
                result = JSON.stringify(args[1] === "list" ? [pr] : pr);
            }
            queueMicrotask(() => callback(null, result, ""));
            return {
                stdin: Object.assign(new EventEmitter(), {
                    end(body: string) {
                        call.body = body;
                    },
                }),
            };
        },
    ),
}));

const adapter = async () =>
    (await import(new URL("../../examples/git-origin/github.mjs", import.meta.url).href))
        .githubOrigin;
const context = { root: "/fixture", branch: "topic", head: "a".repeat(40) };
afterEach(() => {
    mock.calls.length = 0;
    mock.changed = false;
    mock.pushed = true;
});

it("uses explicit origin identity, pinned non-force pushes and merge head checks", async () => {
    const origin = await adapter();
    const state = await origin.read(context);
    expect(state.defaultBranch).toBe("main");
    await origin.execute(context, { action: "push" });
    const push = mock.calls.find((call) => call.args.includes("push"));
    expect(push?.args).toContain(`${context.head}:refs/heads/topic`);
    expect(push?.args).toContain("--no-force");
    expect(push?.args).toContain("push.followTags=false");
    expect(push?.args).not.toContain("--force");
    await origin.execute(context, { action: "pull" });
    expect(mock.calls.some((call) => call.args.includes("--ff-only"))).toBe(true);
    const previous = state.pullRequests[0];
    await origin.execute(context, { action: "mergePr", number: 1, previous, method: "squash" });
    expect(mock.calls.at(-1)?.args).toEqual([
        "pr",
        "merge",
        "1",
        "--repo",
        "team/project",
        "--squash",
        "--match-head-commit",
        context.head,
    ]);
    expect(mock.calls.flatMap((call) => call.args)).not.toContain("--admin");
    expect(mock.calls.flatMap((call) => call.args)).not.toContain("auth");
});

it("sends PR bodies on stdin, requires a pushed head and refuses stale PR edits", async () => {
    const origin = await adapter();
    const state = await origin.read(context);
    const body = "Line one\n`$(literal)`\n日本語";
    await origin.execute(context, {
        action: "createPr",
        title: "Title",
        body,
        base: "main",
        draft: true,
    });
    expect(mock.calls.at(-1)?.body).toBe(body);
    expect(mock.calls.at(-1)?.args).toContain("--draft");
    mock.pushed = false;
    await expect(
        origin.execute(context, {
            action: "createPr",
            title: "Title",
            body,
            base: "main",
            draft: true,
        }),
    ).rejects.toThrow("Push this branch");
    mock.changed = true;
    await expect(
        origin.execute(context, {
            action: "updatePr",
            number: 1,
            title: "New",
            body,
            previous: state.pullRequests[0],
        }),
    ).rejects.toThrow("Pull request changed");
    expect(mock.calls.some((call) => call.args[1] === "edit")).toBe(false);
});
