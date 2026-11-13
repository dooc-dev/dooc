import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHistoryOp } from "../../workspace/src/history.js";
import { workspaceHistory } from "./history.js";

let root: string;
vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }));
afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
});

const workspace = (git: boolean) => {
    root = mkdtempSync(join(tmpdir(), "dooc-history-"));
    if (git) {
        execFileSync("git", ["-C", root, "init", "-q"]);
        execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
        execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
    }
    mkdirSync(join(root, "content"));
    writeFileSync(join(root, "dooc.yaml"), "docs: [guide]\n");
    writeFileSync(join(root, "content/guide.md"), "one\n");
    const { op } = createHistoryOp(() => workspaceHistory(root));
    const history = (input: Record<string, unknown>) => op(input, {});
    const file = (name: string) => join(root, "content", name);
    return { history, file };
};

it.each([
    ["Git commits", true],
    ["folder copies", false],
])("%s: snapshots list newest first and restore brings back edits, additions and deletions", async (_name, git) => {
    const { history, file } = workspace(git);
    await expect(history({ action: "snapshot", message: " " })).rejects.toThrow("needs a message");
    const first = (await history({ action: "snapshot", message: "First" })) as { id: string };

    writeFileSync(file("guide.md"), "two\n");
    writeFileSync(file("extra.md"), "extra\n");
    await history({ action: "snapshot", message: "Second" });
    rmSync(file("guide.md"));
    await history({ action: "snapshot", message: "Third" });
    expect(
        ((await history({ action: "list" })) as { message: string }[]).map((s) => s.message),
    ).toEqual(["Third", "Second", "First"]);

    await history({ action: "restore", id: first.id });
    expect(readFileSync(file("guide.md"), "utf8")).toBe("one\n");
    expect(existsSync(file("extra.md"))).toBe(false);
    // Restoring adds to the history instead of rewriting it, so "Third" is still reachable.
    const after = (await history({ action: "list" })) as { id: string; message: string }[];
    expect(after.map((s) => s.message)).toContain("Third");
    expect(after.length).toBeGreaterThan(3);

    await expect(history({ action: "restore", id: "../../etc" })).rejects.toThrow(
        "Unknown snapshot",
    );
});

it("Git: refuses an empty snapshot and a restore over unsaved changes", async () => {
    const { history, file } = workspace(true);
    const first = (await history({ action: "snapshot", message: "First" })) as { id: string };
    await expect(history({ action: "snapshot", message: "Again" })).rejects.toThrow(
        "Nothing has changed",
    );
    writeFileSync(file("guide.md"), "unsaved\n");
    await expect(history({ action: "restore", id: first.id })).rejects.toThrow(
        "Snapshot the current changes",
    );
    expect(readFileSync(file("guide.md"), "utf8")).toBe("unsaved\n");
});

it("folder copies: restores files replaced by directories and directories replaced by files", async () => {
    const { history, file } = workspace(false);
    const first = (await history({ action: "snapshot", message: "File" })) as { id: string };
    rmSync(file("guide.md"));
    mkdirSync(file("guide.md/parts/empty"), { recursive: true });
    writeFileSync(file("guide.md/parts/one.txt"), "nested\n");
    const second = (await history({ action: "snapshot", message: "Directory" })) as { id: string };

    await history({ action: "restore", id: first.id });
    expect(readFileSync(file("guide.md"), "utf8")).toBe("one\n");
    await history({ action: "restore", id: second.id });
    expect(readFileSync(file("guide.md/parts/one.txt"), "utf8")).toBe("nested\n");
});

it.each([
    "hidden file",
    "symlink",
])("folder copies: rejects a blocking %s before deleting any current files", async (kind) => {
    const { history, file } = workspace(false);
    const first = (await history({ action: "snapshot", message: "File" })) as { id: string };
    rmSync(file("guide.md"));
    mkdirSync(file("guide.md"));
    writeFileSync(file("guide.md/part.txt"), "current\n");
    writeFileSync(file("extra.md"), "extra\n");
    if (kind === "hidden file") writeFileSync(file("guide.md/.keep"), "private\n");
    else symlinkSync(file("extra.md"), file("guide.md/link.txt"));

    await expect(history({ action: "restore", id: first.id })).rejects.toThrow("unmanaged file");
    expect(readFileSync(file("guide.md/part.txt"), "utf8")).toBe("current\n");
    expect(readFileSync(file("extra.md"), "utf8")).toBe("extra\n");
    expect(
        readFileSync(file(`guide.md/${kind === "hidden file" ? ".keep" : "link.txt"}`), "utf8"),
    ).toBe(kind === "hidden file" ? "private\n" : "extra\n");
});

