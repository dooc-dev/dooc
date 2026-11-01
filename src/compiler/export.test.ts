import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportEntries } from "./export.js";
import { zip } from "./zip.js";

describe("export / zip", () => {
    it("collects only the convention folders (excluding dotfiles) into a zip that unzip can read back", () => {
        const root = mkdtempSync(join(tmpdir(), "docs-export-"));
        mkdirSync(join(root, "content", "guide"), { recursive: true });
        mkdirSync(join(root, "figures"));
        mkdirSync(join(root, "dist"));
        mkdirSync(join(root, "presentations"));
        writeFileSync(join(root, "presentations", "old.html"), "legacy");
        writeFileSync(join(root, "content", "guide", "日本語.md"), "Body\n");
        writeFileSync(join(root, "content", "guide", ".swp"), "x");
        writeFileSync(join(root, "figures", "a.svg"), "<svg/>".repeat(100));
        writeFileSync(join(root, "dist", "index.html"), "x");
        const entries = exportEntries(root);
        expect(entries.map((e) => e.name)).toEqual(["content/guide/日本語.md", "figures/a.svg"]);

        const out = join(root, "out.zip");
        writeFileSync(out, zip(entries));
        expect(
            execFileSync("unzip", ["-p", out, "content/guide/日本語.md"], { encoding: "utf8" }),
        ).toBe("Body\n");
        expect(execFileSync("unzip", ["-p", out, "figures/a.svg"], { encoding: "utf8" })).toBe(
            "<svg/>".repeat(100),
        );
    });

    it("includes the root manifest and docs.config.mjs when present", () => {
        const root = mkdtempSync(join(tmpdir(), "docs-export-config-"));
        mkdirSync(join(root, "content"));
        writeFileSync(join(root, "content", "a.md"), "Body\n");
        writeFileSync(join(root, "docs.config.mjs"), 'export default { defaultLang: "ja" };\n');
        writeFileSync(join(root, "manifest.yaml"), "- a\n");
        const entries = exportEntries(root);
        expect(entries.map((e) => e.name)).toEqual([
            "docs.config.mjs",
            "manifest.yaml",
            "content/a.md",
        ]);
        expect(entries.find((e) => e.name === "manifest.yaml")?.data.toString()).toBe("- a\n");
    });
});
