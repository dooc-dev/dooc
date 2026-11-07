import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHandler, parseGitChanges, validateGitOrigin } from "./git.js";
import type { GitOrigin, GitPullRequest, GitState } from "./git-types.js";

const roots: string[] = [];
const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-git-"));
    roots.push(root);
    const git = (...args: string[]) =>
        execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--initial-branch=main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("config", "core.hooksPath", "/dev/null");
    let origin: GitOrigin | undefined;
    const handle = createGitHandler(root, () => origin);
    const read = () => handle({ action: "read" }) as Promise<GitState>;
    const act = async (action: string, input: Record<string, unknown> = {}) =>
        handle({ action, version: (await read()).version, ...input });
    return {
        root,
        git,
        handle,
        read,
        act,
        connect: (value: GitOrigin | undefined) => {
            origin = value;
        },
    };
};
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local Git workflow", () => {
    it("stashes into one slot before switching and restores staged, unstaged and untracked changes", async () => {
        const { root, git, act, read } = fixture();
        writeFileSync(join(root, "file.txt"), "Original\n");
        await act("stage", { path: "file.txt" });
        await act("commit", { message: "Initial" });
        git("branch", "other");
        writeFileSync(join(root, "file.txt"), "Staged\n");
        await act("stage", { path: "file.txt" });
        writeFileSync(join(root, "file.txt"), "Working\n");
        writeFileSync(join(root, "new.txt"), "Untracked\n");
        await act("switch", { branch: "other", stash: true });
        const state = await read();
        expect(state.branch).toBe("other");
        expect(state.changes).toEqual([]);
        expect(state.stash?.label).toContain("main: dooc");
        expect(git("stash", "list").trim().split("\n")).toHaveLength(1);
        expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("Original\n");
        await act("restoreStash");
        expect((await read()).stash).toBeUndefined();
        expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("Working\n");
        expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("Untracked\n");
        expect(git("show", ":file.txt")).toBe("Staged\n");
    });

    it("never overwrites an occupied stash, and includes stash identity in stale-view checks", async () => {
        const { root, git, act, read, handle } = fixture();
        writeFileSync(join(root, "file"), "Original");
        await act("stage", { path: "file" });
        await act("commit", { message: "Initial" });
        git("branch", "other");
        writeFileSync(join(root, "file"), "Saved");
        await act("stash");
        const stash = (await read()).stash;
        writeFileSync(join(root, "new"), "Current");
        await expect(act("stash")).rejects.toThrow("occupied");
        await expect(act("switch", { branch: "other", stash: true })).rejects.toThrow("occupied");
        await expect(act("restoreStash")).rejects.toThrow("Commit changes");
        expect((await read()).stash).toEqual(stash);
        expect((await read()).branch).toBe("main");
        expect(readFileSync(join(root, "new"), "utf8")).toBe("Current");
        rmSync(join(root, "new"));
        const previous = await read();
        git("stash", "drop");
        await expect(handle({ action: "restoreStash", version: previous.version })).rejects.toThrow(
            "Repository changed",
        );
        await expect(act("restoreStash")).rejects.toThrow("empty");
    });

    it("preserves the stash when restoring conflicts on another branch", async () => {
        const { root, git, act, read } = fixture();
        writeFileSync(join(root, "file"), "Base\n");
        await act("stage", { path: "file" });
        await act("commit", { message: "Base" });
        await act("branch", { branch: "other" });
        writeFileSync(join(root, "file"), "Other branch\n");
        await act("stage", { path: "file" });
        await act("commit", { message: "Other" });
        await act("switch", { branch: "main" });
        writeFileSync(join(root, "file"), "Saved draft\n");
        await act("switch", { branch: "other", stash: true });
        const before = (await read()).stash;
        await expect(act("restoreStash")).rejects.toThrow();
        expect((await read()).stash).toEqual(before);
        expect(git("stash", "show", "-p")).toContain("+Saved draft");
    });

    it("validates the target before stashing and keeps the stash if a worktree prevents switching", async () => {
        const { root, git, act, read } = fixture();
        writeFileSync(join(root, "file"), "Base");
        await act("stage", { path: "file" });
        await act("commit", { message: "Base" });
        const worktree = mkdtempSync(join(tmpdir(), "dooc-stash-worktree-"));
        roots.push(worktree);
        git("worktree", "add", "-b", "other", worktree);
        writeFileSync(join(root, "file"), "Draft");
        await expect(act("switch", { branch: "missing", stash: true })).rejects.toThrow(
            "Branch not found",
        );
        expect((await read()).stash).toBeUndefined();
        await expect(act("switch", { branch: "other", stash: true })).rejects.toThrow(
            "remain in the stash",
        );
        expect((await read()).branch).toBe("main");
        expect((await read()).stash).toBeDefined();
        await act("restoreStash");
        expect(readFileSync(join(root, "file"), "utf8")).toBe("Draft");
    });

    it("stages only selected paths, unstages before the first commit, commits the index and switches branches", async () => {
        const { root, git, act, read } = fixture();
        writeFileSync(join(root, "first.txt"), "first\n");
        writeFileSync(join(root, "second.txt"), "second\n");
        await act("stage", { path: "first.txt" });
        expect((await read()).changes).toContainEqual({
            path: "first.txt",
            index: "A",
            worktree: " ",
        });
        await act("unstage", { path: "first.txt" });
        expect(readFileSync(join(root, "first.txt"), "utf8")).toBe("first\n");
        await act("stage", { path: "first.txt" });
        await act("commit", { message: "First\n\nBody with `literal` $(text)" });
        expect(git("show", "--format=%B", "--no-patch")).toContain("$(text)");
        expect(git("ls-tree", "--name-only", "HEAD").trim()).toBe("first.txt");
        await act("branch", { branch: "docs/topic" });
        expect((await read()).branch).toBe("docs/topic");
        await expect(act("switch", { branch: "main" })).rejects.toThrow("Commit changes");
        await act("stage", { path: "second.txt" });
        await act("commit", { message: "Second" });
        await act("switch", { branch: "main" });
        expect((await read()).branch).toBe("main");
        await expect(act("commit", { message: "Nothing" })).rejects.toThrow("No staged");
    });

    it("rejects stale content and arbitrary paths and preserves working changes when unstaging", async () => {
        const { root, act, read, handle } = fixture();
        const path = "literal[1].txt";
        writeFileSync(join(root, path), "initial\n");
        await act("stage", { path });
        await act("commit", { message: "Initial" });
        writeFileSync(join(root, path), "changed\n");
        const stale = await read();
        writeFileSync(join(root, path), "another\n");
        await expect(handle({ action: "stage", path, version: stale.version })).rejects.toThrow(
            "Repository changed",
        );
        for (const bad of ["../elsewhere", ":(glob)*", "--all", "\0"]) {
            await expect(act("stage", { path: bad })).rejects.toThrow();
        }
        expect(await act("diff", { path })).toEqual({ diff: expect.stringContaining("+another") });
        await act("stage", { path });
        writeFileSync(join(root, path), "working\n");
        await act("unstage", { path });
        expect(readFileSync(join(root, path), "utf8")).toBe("working\n");
        expect((await read()).changes[0]?.index).toBe(" ");
        for (const branch of ["--detach", "../bad", "@{-1}", "bad\nbranch"])
            await expect(act("branch", { branch })).rejects.toThrow();
    });

    it("uses the repository root from nested document folders and previews links without reading their targets", async () => {
        const { root } = fixture();
        mkdirSync(join(root, "docs"));
        symlinkSync("/etc/passwd", join(root, "link"));
        writeFileSync(join(root, "binary"), Buffer.from([0, 1, 2]));
        const handle = createGitHandler(join(root, "docs"), () => undefined);
        const state = (await handle({ action: "read" })) as GitState;
        expect(await handle({ action: "diff", path: "link", version: state.version })).toEqual({
            diff: "/etc/passwd",
        });
        expect(await handle({ action: "diff", path: "binary", version: state.version })).toEqual({
            diff: "Binary file",
        });
        await expect(handle({ action: "push", version: state.version })).rejects.toThrow(
            "not available",
        );
    });

    it("parses NUL-delimited names and rename source records without splitting filenames", () => {
        expect(parseGitChanges("R  new name\0old name\0?? line\nbreak\0 M 日本語.txt\0")).toEqual([
            { path: "new name", index: "R", worktree: " " },
            { path: "line\nbreak", index: "?", worktree: "?" },
            { path: "日本語.txt", index: " ", worktree: "M" },
        ]);
    });

    it("handles large binaries and deletions without materializing patches for the state token", async () => {
        const { root, read, act } = fixture();
        writeFileSync(join(root, "video.bin"), Buffer.alloc(9 * 1024 * 1024, 1));
        await act("stage", { path: "video.bin" });
        await act("commit", { message: "Binary" });
        rmSync(join(root, "video.bin"));
        expect((await read()).changes).toContainEqual({
            path: "video.bin",
            index: " ",
            worktree: "D",
        });
        await act("stage", { path: "video.bin" });
        await act("commit", { message: "Delete" });
        expect((await read()).changes).toEqual([]);
    });
});

