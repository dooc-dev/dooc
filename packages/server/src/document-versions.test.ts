import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { projectRoot } from "../../engine/src/compiler/manifest.js";
import type { DocumentVersionList } from "../../engine/src/core/document-version.js";
import { createDocumentVersions } from "./document-versions.js";
import { git } from "./git.js";
import { nodeWorkspaceOperations } from "./workspace-server.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("publishes only selected versions and keeps historical editor workspaces read-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-version-publication-"));
    roots.push(root);
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Test"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    mkdirSync(join(root, "content"));
    writeFileSync(join(root, "dooc.yaml"), "docs: [guide]\n");
    writeFileSync(join(root, "content/guide.md"), "Original published text\n");
    const commit = async () => {
        await git(root, ["add", "."]);
        await git(root, ["commit", "-m", "Change"]);
    };
    await commit();
    writeFileSync(join(root, "content/guide.md"), "Latest published text\n");
    await commit();
    writeFileSync(join(root, "content/guide.md"), "Private working changes\n");
    const session = { local: true };
    const reader = await nodeWorkspaceOperations(
        join(root, "dooc.yaml"),
        undefined,
        undefined,
        true,
    );
    const editor = await nodeWorkspaceOperations(join(root, "dooc.yaml"));
    const request = { method: "GET", url: "/guide", headers: {}, body: "" };
    try {
        const list = (await reader.ops.versions?.(
            { action: "list" },
            session,
        )) as DocumentVersionList;
        expect(list.versions.map((row) => row.version)).toEqual(["0.0.1"]);
        expect(list.showSelector).toBe(false);
        const page = (await reader.ops.http?.(request, session)) as { body: string };
        expect(page.body).toContain("Latest published text");
        expect(page.body).not.toContain("Private working changes");
        await expect(
            reader.ops.versions?.({ action: "open", version: "0.0.0" }, session),
        ).rejects.toThrow("not published");
        const old = (await editor.ops.versions?.(
            { action: "open", version: "0.0.0" },
            session,
        )) as { id: string; readOnly: boolean };
        expect(old.readOnly).toBe(true);
        const historical = (await editor.ops.http?.(
            { ...request, workspace: old.id },
            session,
        )) as { body: string };
        expect(historical.body).toContain("Original published text");
        expect(historical.body).toContain('"readOnly":true');
        for (const [name, args] of [
            ["files", { action: "delete", paths: ["guide.md"] }],
            ["git", { action: "commit", message: "Wrong version" }],
            ["http", { ...request, method: "POST", url: "/api/save", body: "{}" }],
            [
                "http",
                {
                    ...request,
                    method: "POST",
                    url: "/api/textfile",
                    body: JSON.stringify({
                        action: "save",
                        file: "guide.md",
                        content: "overwrite",
                    }),
                },
            ],
        ] as const)
            await expect(
                editor.ops[name]?.({ ...args, workspace: old.id }, session),
            ).rejects.toThrow("read-only");
        const current = (await editor.ops.versions?.(
            { action: "open", version: "latest" },
            session,
        )) as { id: string };
        expect(current.id).toBe("main");
        expect(readFileSync(join(root, "content/guide.md"), "utf8")).toBe(
            "Private working changes\n",
        );
        const published = (await reader.ops.versions?.(
            { action: "open", version: "latest" },
            session,
        )) as { id: string };
        writeFileSync(join(root, "dooc.yaml"), "docs: [unfinished\n");
        expect(((await reader.ops.http?.(request, session)) as { body: string }).body).toContain(
            "Latest published text",
        );
        writeFileSync(join(root, "dooc.yaml"), "docs: [guide]\n");
        await commit();
        await expect(
            reader.ops.http?.({ ...request, workspace: published.id }, session),
        ).rejects.toThrow("not published");
    } finally {
        reader.close();
        editor.close();
    }
});

it("versions manifest and transitive content changes without touching drafts or the checkout", async () => {
    const repository = mkdtempSync(join(tmpdir(), "dooc-version-test-"));
    roots.push(repository);
    const root = join(repository, "docs");
    mkdirSync(root);
    await git(repository, ["init", "--initial-branch=main"]);
    await git(repository, ["config", "user.name", "Test"]);
    await git(repository, ["config", "user.email", "test@example.com"]);
    const manifest =
        "version: { major: 1, minor: git, patch: git }\ndocument:\n  children:\n    - document:\n        url: guide.md\n";
    writeFileSync(join(root, "dooc.yaml"), manifest);
    writeFileSync(join(root, "guide.md"), "# Guide\n\n![](image.svg)\n");
    writeFileSync(join(root, "original.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    symlinkSync("original.svg", join(root, "image.svg"));
    const commit = async (message: string) => {
        await git(repository, ["add", "."]);
        await git(repository, ["commit", "-m", message]);
        return (await git(repository, ["rev-parse", "HEAD"])).trim();
    };
    const first = await commit("Initial");
    writeFileSync(join(root, "dooc.yaml"), `# Formatting only\n${manifest}`);
    await commit("Comment");
    writeFileSync(
        join(root, "image.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>',
    );
    await commit("Image");
    writeFileSync(join(root, "dooc.yaml"), `${manifest}        title: New title\n`);
    await commit("Definition");
    writeFileSync(join(repository, "unrelated.txt"), "Not part of this document");
    const head = await commit("Unrelated");
    writeFileSync(join(root, "guide.md"), "Keep my unsaved working changes\n");
    const status = await git(repository, ["status", "--porcelain"]);
    const catalog = createDocumentVersions(projectRoot(join(root, "dooc.yaml")));
    try {
        const rows = await catalog.list();
        expect(rows.map((row) => row.version)).toEqual(["1.1.0", "1.0.1", "1.0.0"]);
        expect(rows[0]).toMatchObject({ current: true, revision: head });
        const old = rows.find((row) => row.version === "1.0.0");
        const snapshot = await catalog.open(old?.revision ?? first);
        expect(readFileSync(join(snapshot, "guide.md"), "utf8")).toContain("# Guide");
        expect(readFileSync(join(root, "guide.md"), "utf8")).toBe(
            "Keep my unsaved working changes\n",
        );
        expect(await git(repository, ["status", "--porcelain"])).toBe(status);
        expect((await git(repository, ["rev-parse", "HEAD"])).trim()).toBe(head);
        await expect(catalog.open("not-a-revision")).rejects.toThrow("not available");
    } finally {
        catalog.close();
    }
});

it("does not expose an uncommitted Git workspace as the default latest publication", async () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-version-unpublished-"));
    roots.push(root);
    writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
    await git(root, ["init", "-b", "main"]);
    const reader = await nodeWorkspaceOperations(
        join(root, "dooc.yaml"),
        undefined,
        undefined,
        true,
    );
    try {
        await expect(
            reader.ops.http?.({ method: "GET", url: "/", body: "", headers: {} }, { local: true }),
        ).rejects.toThrow("No published document versions");
    } finally {
        reader.close();
    }
});
