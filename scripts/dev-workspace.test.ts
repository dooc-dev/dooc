import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { checkSite } from "../packages/engine/src/compiler/check.js";
import { loadCodeLanguages } from "../packages/engine/src/compiler/code-languages.js";
import { compileSite } from "../packages/engine/src/compiler/compile.js";
import { exportEntries } from "../packages/engine/src/compiler/export.js";
import { walkBlocks } from "../packages/engine/src/core/blocks.js";
import { createDocumentVersions } from "../packages/server/src/document-versions.js";
import { createDevWorkspace } from "./dev-workspace.js";

it("generates a complete feature playground and resets only the selected workspace", async () => {
    const parent = mkdtempSync(join(tmpdir(), "dooc-dev-workspace-"));
    const root = join(parent, "editor");
    try {
        writeFileSync(join(parent, "keep.txt"), "Keep this\n");
        createDevWorkspace(root);
        const before = readFileSync(join(root, "contents/md/start.md"), "utf8");
        const report = checkSite(root, { only: ["render"] });
        expect(report.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
        expect(report.languages).toEqual(expect.arrayContaining(["eng", "jpn", "zho"]));
        const site = compileSite(root);
        expect(site.errors).toEqual([]);
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
        createDevWorkspace(root);
        expect(readFileSync(join(root, "contents/md/start.md"), "utf8")).toBe(before);
        expect(existsSync(join(root, "extra.txt"))).toBe(false);
        expect(readFileSync(join(parent, "keep.txt"), "utf8")).toBe("Keep this\n");
    } finally {
        rmSync(parent, { recursive: true, force: true });
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
