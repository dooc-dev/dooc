import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileSite } from "./compile.js";
import { exportEntries } from "./export.js";
import { zip } from "./zip.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-export-graph-"));
    roots.push(root);
    const write = (file: string, data: string) => {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), data);
    };
    write(
        "dooc.yaml",
        "system:\n  default_lang: eng\n  languages: [eng, jpn]\n  themes: [light, dark]\ncenter_contents:\n  - file: docs/guide.md\njson_subformats:\n  - ext: issue\n    format: yaml\n    schema: schemas/issue.json\n",
    );
    write(
        "docs/guide.md",
        "![](assets/card.html)\n\n![](https://private.example/ticket/1)\n\n[Download](attachments/data.txt)\n",
    );
    write(
        "assets/card.html",
        '<link rel="stylesheet" href="card.css"><img src="image.png"><script src="card.js"></script>',
    );
    write("assets/card.css", '@import "theme.css"; p {background: url(image.png)}');
    write("assets/theme.css", "@font-face{src:url(font.woff2)}");
    write("assets/card.js", 'throw new Error("Do not execute source assets");');
    write("assets/image.png", "image");
    write("assets/font.woff2", "font");
    write("attachments/data.txt", "download");
    write("themes/dark/assets/card.html", "Dark card");
    write("locales/jpn/docs/guide.md", "本文\n");
    write("schemas/issue.json", '{"$ref":"base.json"}');
    write("schemas/base.json", '{"type":"object"}');
    write("issues/one.issue", "title: First\n");
    write("docs.config.mjs", 'throw new Error("Do not execute configuration");');
    write("unused/private.txt", "private");
    write(".dooc/plugins/private.zip", "plugin code");
    write(".dooc/credentials.json", "secret");
    return { root, write };
};

it("collects transitive local dependencies, translations and records without executable or personal state", () => {
    const { root } = fixture();
    const names = exportEntries(root).map((entry) => entry.name);
    expect(names.sort()).toEqual(
        [
            "dooc.yaml",
            "docs.config.mjs",
            "docs/guide.md",
            "locales/jpn/docs/guide.md",
            "assets/card.html",
            "assets/card.css",
            "assets/theme.css",
            "assets/card.js",
            "assets/image.png",
            "assets/font.woff2",
            "attachments/data.txt",
            "themes/dark/assets/card.html",
            "schemas/issue.json",
            "schemas/base.json",
            "issues/one.issue",
        ].sort(),
    );
});

it("includes standalone library resources and Markdown sources with their dependencies", () => {
    const { root, write } = fixture();
    write(
        "dooc.yaml",
        "center_contents:\n  - library: csv\n  - library: termth\n  - library: urls\n",
    );
    write("assets/revenue.csv", "Product,Revenue\nWidget,100\n");
    write("terms/widget.termth", "name: Widget\ndefinition: A product\n");
    write("notes/unregistered.md", "[Website](https://example.com)\n\n![](notes/snippet.ts)\n");
    write("notes/snippet.ts", "const value = 1;\n");
    write("private/hidden.csv", "secret\n");
    write(".gitignore", "private/\n");
    const names = exportEntries(root).map((entry) => entry.name);
    expect(names).toEqual(
        expect.arrayContaining([
            "assets/revenue.csv",
            "terms/widget.termth",
            "notes/unregistered.md",
            "notes/snippet.ts",
        ]),
    );
    expect(names).not.toContain("private/hidden.csv");
    expect(names).not.toContain("unused/private.txt");
});

it("keeps subformat icons valid after extracting a source export", () => {
    const { root, write } = fixture();
    write(
        "dooc.yaml",
        "center_contents:\n  - subformat: issue\njson_subformats:\n  - ext: issue\n    format: yaml\n    schema: schemas/issue.json\n    icon: assets/issue.svg\n",
    );
    write(
        "assets/issue.svg",
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg>',
    );
    expect(compileSite(root).errors).toEqual([]);
    const extracted = mkdtempSync(join(tmpdir(), "dooc-export-icons-"));
    roots.push(extracted);
    for (const entry of exportEntries(root)) {
        const path = join(extracted, entry.name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, entry.data);
    }
    const compiled = compileSite(extracted);
    expect(compiled.errors).toEqual([]);
    expect(compiled.docs[0]?.subformat?.iconSvg).toContain('<path d="M0 0h10v10z"/>');
});

it("fails on missing dependencies and paths that escape the project", () => {
    const { root, write } = fixture();
    write("assets/card.css", "p{background:url(missing.png)}");
    expect(() => exportEntries(root)).toThrow();
    write("assets/card.css", "p{background:url(../../outside.png)}");
    expect(() => exportEntries(root)).toThrow("Invalid export dependency");
    write("assets/card.css", "p{background:url(secret.png)}");
    symlinkSync("/etc/hosts", join(root, "assets/secret.png"));
    expect(() => exportEntries(root)).toThrow("outside the docs root");
});

