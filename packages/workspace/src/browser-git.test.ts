import git from "isomorphic-git";
import { afterEach, expect, it } from "vitest";
import { createBrowserGit, gitOptions } from "./browser-git.js";
import { fs } from "./browser-host.js";
import type { GitState } from "./git-types.js";

const root = "/browser-git-test";
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
it("stages selected files, guards stale edits, commits and shows staged plus working changes", async () => {
    fs.mkdirSync(root, { recursive: true });
    await git.init({ fs, dir: root, defaultBranch: "main" });
    fs.writeFileSync(`${root}/a.md`, "one\n");
    fs.writeFileSync(`${root}/b.md`, "other\n");
    const driver = createBrowserGit(root, { author: { name: "Test", email: "test@example.com" } });
    const run = async (input: Record<string, unknown>) =>
        driver.execute({ ...input, version: (await driver.state()).version });
    await run({ action: "stage", path: "a.md" });
    await run({ action: "commit", message: "Initial" });
    expect((await driver.state()).changes).toEqual([{ path: "b.md", index: "?", worktree: "?" }]);
    fs.writeFileSync(`${root}/a.md`, "two\n");
    const stale = await driver.state();
    fs.writeFileSync(`${root}/a.md`, "three\n");
    await expect(
        driver.execute({ action: "stage", path: "a.md", version: stale.version }),
    ).rejects.toThrow("Repository changed");
    await run({ action: "stage", path: "a.md" });
    fs.writeFileSync(`${root}/a.md`, "four\n");
    const diff = (await run({ action: "diff", path: "a.md" })) as { diff: string };
    expect(diff.diff).toContain("+three");
    expect(diff.diff).toContain("+four");
    expect(((await driver.execute({ action: "read" })) as GitState).localCapabilities).toEqual([]);
    await run({ action: "unstage", path: "a.md" });
    expect((await driver.state()).changes[0]?.index).toBe(" ");
});

it("sends tokens only to the selected Git origin and requires an explicit proxy", () => {
    const options = gitOptions("/workspace", {
        url: "https://github.com/owner/repo.git",
        token: "secret",
    });
    expect(options.corsProxy).toBe("");
    expect(options.onAuth("https://github.com/owner/repo.git")).toEqual({
        username: "token",
        password: "secret",
    });
    expect(options.onAuth("https://other.example/repo.git")).toEqual({ cancel: true });
});