it("delegates origin actions without credentials, validates PR revisions and supports revocation", async () => {
    const { root, connect, act, read } = fixture();
    writeFileSync(join(root, "a"), "a");
    await act("stage", { path: "a" });
    await act("commit", { message: "Initial" });
    const pr: GitPullRequest = {
        number: 7,
        title: "Title",
        body: "Body",
        url: "https://example.com/pull/7",
        head: "topic",
        base: "main",
        headCommit: "a".repeat(40),
        draft: false,
        status: "Ready",
    };
    const origin: GitOrigin = {
        name: "Injected origin",
        capabilities: ["fetch", "push", "pull", "createPr", "updatePr", "mergePr"],
        read: vi.fn(async () => ({
            url: "https://example.com",
            defaultBranch: "main",
            pullRequests: [pr],
        })),
        execute: vi.fn(async () => {}),
    };
    connect(origin);
    expect((await read()).origin?.name).toBe("Injected origin");
    for (const action of ["fetch", "push", "pull"]) await act(action);
    await act("createPr", { title: "New", body: "Body", base: "main", draft: true });
    await act("updatePr", {
        number: 7,
        title: "Updated",
        body: "Body",
        revision: JSON.stringify(pr),
    });
    await act("mergePr", { number: 7, method: "squash", revision: JSON.stringify(pr) });
    expect(origin.execute).toHaveBeenLastCalledWith(
        expect.objectContaining({ root, branch: "main", head: expect.any(String) }),
        { action: "mergePr", number: 7, method: "squash", previous: pr },
    );
    expect(origin.execute).toHaveBeenCalledTimes(6);
    for (const input of [
        { number: -1 },
        { number: 7, revision: "old" },
        { number: 7, revision: JSON.stringify(pr), method: "--admin" },
    ])
        await expect(act("mergePr", input)).rejects.toThrow();
    pr.draft = true;
    await expect(
        act("mergePr", { number: 7, method: "merge", revision: JSON.stringify(pr) }),
    ).rejects.toThrow("Draft");
    connect(undefined);
    await expect(act("push")).rejects.toThrow("not available");
    expect(() => validateGitOrigin({ ...origin, capabilities: ["shell"] })).toThrow();
});
