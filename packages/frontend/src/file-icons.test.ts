import { expect, it } from "vitest";
import { fileIcon, filesIcon, folderIcon } from "./file-icons.js";

it("uses distinct bundled icons for common file types and their aliases", () => {
    const paths = ["guide.md", "index.ts", "dooc.yaml", "data.json", "logo.svg", "data.csv"];
    expect(new Set(paths.map(fileIcon)).size).toBe(paths.length);
    expect(fileIcon("docs/GUIDE.MD")).toBe(fileIcon("guide.markdown"));
    expect(fileIcon("dooc.yml")).toBe(fileIcon("dooc.yaml"));
    expect(fileIcon("index.mts")).toBe(fileIcon("index.ts"));
    expect(fileIcon("index.js")).toBe(fileIcon("index.ts"));
    expect(fileIcon(".gitignore")).toBe(fileIcon(".gitattributes"));
    for (const path of paths) {
        expect(fileIcon(path)).toMatch(/^<svg /);
        expect(fileIcon(path)).not.toMatch(/<script|<style|\bid=|href=/);
    }
});

it("uses one unfilled outline style for file, folder and action icons", () => {
    for (const svg of [
        fileIcon("guide.md"),
        fileIcon("index.ts"),
        folderIcon(true),
        folderIcon(false),
        filesIcon("search"),
        filesIcon("history"),
        filesIcon("refresh"),
        filesIcon("copy"),
    ]) {
        expect(svg).toContain('stroke="currentColor" stroke-width="1.5"');
        expect(svg).toContain('fill="none"');
        expect(svg).toContain('width="16" height="16" viewBox="0 0 24 24"');
        expect(svg).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
});

it("falls back safely for unknown extensions and extensionless names", () => {
    for (const path of [
        "README",
        "folder.json/plain",
        "entry.unknown",
        "entry.constructor",
        "entry.__proto__",
    ])
        expect(fileIcon(path)).toBe(fileIcon("entry.txt"));
});

it("distinguishes open and closed folders without duplicate SVG ids", () => {
    expect(folderIcon(true)).not.toBe(folderIcon(false));
    for (const expanded of [true, false]) {
        expect(folderIcon(expanded)).toMatch(/^<svg /);
        expect(folderIcon(expanded)).not.toContain("id=");
    }
});
