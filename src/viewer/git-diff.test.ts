import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { gitBaseBody } from "./git-diff.js";

it("reads HEAD from a nested docs folder, keeping staged changes and new files distinct", () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-git-diff-"));
    const git = (...args: string[]) =>
        execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
    try {
        mkdirSync(join(root, "docs"));
        const docs = join(root, "docs");
        expect(gitBaseBody(docs, "a.md")).toBeNull();
        git("init");
        expect(gitBaseBody(docs, "a.md")).toBe("");
        writeFileSync(join(docs, "a.md"), "---\ntitle: A\n---\n\nBefore\n");
        git("add", ".");
        git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base");
        writeFileSync(join(docs, "a.md"), "---\ntitle: A\n---\n\nAfter\n");
        git("add", ".");
        expect(gitBaseBody(docs, "a.md")).toBe("Before\n");
        expect(gitBaseBody(docs, "new.md")).toBe("");
        expect(gitBaseBody(docs, "../outside.md")).toBeNull();
        git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "update");
        expect(gitBaseBody(docs, "a.md")).toBe("After\n");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
