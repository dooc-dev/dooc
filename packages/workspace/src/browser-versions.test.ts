import git from "isomorphic-git";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../../engine/src/compiler/host.js", () => import("./browser-host.js"));

import { projectRoot } from "../../engine/src/compiler/manifest.js";
import { fs } from "./browser-host.js";
import { createBrowserVersions } from "./browser-versions.js";

const root = "/browser-version-test";
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
it("reads first-parent versions in memory without checking out or changing working files", async () => {
    fs.mkdirSync(`${root}/docs`, { recursive: true });
    await git.init({ fs, dir: root, defaultBranch: "main" });
    fs.writeFileSync(
        `${root}/docs/dooc.yaml`,
        "version: { major: 1, minor: git, patch: git }\ndocument:\n  children: [ { document: { url: guide.md } } ]\n",
    );
    fs.writeFileSync(`${root}/docs/guide.md`, "Original\n");
    const commit = async () => {
        await git.add({ fs, dir: root, filepath: "." });
        return git.commit({
            fs,
            dir: root,
            message: "Change",
            author: { name: "Test", email: "test@example.com" },
        });
    };
    const first = await commit();
    fs.writeFileSync(`${root}/docs/guide.md`, "Updated\n");
    const head = await commit();
    fs.writeFileSync(`${root}/docs/guide.md`, "Unsaved\n");
    const versions = createBrowserVersions(root, projectRoot(`${root}/docs/dooc.yaml`));
    try {
        expect(await versions.list()).toEqual([
            { version: "1.0.1", revision: head, current: true },
            { version: "1.0.0", revision: first, current: false },
        ]);
        const snapshot = await versions.open(first);
        expect(String(fs.readFileSync(`${snapshot}/guide.md`))).toBe("Original\n");
        expect(String(fs.readFileSync(`${root}/docs/guide.md`))).toBe("Unsaved\n");
        expect(await git.resolveRef({ fs, dir: root, ref: "HEAD" })).toBe(head);
        await expect(versions.open("../workspace")).rejects.toThrow("not available");
    } finally {
        versions.close();
    }
});
