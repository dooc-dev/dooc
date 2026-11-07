import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { blocksHtml } from "../core/html.js";
import { themeVariantFile } from "../core/theme-variants.js";
import { bundleEntries } from "./bundle.js";
import { parseContentSource } from "./code-blocks.js";
import { createCompiler } from "./compile.js";
import { filesSnapshot, updateFiles } from "./files.js";
import { themeVariants } from "./theme-variants.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-themes-"));
    roots.push(root);
    const put = (file: string, text: string) => {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), text);
    };
    put("dooc.yaml", "defaultLang: eng\ndocs: [a]\n");
    put(
        "content/a.md",
        "---\ntitle: Theme variants\n---\n\n![](files/a.txt)\n\n![](files/image.svg)\n",
    );
    put("files/a.txt", "Default text");
    put("themes/dark/files/a.txt", "Dark text");
    put("themes/sepia/files/a.txt", "Sepia text");
    const svg = (fill: string) =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" fill="${fill}"/></svg>`;
    put("files/image.svg", svg("white"));
    put("themes/dark/files/image.svg", svg("black"));
    return { root, put };
};

describe("theme variants", () => {
    it("compiles original and named file variants and refreshes changed sources", () => {
        const { root, put } = fixture();
        const compiler = createCompiler(root);
        const first = compiler.compile();
        expect(first.errors).toEqual([]);
        expect(first.docs[0]?.blocks[0]).toMatchObject({
            type: "themeVariants",
            default: { lines: ["Default text"] },
            variants: { dark: { lines: ["Dark text"] }, sepia: { lines: ["Sepia text"] } },
        });
        const html = blocksHtml(first.docs[0]?.blocks ?? [], {
            figures: new Map(first.figures.map((f) => [f.name, f])),
            terms: [],
        });
        expect(html).toContain('data-theme-variant="dark" hidden');
        expect(html).toContain('data-theme-variant="sepia" hidden');
        expect(html).toContain("black");
        put("themes/dark/files/a.txt", "Updated dark text");
        expect(compiler.compile().docs[0]?.blocks[0]).toMatchObject({
            variants: { dark: { lines: ["Updated dark text"] } },
        });
        expect(bundleEntries(root).map((entry) => entry.name)).toContain(
            "themes/dark/files/image.svg",
        );
    });

    it("keeps variants beside renamed originals", () => {
        const { root } = fixture();
        updateFiles(root, {
            action: "rename",
            file: "files/a.txt",
            name: "b.txt",
            revision: filesSnapshot(root).revision,
        });
        expect(readFileSync(join(root, "themes/dark/files/b.txt"), "utf8")).toBe("Dark text");
        expect(readFileSync(join(root, "content/a.md"), "utf8")).toContain("files/b.txt");
        expect(createCompiler(root).compile().errors).toEqual([]);
    });

    it("rejects traversal and variant symlinks that leave the docs root", () => {
        const { root, put } = fixture();
        for (const [file, theme] of [
            ["../secret", "dark"],
            ["files/a.txt", "../dark"],
            ["files/a.txt", "dark/light"],
        ] as const)
            expect(() => themeVariantFile(file, theme)).toThrow();
        put("themes/light/files/placeholder.txt", "placeholder");
        symlinkSync("/etc/passwd", join(root, "themes/light/files/a.txt"));
        expect(() => themeVariants(root, "files/a.txt")).toThrow("outside the docs root");
    });
});

describe("delimited data previews", () => {
    it("renders quoted commas, newlines and escaped quotes as table cells", () => {
        expect(
            parseContentSource("csv", 'Name,Note\r\n"A, B","line 1\nline ""2"""\r\n', "table.csv")
                ?.blocks[0],
        ).toEqual({
            type: "table",
            dataSource: "table.csv",
            headers: ["Name", "Note"],
            rows: [["A, B", 'line 1\nline "2"']],
        });
        expect(
            parseContentSource("tsv", "Key\tValue\nmode\tdark\n", "table.tsv")?.blocks[0],
        ).toMatchObject({ rows: [["mode", "dark"]] });
    });
    it.each([
        "a,b\n1\n",
        'a,b\n"unclosed,2',
        'a,b\n"quoted"oops,2',
    ])("rejects malformed rows: %s", (source) => {
        expect(parseContentSource("csv", source, "table.csv")?.errors.length).toBeGreaterThan(0);
    });
    it("preserves explicitly empty cells while skipping empty lines", () => {
        expect(parseContentSource("csv", "A,B\n,\n\n", "table.csv")?.blocks[0]).toMatchObject({
            rows: [["", ""]],
        });
        expect(parseContentSource("csv", 'A\n""\n', "table.csv")?.blocks[0]).toMatchObject({
            rows: [[""]],
        });
    });
});
