import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { updateFormula, updateInstallExample } from "./formula.js";

const formula = readFileSync(new URL("../../Formula/dooc.rb", import.meta.url), "utf8");
const platforms = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const hash = (index: number) => String(index).repeat(64);
const sums = platforms.map((name, i) => `${hash(i)}  dooc-${name}.tar.gz`).join("\n");

it("rewrites the version, every archive URL and its checksum", () => {
    const updated = updateFormula(formula, "9.8.7", `${sums}\n`);
    expect(updated).toContain('  version "9.8.7"');
    expect(updated).toContain("  version_scheme 1");
    platforms.forEach((name, i) => {
        expect(updated).toContain(
            `download/dooc-v9.8.7/dooc-${name}.tar.gz"\n      sha256 "${hash(i)}"`,
        );
    });
    expect(updated.match(/dooc-v9\.8\.7/g)).toHaveLength(4);
    expect(updated.split("\n")).toHaveLength(formula.split("\n").length);
});

it("refuses a release that lacks an archive checksum", () => {
    expect(() => updateFormula(formula, "9.8.7", sums.split("\n").slice(1).join("\n"))).toThrow(
        "dooc-darwin-arm64.tar.gz",
    );
});

it("updates the pinned installer example", () => {
    const page = readFileSync(
        new URL("../../dooc-docs/contents/md/install.md", import.meta.url),
        "utf8",
    );
    expect(updateInstallExample(page, "9.8.7")).toContain("DOOC_VERSION=9.8.7 DOOC_INSTALL_DIR");
});
