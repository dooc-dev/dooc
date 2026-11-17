import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { pageUrlKind } from "../core/content-metadata.js";
import { remoteManifestSource } from "../core/remote-manifest.js";
import { docPath } from "../core/routing.js";
import { compileSite } from "./compile.js";
import { exportEntries } from "./export.js";
import { projectRoot, readManifest, sectionManifest } from "./manifest.js";
import { createDocOps } from "./ops.js";
import { prepareRemoteManifests, remoteManifestFile } from "./remote-manifests.js";
import { writeTextfile } from "./textfile.js";

const roots: string[] = [];
const workspace = () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-remote-test-"));
    roots.push(root);
    return root;
};
const put = (root: string, file: string, body: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), body);
};
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("identifies GitHub file URLs and explicit Git refs without changing ordinary links", () => {
    const source = {
        repository: "https://github.com/team/docs.git",
        ref: "main",
        path: "reference/dooc.yaml",
    };
    for (const url of [
        "https://github.com/team/docs/blob/main/reference/dooc.yaml",
        "https://raw.githubusercontent.com/team/docs/main/reference/dooc.yaml",
        "https://github.com/team/docs.git#main:reference/dooc.yaml",
    ]) {
        expect(remoteManifestSource(url)).toEqual(source);
        expect(pageUrlKind(url)).toBe("manifest");
    }
    expect(pageUrlKind("https://example.com/guide")).toBe("link");
    expect(
        remoteManifestSource(
            "https://raw.githubusercontent.com/team/docs/refs/heads/main/reference/dooc.yaml",
        ),
    ).toEqual({ ...source, ref: "refs/heads/main" });
    expect(
        remoteManifestSource("https://git.example.com/docs.git#release%2Fv1:api.dooc.yaml").ref,
    ).toBe("release/v1");
    for (const url of [
        "http://github.com/team/docs/blob/main/dooc.yaml",
        "https://token@github.com/team/docs/blob/main/dooc.yaml",
        "https://127.0.0.1/docs.git#main:dooc.yaml",
        "https://github.com/team/docs.git#main:../dooc.yaml",
        "https://github.com/team/docs.git#--upload-pack:dooc.yaml",
    ])
        expect(() => remoteManifestSource(url)).toThrow();
});

it("compiles and exports remote sections with relative dependencies and source-owned history", async () => {
    const root = workspace();
    const source = workspace();
    const url = "https://github.com/team/docs/blob/main/reference/dooc.yaml";
    put(
        root,
        "dooc.yaml",
        `version: { major: 1, minor: 0, patch: 0 }\ndocument:\n  children:\n    - document: { url: ${url} }\n`,
    );
    put(
        source,
        "dooc.yaml",
        "version: { major: 4, minor: 2, patch: 0 }\ndocument:\n  title: Reference\n  url: intro.md\n  children:\n    - document: { url: child/dooc.yaml }\n",
    );
    put(source, "intro.md", "Remote introduction.\n\n![](image.svg)\n");
    put(
        source,
        "image.svg",
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="3"/></svg>',
    );
    put(
        source,
        "themes/dark/image.svg",
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
    );
    put(source, "child/dooc.yaml", "document: { title: Child, url: page.md }\n");
    put(source, "child/page.md", "Remote child content.\n");
    const load = vi.fn(async () => projectRoot(join(source, "dooc.yaml")));
    await prepareRemoteManifests(root, load);
    await prepareRemoteManifests(root, load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith({
        repository: "https://github.com/team/docs.git",
        ref: "main",
        path: "reference/dooc.yaml",
    });
    const compiled = compileSite(root);
    expect(compiled.errors).toEqual([]);
    expect(compiled.docs.map((doc) => docPath(compiled.docs, doc.id))).toEqual([
        "/",
        "/reference",
        "/reference/child",
    ]);
    expect(compiled.docs[1]?.body).toContain("Remote introduction");
    expect(compiled.docs[1]?.blocks.some((block) => block.type === "themeVariants")).toBe(true);
    expect(compiled.docs[2]?.body).toContain("Remote child content");
    expect(sectionManifest(root, remoteManifestFile(url))).toBe(join(source, "dooc.yaml"));
    expect(readManifest(root).version?.major).toBe(1);
    expect(readFileSync(join(root, "dooc.yaml"), "utf8")).toContain(url);
    const entry = compiled.docs[1];
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(createDocOps(root).write(entry.id, "Changed")).toMatchObject({ status: 403 });
    expect(() => writeTextfile(root, entry.file, "Changed", "Remote introduction.\n")).toThrow(
        "read-only",
    );
    const copied = workspace();
    for (const entry of exportEntries(root)) put(copied, entry.name, entry.data.toString());
    expect(compileSite(copied).errors).toEqual([]);
    expect(exportEntries(root).some(({ name }) => name.endsWith("/image.svg"))).toBe(true);
    expect(exportEntries(root).some(({ name }) => name.endsWith("/themes/dark/image.svg"))).toBe(
        true,
    );
});

it("rejects remote include cycles even when URL spellings differ", async () => {
    const root = workspace();
    const source = workspace();
    put(
        root,
        "dooc.yaml",
        "document: { url: 'https://github.com/team/docs/blob/main/dooc.yaml' }\n",
    );
    put(
        source,
        "dooc.yaml",
        "document: { url: 'https://github.com/team/docs.git#main:dooc.yaml' }\n",
    );
    await expect(
        prepareRemoteManifests(root, async () => projectRoot(join(source, "dooc.yaml"))),
    ).rejects.toThrow("Circular");
});

it("never follows cache symlinks when materializing remote content", async () => {
    const root = workspace();
    const source = workspace();
    const url = "https://github.com/team/docs/blob/main/dooc.yaml";
    put(root, "dooc.yaml", `document: { url: '${url}' }\n`);
    put(root, "original.md", "Keep this local file.\n");
    put(source, "dooc.yaml", "document: { url: guide.md }\n");
    put(source, "guide.md", "Remote content.\n");
    const folder = join(root, dirname(remoteManifestFile(url)));
    mkdirSync(folder, { recursive: true });
    symlinkSync(join(root, "original.md"), join(folder, "guide.md"));
    await expect(
        prepareRemoteManifests(root, async () => projectRoot(join(source, "dooc.yaml"))),
    ).rejects.toThrow("symbolic links");
    expect(readFileSync(join(root, "original.md"), "utf8")).toBe("Keep this local file.\n");
});
