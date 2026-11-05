import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { compileSite } from "../compiler/compile.js";
import { exportEntries } from "../compiler/export.js";
import { siteIconResponse } from "./site-icon.js";

const roots: string[] = [];
const fixture = (manifest = "- one\n"): string => {
    const root = mkdtempSync(join(tmpdir(), "docs-site-icon-edit-"));
    roots.push(root);
    mkdirSync(join(root, "content"));
    writeFileSync(join(root, "content/one.md"), "---\ntitle: One\n---\n");
    writeFileSync(join(root, "manifest.yaml"), manifest);
    return root;
};
const data = Buffer.from('<svg viewBox="0 0 20 10"><path d="M0 0h20"/></svg>').toString("base64");
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("saves a square site SVG while preserving title, docs, comments and preview settings", () => {
    const root = fixture(
        "# Keep this\ntitle: Guide\ndefaultLang: jpn\ndocs: [one]\npreviews:\n  domains: [example.com]\n",
    );
    expect(siteIconResponse(root, { data }).status).toBe(200);
    const raw = readFileSync(join(root, "manifest.yaml"), "utf8");
    expect(raw).toContain("# Keep this");
    expect(parse(raw)).toEqual({
        title: "Guide",
        defaultLang: "jpn",
        docs: ["one"],
        previews: { domains: ["example.com"] },
        icon: "icons/_site.svg",
    });
    const compiled = compileSite(root);
    expect(compiled.errors).toEqual([]);
    expect(compiled.artifact.icon).toContain('viewBox="0 -5 20 20"');
    expect(exportEntries(root).filter((entry) => entry.name === "icons/_site.svg")).toHaveLength(1);
    const next = Buffer.from('<svg viewBox="0 0 8 8"><circle r="3"/></svg>').toString("base64");
    expect(siteIconResponse(root, { data: next }).status).toBe(200);
    expect(readFileSync(join(root, "icons/_site.svg"), "utf8")).toContain('<circle r="3"/>');
    expect(readFileSync(join(root, "manifest.yaml"), "utf8")).toBe(raw);
});

it("upgrades a list manifest and refuses to overwrite an unregistered icon", () => {
    const root = fixture();
    mkdirSync(join(root, "icons"));
    writeFileSync(join(root, "icons/_site.svg"), "unrelated");
    expect(siteIconResponse(root, { data }).status).toBe(409);
    expect(readFileSync(join(root, "icons/_site.svg"), "utf8")).toBe("unrelated");
    expect(readFileSync(join(root, "manifest.yaml"), "utf8")).toBe("- one\n");
    rmSync(join(root, "icons/_site.svg"));
    expect(siteIconResponse(root, { data }).status).toBe(200);
    expect(parse(readFileSync(join(root, "manifest.yaml"), "utf8"))).toEqual({
        docs: ["one"],
        icon: "icons/_site.svg",
    });
});

it("rejects invalid uploads and broken manifests without changing files", () => {
    const root = fixture();
    for (const input of [
        undefined,
        { data: null },
        { data: 7 },
        { data: Buffer.from("<svg/>").toString("base64") },
    ]) {
        expect(siteIconResponse(root, input).status).toBe(400);
    }
    expect(existsSync(join(root, "icons/_site.svg"))).toBe(false);
    writeFileSync(join(root, "manifest.yaml"), "title: [bad]\ndocs: [one]\n");
    expect(siteIconResponse(root, { data }).status).toBe(409);
    expect(existsSync(join(root, "icons/_site.svg"))).toBe(false);
    expect(readFileSync(join(root, "manifest.yaml"), "utf8")).toBe("title: [bad]\ndocs: [one]\n");
});

it("rejects site icons and manifests pointing outside the docs root", () => {
    const outside = fixture();
    const root = fixture("icon: icons/logo.svg\ndocs: [one]\n");
    mkdirSync(join(root, "icons"));
    writeFileSync(join(outside, "logo.svg"), "outside");
    symlinkSync(join(outside, "logo.svg"), join(root, "icons/logo.svg"));
    expect(siteIconResponse(root, { data }).status).toBe(400);
    expect(readFileSync(join(outside, "logo.svg"), "utf8")).toBe("outside");
    rmSync(join(root, "manifest.yaml"));
    symlinkSync(join(outside, "manifest.yaml"), join(root, "manifest.yaml"));
    expect(siteIconResponse(root, { data }).status).toBe(400);
    expect(readFileSync(join(outside, "manifest.yaml"), "utf8")).toBe("- one\n");
});
