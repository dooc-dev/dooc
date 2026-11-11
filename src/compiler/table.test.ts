import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseManifest } from "../core/content-metadata.js";
import { blocksHtml } from "../core/html.js";
import { publishHtml, siteFrom } from "../viewer/serve.js";
import { checkSite } from "./check.js";
import { compileDraft, compileSite } from "./compile.js";
import { parseDoc } from "./dialect.js";
import { exportEntries } from "./export.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const document = (body: string) => `---\ntitle: Data\n---\n\n${body}\n`;

it.each(["csv", "tsv"])("uses all %s rows unless a file reference explicitly has #H", (format) => {
    const root = mkdtempSync(join(tmpdir(), "dooc-table-"));
    roots.push(root);
    mkdirSync(join(root, "content"));
    const file = `values.${format}`;
    const data = "Name,Value\nB,10\nA,2".replaceAll(",", format === "csv" ? "," : "\t");
    const body = `![Data caption](${file})\n\n![Header caption](${file}#H)\n\n\`\`\`${format} Inline caption\n${data}\n\`\`\``;
    const raw = document(body);
    writeFileSync(join(root, "dooc.yaml"), "docs: [data]\n");
    writeFileSync(join(root, "content/data.md"), raw);
    writeFileSync(join(root, file), data);
    const compiled = compileSite(root);
    expect(compiled.errors).toEqual([]);
    const blocks = compiled.docs[0]?.blocks ?? [];
    expect(blocks.map((block) => block.type)).toEqual(["table", "table", "table"]);
    const output = blocks.map((block) => blocksHtml([block]));
    for (const index of [0, 2]) {
        expect(output[index]).toContain('data-table-mode="data"');
        expect(output[index]).toContain('<th scope="row">1</th><td>Name</td><td>Value</td>');
    }
    expect(output[1]).toContain('data-table-mode="header"');
    expect(output[1]).toContain('<th scope="col">Name</th>');
    expect(output[1]).not.toContain('<th scope="row">1</th>');
    for (const html of output) {
        expect(html).not.toContain('class="cap"');
        expect(html).not.toContain("data-table-header");
        expect(html).not.toContain("data-table-toolbar");
        expect(html).not.toContain("data-table-count");
    }
    expect(output[1]).toContain('aria-label="Header caption"');
    expect(
        compileDraft({ root, docs: compiled.docs, figures: new Map() }, "content/data.md", raw).doc
            .blocks,
    ).toEqual(blocks);
    const published = publishHtml(siteFrom(compiled), "");
    expect(
        [...published.matchAll(/<section class="data-table"[^>]+data-table-mode="(\w+)"/g)].map(
            (match) => match[1],
        ),
    ).toEqual(["data", "header", "data"]);
    expect(exportEntries(root).filter((entry) => entry.name === file)).toHaveLength(1);
    expect(checkSite(root, { only: ["render"] }).exitCode).toBe(0);
});

it("requires a CSV/TSV file for #H and does not add a YAML header mode", () => {
    expect(parseDoc(document("![](values.txt#H)")).errors.join()).toContain(
        "#H requires a CSV or TSV file",
    );
    expect(parseDoc(document("![](values.csv#D)")).errors.length).toBeGreaterThan(0);
    expect(parseManifest({ docs: [], table: { defaultMode: "header" } }).errors).toEqual([
        'dooc.yaml: unknown field "table"',
    ]);
    expect(parseDoc(document("```csv\na,b\n1,2,3\n```")).errors.length).toBeGreaterThan(0);
});

it("preserves #H across theme variants while line fragments still show source code", () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-table-"));
    roots.push(root);
    mkdirSync(join(root, "content"));
    mkdirSync(join(root, "themes/dark"), { recursive: true });
    writeFileSync(join(root, "dooc.yaml"), "docs: [data]\n");
    writeFileSync(
        join(root, "content/data.md"),
        document("![](values.csv#H)\n\n![](values.csv#L2)"),
    );
    writeFileSync(join(root, "values.csv"), "Name,Value\nA,1\n");
    writeFileSync(join(root, "themes/dark/values.csv"), "Name,Value\nB,2\n");
    const compiled = compileSite(root);
    expect(compiled.errors).toEqual([]);
    expect(compiled.docs[0]?.blocks[0]).toMatchObject({
        type: "themeVariants",
        default: { type: "table", tableMode: "header" },
        variants: { dark: { type: "table", tableMode: "header", rows: [["B", "2"]] } },
    });
    expect(compiled.docs[0]?.blocks[1]).toMatchObject({
        type: "themeVariants",
        default: { type: "code", lines: ["A,1"] },
    });
});
