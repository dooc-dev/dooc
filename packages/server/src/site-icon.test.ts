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
import { compileSite } from "../../engine/src/compiler/compile.js";
import { exportEntries } from "../../engine/src/compiler/export.js";
import { publishHtml, siteFrom } from "./serve.js";
import { siteIconResponse } from "./site-icon.js";

const roots: string[] = [];
const fixture = (manifest = "- one\n"): string => {
    const root = mkdtempSync(join(tmpdir(), "docs-site-icon-edit-"));
    roots.push(root);
    mkdirSync(join(root, "content"));
    writeFileSync(join(root, "content/one.md"), "");
    writeFileSync(join(root, "dooc.yaml"), manifest);
    return root;
};
const data = Buffer.from('<svg viewBox="0 0 20 10"><path d="M0 0h20"/></svg>').toString("base64");
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("saves a square site SVG while preserving title, docs, comments and language", () => {
    const root = fixture("# Keep this\ntitle: Guide\ndefaultLang: jpn\ndocs: [one]\n");
    expect(siteIconResponse(root, { data }).status).toBe(200);
    const raw = readFileSync(join(root, "dooc.yaml"), "utf8");
    expect(raw).toContain("# Keep this");
    expect(parse(raw)).toEqual({
        title: "Guide",
        defaultLang: "jpn",
        docs: ["one"],
        icon: "files/svg/_site.svg",
    });
    const compiled = compileSite(root);
    expect(compiled.errors).toEqual([]);
    expect(compiled.icon).toContain('viewBox="0 -5 20 20"');
    expect(
        exportEntries(root).filter((entry) => entry.name === "files/svg/_site.svg"),
    ).toHaveLength(1);
    const next = Buffer.from('<svg viewBox="0 0 8 8"><circle r="3"/></svg>').toString("base64");
    expect(siteIconResponse(root, { data: next }).status).toBe(200);
    expect(readFileSync(join(root, "files/svg/_site.svg"), "utf8")).toContain('<circle r="3"/>');
    expect(readFileSync(join(root, "dooc.yaml"), "utf8")).toBe(raw);
});

it("upgrades a list manifest and refuses to overwrite an unregistered icon", () => {
    const root = fixture();
    mkdirSync(join(root, "files/svg"), { recursive: true });
    writeFileSync(join(root, "files/svg/_site.svg"), "unrelated");
    expect(siteIconResponse(root, { data }).status).toBe(409);
    expect(readFileSync(join(root, "files/svg/_site.svg"), "utf8")).toBe("unrelated");
    expect(readFileSync(join(root, "dooc.yaml"), "utf8")).toBe("- one\n");
    rmSync(join(root, "files/svg/_site.svg"));
    expect(siteIconResponse(root, { data }).status).toBe(200);
    expect(parse(readFileSync(join(root, "dooc.yaml"), "utf8"))).toEqual({
        docs: ["one"],
        icon: "files/svg/_site.svg",
    });
});

it("keeps the explicit choice to disable format placement", () => {
    const root = fixture("files: {defaultLayout: false}\ndocs: [one]\n");
    expect(siteIconResponse(root, { data }).status).toBe(200);
    expect(existsSync(join(root, "icons/_site.svg"))).toBe(true);
    expect(compileSite(root).errors).toEqual([]);
});

it("renders theme variants of the site icon next to the base icon", () => {
    const root = fixture("icon: icons/logo.svg\ndocs: [one]\n");
    mkdirSync(join(root, "icons"));
    mkdirSync(join(root, "themes/dark/icons"), { recursive: true });
    writeFileSync(join(root, "icons/logo.svg"), '<svg viewBox="0 0 8 8"><circle r="1"/></svg>');
    writeFileSync(
        join(root, "themes/dark/icons/logo.svg"),
        '<svg viewBox="0 0 8 8"><circle r="2"/></svg>',
    );
    const compiled = compileSite(root);
    expect(compiled.errors).toEqual([]);
    expect(compiled.iconVariants?.dark).toContain('<circle r="2"/>');
    const html = publishHtml(siteFrom(compiled), "");
    expect(html).toContain('<span data-theme-variant=""><img id="site-icon"');
    expect(html).toContain('<img data-theme-variant="dark" alt="" src="data:image/svg+xml');
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
    expect(existsSync(join(root, "files/svg/_site.svg"))).toBe(false);
    writeFileSync(join(root, "dooc.yaml"), "title: [bad]\ndocs: [one]\n");
    expect(siteIconResponse(root, { data }).status).toBe(409);
    expect(existsSync(join(root, "files/svg/_site.svg"))).toBe(false);
    expect(readFileSync(join(root, "dooc.yaml"), "utf8")).toBe("title: [bad]\ndocs: [one]\n");
});

it("rejects site icons and manifests pointing outside the docs root", () => {
    const outside = fixture();
    const root = fixture("icon: icons/logo.svg\ndocs: [one]\n");
    mkdirSync(join(root, "icons"));
    writeFileSync(join(outside, "logo.svg"), "outside");
    symlinkSync(join(outside, "logo.svg"), join(root, "icons/logo.svg"));
    expect(siteIconResponse(root, { data }).status).toBe(400);
    expect(readFileSync(join(outside, "logo.svg"), "utf8")).toBe("outside");
    rmSync(join(root, "dooc.yaml"));
    symlinkSync(join(outside, "dooc.yaml"), join(root, "dooc.yaml"));
    expect(siteIconResponse(root, { data }).status).toBe(400);
    expect(readFileSync(join(outside, "dooc.yaml"), "utf8")).toBe("- one\n");
});