it("terminates on cyclic source dependencies while preserving both files", () => {
    const { root, write } = fixture();
    write("assets/theme.css", '@import "card.css";');
    expect(exportEntries(root).filter((entry) => entry.name.endsWith("card.css"))).toHaveLength(1);
});

it("keeps JSON examples verbatim instead of interpreting them as schemas", () => {
    const { root, write } = fixture();
    write("docs/guide.md", "![](examples/invalid.json)\n\n![](examples/reference.json)\n");
    write("examples/invalid.json", "{unfinished");
    write("examples/reference.json", '{"$ref":"not-a-schema.json"}');
    const entries = exportEntries(root);
    expect(entries.find((entry) => entry.name === "examples/invalid.json")?.data.toString()).toBe(
        "{unfinished",
    );
    expect(entries.find((entry) => entry.name === "examples/reference.json")?.data.toString()).toBe(
        '{"$ref":"not-a-schema.json"}',
    );
});

it("exports file refs with schema URI scopes without reading embedded IDs or data as files", () => {
    const { root, write } = fixture();
    write(
        "schemas/issue.json",
        JSON.stringify({
            type: "object",
            $defs: { status: { $id: "status.json", type: "string" } },
            properties: { status: { $ref: "status.json" }, other: { $ref: "base.json" } },
            examples: [{ $ref: "private.json" }],
        }),
    );
    const files = exportEntries(root).map((entry) => entry.name);
    expect(files).toContain("schemas/base.json");
    expect(files).not.toContain("schemas/status.json");
    expect(files).not.toContain("schemas/private.json");
});

it("omits ignored records and stale display order, but rejects ignored dependencies", () => {
    const { root, write } = fixture();
    write(".gitignore", "private/\nassets/private.png\n");
    write("private/secret.issue", "title: PRIVATE\n");
    write("assets/private.png", "PRIVATE");
    write(
        "dooc.yaml",
        "system:\n  files:\n    order: [missing.svg, private/secret.issue]\ncenter_contents:\n  - file: docs/guide.md\njson_subformats:\n  - ext: issue\n    format: yaml\n    schema: schemas/issue.json\n",
    );
    expect(exportEntries(root).map((entry) => entry.name)).not.toContain("private/secret.issue");
    write("assets/card.css", "p{background:url(private.png)}");
    expect(() => exportEntries(root)).toThrow(/ignored.*assets\/private\.png/);
    write("assets/card.css", "");
    write("docs/guide.md", "![](private/secret.issue)\n");
    expect(() => exportEntries(root)).toThrow(/ignored.*private\/secret\.issue/);
});

describe("source export ZIP", () => {
    it("collects source dependencies into a zip that unzip can read back", () => {
        const root = mkdtempSync(join(tmpdir(), "docs-export-"));
        roots.push(root);
        mkdirSync(join(root, "content", "guide"), { recursive: true });
        mkdirSync(join(root, "figures"));
        mkdirSync(join(root, "dist"));
        mkdirSync(join(root, "presentations"));
        writeFileSync(join(root, "presentations", "old.html"), "legacy");
        writeFileSync(join(root, "content", "guide", "日本語.md"), "Body\n");
        writeFileSync(join(root, "content", "guide", ".swp"), "x");
        writeFileSync(join(root, "figures", "a.svg"), "<svg/>".repeat(100));
        writeFileSync(join(root, "dist", "index.html"), "x");
        writeFileSync(
            join(root, "dooc.yaml"),
            "center_contents:\n  - file: content/guide/日本語.md\n",
        );
        writeFileSync(join(root, "content/guide/日本語.md"), "Body\n\n![](figures/a.svg)\n");
        const entries = exportEntries(root);
        expect(entries.map((e) => e.name)).toEqual([
            "dooc.yaml",
            "content/guide/日本語.md",
            "figures/a.svg",
        ]);

        const out = join(root, "out.zip");
        writeFileSync(out, zip(entries));
        expect(
            execFileSync("unzip", ["-p", out, "content/guide/日本語.md"], { encoding: "utf8" }),
        ).toBe("Body\n\n![](figures/a.svg)\n");
        expect(execFileSync("unzip", ["-p", out, "figures/a.svg"], { encoding: "utf8" })).toBe(
            "<svg/>".repeat(100),
        );
    });

    it("includes the root manifest and docs.config.mjs when present", () => {
        const root = mkdtempSync(join(tmpdir(), "docs-export-config-"));
        roots.push(root);
        mkdirSync(join(root, "content"));
        writeFileSync(join(root, "content", "a.md"), "Body\n");
        writeFileSync(join(root, "docs.config.mjs"), "export default { languages: [] };\n");
        writeFileSync(join(root, "dooc.yaml"), "- a\n");
        const entries = exportEntries(root);
        expect(entries.map((e) => e.name)).toEqual([
            "dooc.yaml",
            "docs.config.mjs",
            "content/a.md",
        ]);
        expect(entries.find((e) => e.name === "dooc.yaml")?.data.toString()).toBe("- a\n");
    });
});
