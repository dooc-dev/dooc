import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { parse } from "yaml";
import { readManifest } from "../compiler/manifest.js";
import { createDocOps } from "../compiler/ops.js";
import { defaultPreviewSettings } from "../core/previewers.js";
import { previewSettingsResponse } from "./preview-settings.js";

let root: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dooc-preview-settings-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it.each([
    null,
    "- guide\n",
    "# Site\ntitle: Docs\ndocs:\n  - guide # Keep\n",
])("edits registrations without losing the document tree: %s", (raw) => {
    if (raw) writeFileSync(join(root, "dooc.yaml"), raw);
    expect(previewSettingsResponse(root, { action: "read" })).toEqual({
        status: 200,
        body: { base: raw, settings: defaultPreviewSettings() },
    });
    const settings = defaultPreviewSettings();
    settings.domains = ["data.example.com"];
    const saved = previewSettingsResponse(root, { action: "save", base: raw, settings });
    expect(saved.status).toBe(200);
    const text = readFileSync(join(root, "dooc.yaml"), "utf8");
    expect(parse(text)).toMatchObject({ docs: raw ? ["guide"] : [], previews: settings });
    if (raw?.startsWith("#")) {
        expect(text).toContain("# Site");
        expect(text).toContain("# Keep");
    }
    expect(previewSettingsResponse(root, { action: "read" }).body).toEqual({
        settings,
        base: text,
    });
});

it("preserves registrations through add, move, rename and delete", () => {
    const settings = defaultPreviewSettings();
    settings.domains = ["example.com"];
    expect(previewSettingsResponse(root, { action: "save", base: null, settings }).status).toBe(
        200,
    );
    const ops = createDocOps(root);
    expect(ops.add("guide", "Guide")).not.toHaveProperty("error");
    expect(ops.add("child", "Child")).not.toHaveProperty("error");
    expect(ops.move("child", "guide")).not.toHaveProperty("error");
    expect(ops.rename("child", "detail")).not.toHaveProperty("error");
    expect(ops.remove("detail")).not.toHaveProperty("error");
    expect(readManifest(root).previews).toEqual(settings);
});

it("refuses stale writes, invalid registrations and malformed manifests without touching disk", () => {
    const path = join(root, "dooc.yaml");
    const raw = "title: Docs\ndocs: []\n";
    writeFileSync(path, raw);
    expect(previewSettingsResponse(root, { action: "save", base: null, settings: {} }).status).toBe(
        409,
    );
    expect(previewSettingsResponse(root, { action: "save", settings: {} }).status).toBe(400);
    expect(
        previewSettingsResponse(root, { action: "save", base: raw, settings: { domains: ["*"] } })
            .status,
    ).toBe(400);
    expect(readFileSync(path, "utf8")).toBe(raw);
    writeFileSync(path, "title: [broken\n");
    expect(
        previewSettingsResponse(root, { action: "save", base: "title: [broken\n", settings: {} })
            .status,
    ).toBe(409);
    expect(readFileSync(path, "utf8")).toBe("title: [broken\n");
});
