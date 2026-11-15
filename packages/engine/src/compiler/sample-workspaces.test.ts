import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkSite } from "./check.js";
import { compileSite } from "./compile.js";
import { exportEntries } from "./export.js";
import { loadSubformat, parseSubformatRecord, validateSubformatRecord } from "./subformats.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([
    ["dooc-docs", ["feature"]],
    ["sample/dooc-sample-saas", ["container", "slo", "incident"]],
    ["sample/dooc-sample-project", ["project", "milestone", "issue", "note"]],
] as const)("keeps %s usable as an independent source export", (source, expectedTypes) => {
    const temp = mkdtempSync(join(tmpdir(), "dooc-workspace-"));
    roots.push(temp);
    const root = join(temp, "source");
    cpSync(resolve(import.meta.dirname, "../../../..", source), root, { recursive: true });
    const site = compileSite(root);
    expect(site.errors).toEqual([]);
    expect(site.subformats?.map((type) => type.ext)).toEqual(
        expect.arrayContaining([...expectedTypes]),
    );
    if (source === "dooc-docs")
        expect(site.subformats?.map((type) => type.ext)).toEqual(["feature"]);
    else expect(site.subformats?.some((type) => type.ext === "feature")).toBe(false);

    const checkPaths = (directory: string, value: unknown): void => {
        if (typeof value === "string" && value.startsWith("contents/"))
            expect(existsSync(join(directory, value)), value).toBe(true);
        else if (value && typeof value === "object")
            for (const child of Object.values(value)) checkPaths(directory, child);
    };
    for (const config of site.subformats ?? []) {
        const format = loadSubformat(root, config);
        const template = parseSubformatRecord(format.template, config.format);
        expect(() => validateSubformatRecord(format, template)).not.toThrow();
    }
    const exported = join(temp, "exported");
    for (const entry of exportEntries(root)) {
        const path = join(exported, entry.name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, entry.data);
    }
    rmSync(root, { recursive: true });
    const reopened = compileSite(exported);
    expect(reopened.errors).toEqual([]);
    expect(reopened.docs.map((doc) => doc.id)).toEqual(site.docs.map((doc) => doc.id));
    const records = reopened.docs.flatMap((doc) => doc.subformat?.records ?? []);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) checkPaths(exported, record.data);
    const report = checkSite(exported, { only: ["render"] });
    expect(report.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
});
