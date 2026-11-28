import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { checkSite } from "../packages/engine/src/compiler/check.js";
import { loadCodeLanguages } from "../packages/engine/src/compiler/code-languages.js";
import { compileSite } from "../packages/engine/src/compiler/compile.js";
import { exportEntries } from "../packages/engine/src/compiler/export.js";
import { walkBlocks } from "../packages/engine/src/core/blocks.js";
import { createDocumentVersions } from "../packages/server/src/document-versions.js";
import { createDevWorkspace, syncDevWorkspace } from "./dev-workspace.js";

it("syncs generated changes without overwriting local edits, deletions or redirected files", () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-dev-sync-"));
    const snapshot = (files: Record<string, string>) =>
        new Map(Object.entries(files).map(([file, body]) => [file, Buffer.from(body)]));
    const before = snapshot({
        "updated.md": "Old source",
        "edited.md": "Old source",
        "deleted.md": "Old source",
        "removed.md": "Old source",
        "redirected.md": "Old source",
    });
    const after = snapshot({
        "updated.md": "New source",
        "edited.md": "New source",
        "deleted.md": "New source",
        "redirected.md": "New source",
        "added.md": "New page",
        "collision.md": "New page",
    });
    try {
        for (const [file, body] of before) writeFileSync(join(root, file), body);
        writeFileSync(join(root, "edited.md"), "Local edit");
        writeFileSync(join(root, "collision.md"), "Local page");
        writeFileSync(join(root, "private.txt"), "Keep runtime data");
        rmSync(join(root, "deleted.md"));
        rmSync(join(root, "redirected.md"));
        symlinkSync(join(root, "private.txt"), join(root, "redirected.md"));
        const result = syncDevWorkspace(root, before, after);
        expect(result.updated.sort()).toEqual(["added.md", "removed.md", "updated.md"]);
        expect(result.conflicts.sort()).toEqual([
            "collision.md",
            "deleted.md",
            "edited.md",
            "redirected.md",
        ]);
        expect(readFileSync(join(root, "updated.md"), "utf8")).toBe("New source");
        expect(readFileSync(join(root, "added.md"), "utf8")).toBe("New page");
        expect(readFileSync(join(root, "edited.md"), "utf8")).toBe("Local edit");
        expect(readFileSync(join(root, "collision.md"), "utf8")).toBe("Local page");
        expect(readFileSync(join(root, "private.txt"), "utf8")).toBe("Keep runtime data");
        expect(existsSync(join(root, "deleted.md"))).toBe(false);
        expect(existsSync(join(root, "removed.md"))).toBe(false);
        expect(syncDevWorkspace(root, after, after)).toEqual({ updated: [], conflicts: [] });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it("generates a complete feature playground and resets only the selected workspace", async () => {
    const parent = mkdtempSync(join(tmpdir(), "dooc-dev-workspace-"));
    const localReport = mkdtempSync(
        fileURLToPath(new URL("../dooc-docs/contents/dooc-test-report-", import.meta.url)),
    );
    const root = join(parent, "editor");
    const testPageUrl = "http://127.0.0.1:2002/";
    try {
        writeFileSync(join(parent, "keep.txt"), "Keep this\n");
        writeFileSync(join(localReport, "local.md"), "Local verification output\n");
        createDevWorkspace(root, testPageUrl);
        expect(existsSync(join(root, "contents", basename(localReport)))).toBe(false);
        for (const artifact of [
            "contents/md/progress.md",
            "contents/md/icon-variants.md",
            "contents/md/theme-variants.md",
            "contents/html/icon-variants.html",
            "contents/html/theme-variants.html",
            "contents/png/theme-variants",
            "contents/svg/icon-variants",
        ])
            expect(existsSync(join(root, artifact)), artifact).toBe(false);
        const generated = ["", "nested/"].flatMap((directory) =>
            [
                "build/index.html",
                "dist/bundle.zip",
                "dooc-reader-web/index.html",
                ".dooc/user/login.json",
            ].map((file) => directory + file),
        );
        expect(
            execFileSync("git", ["-C", root, "check-ignore", "--stdin"], {
                input: generated.join("\n"),
                encoding: "utf8",
            })
                .trim()
                .split("\n"),
        ).toEqual(generated);
        const before = readFileSync(join(root, "contents/md/start.md"), "utf8");
        const report = checkSite(root, { only: ["render"] });
        expect(report.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
        expect(report.languages).toEqual(expect.arrayContaining(["eng", "jpn", "zho"]));
        const site = compileSite(root);
        expect(site.errors).toEqual([]);
        expect(site.docs.find((doc) => doc.url === testPageUrl)?.title).toBe("Iframe test page");
        expect(new Set(site.subformats?.map((format) => format.format))).toEqual(
            new Set(["json", "yaml", "toml"]),
        );
        expect(new Set(site.figures.map((figure) => figure.kind))).toEqual(
            new Set(["svg", "image", "video", "html", "pdf"]),
        );
        const blocks = site.docs.flatMap((doc) => [...walkBlocks(doc.blocks)]);
        expect([...new Set(blocks.map((block) => block.type))]).toEqual(
            expect.arrayContaining([
                "table",
                "code",
                "callout",
                "term",
                "graph",
                "schemaGraph",
                "themeVariants",
                "external",
            ]),
        );
        expect((await loadCodeLanguages(root)).codeLanguages).toContain("taskplan");
        const exported = exportEntries(root).map((entry) => entry.name);
        expect(exported).toEqual(
            expect.arrayContaining([
                "contents/task/first.task",
                "contents/md/atlas.md",
                "contents/md/atlas-records.md",
                "contents/dxf/mounting-plate.dxf",
                "contents/svg/hosting.drawio.svg",
                "locales/jpn/contents/md/start.md",
                "locales/zho/contents/md/start.md",
                "themes/dark/contents/svg/workflow.svg",
                ".dooc/fonts/udev-gothic-regular.woff2",
                ".dooc/fonts/LICENSE.txt",
                ".dooc/code-languages/taskplan.json",
                ".dooc/editor-tools/json.json",
                ".dooc/editor-tools/json.mjs",
            ]),
        );
        const versions = createDocumentVersions(root);
        try {
            expect((await versions.list()).map((row) => row.version)).toEqual(["1.0.1", "1.0.0"]);
        } finally {
            await versions.close();
        }
        const previousTask = execFileSync(
            "git",
            ["-C", root, "show", "example:contents/task/first.task"],
            { encoding: "utf8" },
        );
        expect(JSON.parse(previousTask).status).toBe("Todo");
        expect(
            JSON.parse(readFileSync(join(root, "contents/task/first.task"), "utf8")).status,
        ).toBe("Doing");
        expect(
            execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }),
        ).toBe("");
        expect(
            execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
                encoding: "utf8",
            }).trim(),
        ).toBe(root);
        writeFileSync(join(root, "extra.txt"), "Disposable edit\n");
        writeFileSync(join(root, "contents/md/start.md"), "Changed\n");
        createDevWorkspace(root, testPageUrl);
        expect(readFileSync(join(root, "contents/md/start.md"), "utf8")).toBe(before);
        expect(existsSync(join(root, "extra.txt"))).toBe(false);
        expect(readFileSync(join(parent, "keep.txt"), "utf8")).toBe("Keep this\n");
    } finally {
        rmSync(parent, { recursive: true, force: true });
        rmSync(localReport, { recursive: true, force: true });
    }
}, 60_000);

it("ships a working JSON formatter and linter for the editing playground", () => {
    const script = new URL("fixtures/dev-workspace/.dooc/editor-tools/json.mjs", import.meta.url);
    const run = (mode: string, input: string) =>
        spawnSync(process.execPath, [script.pathname, mode], { input, encoding: "utf8" });
    const formatted = run("format", '{"debug":false,"items":[1,2]}');
    expect(formatted.status).toBe(0);
    expect(formatted.stdout).toBe(`${JSON.stringify({ debug: false, items: [1, 2] }, null, 2)}\n`);
    expect(JSON.parse(run("lint", '{"debug":false}').stdout)).toEqual([]);
    expect(JSON.parse(run("lint", '{"debug":true}').stdout)[0].severity).toBe("warning");
    const invalid = run("lint", "{");
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stdout)[0].severity).toBe("error");
    expect(run("format", "{").status).toBe(1);
});
