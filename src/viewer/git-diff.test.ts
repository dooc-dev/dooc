import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { type SubformatCollection, subformatChange } from "../core/subformats.js";
import { gitBaseBody, gitFileChanges, setSubformatChanges } from "./git-diff.js";

it("reads HEAD from a nested docs folder, keeping staged changes and new files distinct", () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-git-diff-"));
    const git = (...args: string[]) =>
        execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
    try {
        mkdirSync(join(root, "docs"));
        const docs = join(root, "docs");
        expect(gitBaseBody(docs, "a.md")).toBeNull();
        expect(gitFileChanges(docs).size).toBe(0);
        git("init");
        expect(gitBaseBody(docs, "a.md")).toBe("");
        writeFileSync(join(docs, "a.md"), "---\ntitle: A\n---\n\nBefore\n");
        git("add", ".");
        git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base");
        writeFileSync(join(docs, "a.md"), "---\ntitle: A\n---\n\nAfter\n");
        git("add", ".");
        expect(gitBaseBody(docs, "a.md")).toBe("Before\n");
        writeFileSync(join(docs, "new.issue"), "title: New\n");
        writeFileSync(join(docs, "staged.issue"), "title: Staged\n");
        git("add", "docs/staged.issue");
        writeFileSync(join(root, "outside.issue"), "title: Outside\n");
        expect(Object.fromEntries(gitFileChanges(docs))).toEqual({
            "a.md": "modified",
            "new.issue": "added",
            "staged.issue": "added",
        });
        expect(gitBaseBody(docs, "new.md")).toBe("");
        expect(gitBaseBody(docs, "../outside.md")).toBeNull();
        git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "update");
        expect(gitBaseBody(docs, "a.md")).toBe("After\n");
        expect(Object.fromEntries(gitFileChanges(docs))).toEqual({ "new.issue": "added" });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it("colors subformats by definition, schema and record changes until they are committed", () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-subformat-git-"));
    const git = (...args: string[]) =>
        execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
    const issue: SubformatCollection = {
        ext: "issue",
        format: "json",
        schema: "schema.json",
        fields: [],
        records: [{ file: "a.issue", content: "{}", data: {} }],
    };
    const note: SubformatCollection = { ...issue, ext: "note", records: [] };
    const saveManifest = (configs: SubformatCollection[]) =>
        writeFileSync(
            join(root, "dooc.yaml"),
            `docs: []\nsubformats: ${JSON.stringify(configs.map(({ ext, format, schema, layouts }) => ({ ext, format, schema, layouts })))}\n`,
        );
    try {
        setSubformatChanges(root, [issue]);
        expect(issue.baseLayouts).toBeUndefined();
        git("init");
        saveManifest([issue]);
        writeFileSync(join(root, "schema.json"), "{}");
        writeFileSync(join(root, "a.issue"), "{}");
        const commit = () => {
            git("add", ".");
            git(
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "snapshot",
            );
        };
        commit();
        saveManifest([issue, note]);
        writeFileSync(join(root, "new.issue"), "{}");
        issue.records.push({ file: "new.issue", content: "{}", data: {} });
        setSubformatChanges(root, [issue, note]);
        expect(subformatChange(issue)).toBe("added");
        expect(note.change).toBe("added");
        expect(note.baseLayouts).toEqual({});
        writeFileSync(join(root, "a.issue"), '{"title":"Changed"}');
        setSubformatChanges(root, [issue, note]);
        expect(subformatChange(issue)).toBe("modified");
        writeFileSync(join(root, "schema.json"), '{"type":"object"}');
        setSubformatChanges(root, [issue, note]);
        expect(issue.change).toBe("modified");
        commit();
        setSubformatChanges(root, [issue, note]);
        expect(subformatChange(issue)).toBeUndefined();
        expect(note.change).toBeUndefined();
        issue.layouts = { card_title: "subject" };
        setSubformatChanges(root, [issue]);
        expect(issue.change).toBe("modified");
        expect(issue.baseLayouts).toEqual({});
        saveManifest([issue, note]);
        git("add", ".");
        setSubformatChanges(root, [issue]);
        expect(issue.baseLayouts).toEqual({});
        commit();
        setSubformatChanges(root, [issue]);
        expect(issue.baseLayouts).toEqual({ card_title: "subject" });
        expect(issue.change).toBeUndefined();
        issue.layouts = { card_title: "title" };
        setSubformatChanges(root, [issue]);
        expect(issue.baseLayouts).toEqual({ card_title: "subject" });
        expect(issue.change).toBe("modified");
        delete issue.layouts;
        issue.format = "yaml";
        setSubformatChanges(root, [issue]);
        expect(issue.change).toBe("modified");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
