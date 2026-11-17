import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { manifestFile, projectRoot } from "../../engine/src/compiler/manifest.js";
import {
    prepareRemoteManifests,
    remoteManifestFile,
} from "../../engine/src/compiler/remote-manifests.js";
import type { DocumentVersionList } from "../../engine/src/core/document-version.js";
import { createDocumentVersions } from "./document-versions.js";
import { git } from "./git.js";
import { nodeWorkspaceOperations, type WorkspaceDescription } from "./workspace-server.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-section-versions-"));
    roots.push(root);
    mkdirSync(join(root, "child"));
    writeFileSync(
        join(root, "dooc.yaml"),
        "version: { major: 1, minor: 0, patch: 0 }\ndocument:\n  title: Parent\n  url: parent.md\n  children:\n    - document: { url: child/dooc.yaml }\n    - document: { url: sibling.dooc.yaml }\n",
    );
    writeFileSync(join(root, "parent.md"), "Parent content.\n");
    writeFileSync(
        join(root, "child/dooc.yaml"),
        "version: { major: 4, minor: 0, patch: git }\ndocument: { title: Child, url: child.md }\n",
    );
    writeFileSync(join(root, "child/child.md"), "Old child.\n");
    writeFileSync(
        join(root, "sibling.dooc.yaml"),
        "version: { major: 8, minor: 3, patch: 2 }\ndocument: { title: Sibling, url: sibling.md }\n",
    );
    writeFileSync(join(root, "sibling.md"), "Sibling content.\n");
    return root;
};

it("lists and opens the current section's versions without replacing the parent manifest or drafts", async () => {
    const root = setup();
    writeFileSync(
        join(root, "dooc.yaml"),
        readFileSync(join(root, "dooc.yaml"), "utf8").replace("patch: 0", "patch: git"),
    );
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Test"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    const commit = async () => {
        await git(root, ["add", "."]);
        await git(root, ["commit", "-m", "Change"]);
    };
    await commit();
    writeFileSync(join(root, "child/child.md"), "New child.\n");
    await commit();
    writeFileSync(join(root, "child/child.md"), "Unsaved child.\n");
    const session = { local: true };
    const editor = await nodeWorkspaceOperations(join(root, "dooc.yaml"));
    try {
        const list = async (manifest?: string) =>
            editor.ops.versions?.(
                { action: "list", manifest },
                session,
            ) as Promise<DocumentVersionList>;
        expect((await list()).selected).toBe("1.0.1");
        expect(await list("child/dooc.yaml")).toMatchObject({
            selected: "4.0.1",
            basePath: "/child",
            versions: [{ version: "4.0.1" }, { version: "4.0.0" }],
        });
        expect((await list("sibling.dooc.yaml")).selected).toBe("8.3.2");
        expect(manifestFile(root)).toBe("dooc.yaml");
        const oldParent = (await editor.ops.versions?.(
            { action: "open", version: "1.0.0" },
            session,
        )) as WorkspaceDescription;
        const oldChild = (await editor.ops.versions?.(
            { workspace: oldParent.id, action: "list", manifest: "child/dooc.yaml" },
            session,
        )) as DocumentVersionList;
        expect(oldChild.selected).toBe("4.0.0");
        const historical = (await editor.ops.versions?.(
            { action: "open", version: "4.0.0", manifest: "child/dooc.yaml" },
            session,
        )) as WorkspaceDescription;
        expect(historical).toMatchObject({ readOnly: true, manifest: "child/dooc.yaml" });
        const page = (await editor.ops.http?.(
            { workspace: historical.id, method: "GET", url: "/", headers: {}, body: "" },
            session,
        )) as { body: string };
        expect(page.body).toContain("Old child.");
        expect(page.body).not.toContain("Parent content.");
        const historicalList = (await editor.ops.versions?.(
            { workspace: historical.id, action: "list" },
            session,
        )) as DocumentVersionList;
        expect(historicalList.selected).toBe("4.0.0");
        const current = (await editor.ops.versions?.(
            { workspace: historical.id, action: "open", version: "latest" },
            session,
        )) as WorkspaceDescription;
        expect(current.id).toBe("main");
        expect(readFileSync(join(root, "child/child.md"), "utf8")).toBe("Unsaved child.\n");
        await expect(list("../dooc.yaml")).rejects.toThrow("not available");
    } finally {
        editor.close();
    }
}, 30_000);

it("isolates a named manifest's manual version without changing the parent's active manifest", async () => {
    const root = setup();
    projectRoot(join(root, "dooc.yaml"));
    const catalog = createDocumentVersions(root, "sibling.dooc.yaml");
    try {
        expect(await catalog.list()).toEqual([
            { version: "8.3.2", revision: "current", current: true },
        ]);
        const snapshot = await catalog.open("current");
        expect(manifestFile(snapshot)).toBe("sibling.dooc.yaml");
        expect(manifestFile(root)).toBe("dooc.yaml");
        expect(readFileSync(join(snapshot, "sibling.md"), "utf8")).toContain("Sibling content");
    } finally {
        catalog.close();
    }
});

it("uses the remote repository's version history for an imported Git manifest", async () => {
    const root = setup();
    const remote = mkdtempSync(join(tmpdir(), "dooc-remote-version-"));
    roots.push(remote);
    writeFileSync(
        join(remote, "dooc.yaml"),
        "version: { major: 7, minor: 0, patch: git }\ndocument: { title: Remote, url: guide.md }\n",
    );
    writeFileSync(join(remote, "guide.md"), "Remote old text.\n");
    await git(remote, ["init", "-b", "main"]);
    await git(remote, ["config", "user.name", "Test"]);
    await git(remote, ["config", "user.email", "test@example.com"]);
    await git(remote, ["add", "."]);
    await git(remote, ["commit", "-m", "Initial"]);
    writeFileSync(join(remote, "guide.md"), "Remote new text.\n");
    await git(remote, ["add", "."]);
    await git(remote, ["commit", "-m", "Update"]);
    const url = "https://github.com/team/remote/blob/main/docs/dooc.yaml";
    writeFileSync(
        join(root, "dooc.yaml"),
        `version: { major: 1, minor: 0, patch: 0 }\ndocument:\n  children:\n    - document: { url: ${url} }\n`,
    );
    await prepareRemoteManifests(root, async () => projectRoot(join(remote, "dooc.yaml")));
    const editor = await nodeWorkspaceOperations(join(root, "dooc.yaml"));
    const session = { local: true };
    try {
        const manifest = remoteManifestFile(url);
        const rows = (await editor.ops.versions?.(
            { action: "list", manifest },
            session,
        )) as DocumentVersionList;
        expect(rows.versions.map(({ version }) => version)).toEqual(["7.0.1", "7.0.0"]);
        const historical = (await editor.ops.versions?.(
            { action: "open", manifest, version: "7.0.0" },
            session,
        )) as WorkspaceDescription;
        const result = (await editor.ops.http?.(
            { workspace: historical.id, method: "GET", url: "/", headers: {}, body: "" },
            session,
        )) as { body: string };
        expect(result.body).toContain("Remote old text.");
        expect(readFileSync(join(remote, "guide.md"), "utf8")).toBe("Remote new text.\n");
    } finally {
        editor.close();
    }
}, 30_000);
