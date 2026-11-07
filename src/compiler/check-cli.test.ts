import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const run = (root: string, ...args: string[]) => {
    const result = spawnSync(
        process.execPath,
        [
            "--import",
            createRequire(import.meta.url).resolve("tsx"),
            fileURLToPath(new URL("../cli.ts", import.meta.url)),
            "check",
            ...args,
        ],
        { cwd: root, encoding: "utf8", timeout: 20_000 },
    );
    if (result.error) throw result.error;
    return result;
};

it("prints one JSON report and returns policy exit codes with cwd as the default root", () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-check-cli-"));
    roots.push(root);
    mkdirSync(join(root, "content"));
    writeFileSync(join(root, "dooc.yaml"), "defaultLang: eng\nlanguages: [eng]\ndocs: [guide]\n");
    writeFileSync(
        join(root, "content/guide.md"),
        "---\ntitle: Guide\n---\nThis document explains how to configure the application and prepare translated content for readers around the world.\n",
    );
    let result = run(root);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, root, exitCode: 0 });
    writeFileSync(
        join(root, "dooc.yaml"),
        "defaultLang: eng\nlanguages: [eng, jpn]\ndocs: [guide]\n",
    );
    result = run(root, "--only", "languages", "--allow-shared-svg");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).diagnostics).toContainEqual(
        expect.objectContaining({
            code: "TRANSLATION_MISSING",
            sourceFile: "content/guide.md",
            file: "locales/jpn/content/guide.md",
        }),
    );
    for (const args of [
        ["--typo"],
        ["--only"],
        ["--only", "languages,,themes"],
        ["--languages", "eng"],
        [".", "extra"],
    ]) {
        result = run(root, ...args);
        expect(result.status).toBe(2);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout).diagnostics[0].code).toBe("INVOCATION_INVALID");
    }
}, 20_000);

it("keeps warnings machine readable when CI promotes them to failures", () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-check-cli-"));
    roots.push(root);
    mkdirSync(join(root, "content"));
    writeFileSync(join(root, "dooc.yaml"), "defaultLang: eng\ndocs: [guide]\n");
    writeFileSync(
        join(root, "content/guide.md"),
        "---\ntitle: Guide\n---\nこの文章では、設定ファイルの使い方について詳しく説明します。\n",
    );
    const result = run(root, "--warnings-as-errors");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
        exitCode: 1,
        summary: { errors: 0, warnings: 1 },
    });
    expect(run(root, "--help").stdout).toContain("schemaVersion=1");
});
