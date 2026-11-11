import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitHeadFile, readWorkspaceSource, sourceFileBase } from "./workspace.js";

const roots: string[] = [];
const temporary = () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-workspace-"));
    roots.push(root);
    return root;
};
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local workspace identity", () => {
    it("uses the document root rather than the server's own repository", () => {
        const root = temporary();
        expect(sourceFileBase(root)).toBe(`${basename(root)}/`);
        expect(readWorkspaceSource(root)).toEqual({
            protocol: "storage",
            folder: basename(root),
            service: "Local",
        });
        mkdirSync(join(root, ".git"));
        mkdirSync(join(root, "docs"));
        const head = join(root, ".git/HEAD");
        writeFileSync(head, "ref: refs/heads/docs/first\n");
        expect(sourceFileBase(join(root, "docs"))).toBe(`${basename(root)}/docs/`);
        expect(readWorkspaceSource(join(root, "docs"))).toEqual({
            protocol: "git",
            repo: basename(root),
            branch: "docs/first",
        });
        writeFileSync(head, "ref: refs/heads/docs/next\n");
        expect(readWorkspaceSource(root)).toEqual({
            protocol: "git",
            repo: basename(root),
            branch: "docs/next",
        });
    });

    it("reads a linked worktree's own HEAD, including detached HEAD", () => {
        const root = temporary();
        const metadata = join(root, "metadata");
        const worktree = join(root, "worktree");
        mkdirSync(metadata);
        mkdirSync(worktree);
        writeFileSync(join(worktree, ".git"), "gitdir: ../metadata\n");
        writeFileSync(join(metadata, "HEAD"), "ref: refs/heads/topic\n");
        expect(gitHeadFile(worktree)).toBe(join(metadata, "HEAD"));
        expect(readWorkspaceSource(worktree)).toEqual({
            protocol: "git",
            repo: "worktree",
            branch: "topic",
        });
        writeFileSync(join(metadata, "HEAD"), `${"a".repeat(40)}\n`);
        expect(readWorkspaceSource(worktree)).toEqual({
            protocol: "git",
            repo: "worktree",
            branch: "HEAD (aaaaaaa)",
        });
        mkdirSync(join(root, "repository/.git"), { recursive: true });
        writeFileSync(join(metadata, "commondir"), "../repository/.git\n");
        mkdirSync(join(worktree, "docs"));
        expect(sourceFileBase(join(worktree, "docs"))).toBe("repository/docs/");
        expect(readWorkspaceSource(worktree)).toMatchObject({
            protocol: "git",
            repo: "repository",
        });
        writeFileSync(join(metadata, "HEAD"), "invalid\n");
        expect(readWorkspaceSource(worktree).protocol).toBe("storage");
        writeFileSync(join(worktree, ".git"), "invalid\n");
        expect(readWorkspaceSource(worktree).protocol).toBe("storage");
    });
});

import { execFileSync } from "node:child_process";

it("resolves GitHub SSH and HTTPS remotes to commit links without credentials", () => {
    const root = temporary();
    const git = (...args: string[]) =>
        execFileSync("git", ["-C", root, ...args], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    git("init", "-q");
    git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-qm",
        "Initial",
    );
    mkdirSync(join(root, "doc space"));
    const head = git("rev-parse", "HEAD");
    for (const remote of [
        "git@github.com:team/repository.git",
        "ssh://git@github.com/team/repository.git",
        "https://token:secret@github.com/team/repository.git",
    ]) {
        git("config", "remote.origin.url", remote);
        expect(sourceFileBase(join(root, "doc space"))).toBe(
            `https://github.com/team/repository/blob/${head}/doc%20space/`,
        );
    }
    git("config", "remote.origin.url", "https://example.com/team/repository.git");
    expect(sourceFileBase(root)).toBe(`${basename(root)}/`);
});

it("accepts an explicit deployed source directory and rejects unsafe or ambiguous URLs", () => {
    const root = temporary();
    expect(sourceFileBase(root, "https://example.com/project/source")).toBe(
        "https://example.com/project/source/",
    );
    for (const url of [
        "javascript:alert(1)",
        "https://token:secret@example.com/",
        "https://example.com/?key=secret",
        "https://example.com/#fragment",
        "../source/",
    ])
        expect(() => sourceFileBase(root, url)).toThrow();
});