it("folder copies: rolls back changed files and directories when copying a snapshot fails", async () => {
    const { history, file } = workspace(false);
    const first = (await history({ action: "snapshot", message: "File" })) as { id: string };
    rmSync(file("guide.md"));
    mkdirSync(file("guide.md"));
    writeFileSync(file("guide.md/part.txt"), "current\n");
    writeFileSync(file("extra.md"), "extra\n");
    const copy = fs.cpSync;
    vi.spyOn(fs, "cpSync").mockImplementation((source, target, options) => {
        if (String(source).includes(`/${first.id}/files/`)) throw new Error("Copy failed");
        return copy(source, target, options);
    });

    await expect(history({ action: "restore", id: first.id })).rejects.toThrow("Copy failed");
    expect(readFileSync(file("guide.md/part.txt"), "utf8")).toBe("current\n");
    expect(readFileSync(file("extra.md"), "utf8")).toBe("extra\n");
});

it("shared: credits everyone who edited, records only on the shared branch, and snapshots idle edits", async () => {
    const { file } = workspace(true);
    const log = () =>
        execFileSync("git", ["-C", root, "log", "-1", "--format=%an <%ae>%n%B"], {
            encoding: "utf8",
        });
    const branch = execFileSync("git", ["-C", root, "symbolic-ref", "--short", "HEAD"], {
        encoding: "utf8",
    }).trim();
    const shared = createHistoryOp(() => workspaceHistory(root, branch), {
        idleMs: 20,
        leaveMs: 20,
    });
    const ada = { user: { name: "Ada", email: "ada@example.com" } };
    const bob = { user: { name: "Bob" } };

    // An edit from a connection that never identified credits nobody.
    await shared.op({ action: "contribute" }, {});
    await shared.op({ action: "contribute" }, ada);
    await shared.op({ action: "contribute" }, bob);
    await shared.op({ action: "snapshot", message: "First" }, ada);
    expect(log()).toBe("Ada <ada@example.com>\nFirst\n\nCo-authored-by: Bob <>\n\n");

    // Nobody presses the button: the quiet period records the edit for its author.
    writeFileSync(file("guide.md"), "idle\n");
    await shared.op({ action: "contribute" }, bob);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await shared.flush();
    expect(log()).toContain("Auto snapshot\n\nCo-authored-by: Bob <>");

    // An editor whose connection is gone has their work recorded after the grace period.
    const slow = createHistoryOp(() => workspaceHistory(root, branch), { leaveMs: 20 });
    writeFileSync(file("guide.md"), "left\n");
    await slow.op({ action: "contribute" }, ada);
    slow.left(bob);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(log()).not.toContain("Ada");
    slow.left(ada);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await slow.flush();
    expect(log()).toContain("Co-authored-by: Ada <ada@example.com>");

    execFileSync("git", ["-C", root, "switch", "-q", "-c", "side"]);
    writeFileSync(file("guide.md"), "elsewhere\n");
    await expect(shared.op({ action: "snapshot", message: "Wrong branch" }, ada)).rejects.toThrow(
        `Snapshots are recorded on ${branch}`,
    );
});

it("shared: rejects the wrong branch before staging or restoring files", async () => {
    const { file } = workspace(true);
    const git = (...args: string[]) =>
        execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    const branch = git("symbolic-ref", "--short", "HEAD");
    const history = workspaceHistory(root, branch);
    const first = await history.snapshot("First");
    writeFileSync(file("guide.md"), "two\n");
    await history.snapshot("Second");
    git("switch", "-q", "-c", "side");
    await expect(history.restore(first.id)).rejects.toThrow("Snapshots are recorded on");
    expect(readFileSync(file("guide.md"), "utf8")).toBe("two\n");
    expect(git("status", "--porcelain")).toBe("");
    writeFileSync(file("guide.md"), "unsaved\n");
    await expect(history.snapshot("Wrong branch")).rejects.toThrow("Snapshots are recorded on");
    expect(git("diff", "--cached")).toBe("");
    expect(readFileSync(file("guide.md"), "utf8")).toBe("unsaved\n");
});
