import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { exportEntries } from "./export.js";
import { addProjectFont, listProjectFonts, loadProjectFonts, removeProjectFont } from "./fonts.js";

const roots: string[] = [];
const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-fonts-"));
    roots.push(root);
    return root;
};
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fontFile = new URL("../../../server/src/fonts/udev-gothic-regular.woff2", import.meta.url)
    .pathname;

it("registers project-local fonts, preserves existing names, and exports the registered bytes", () => {
    const root = fixture();
    writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
    const other = fixture();
    expect(listProjectFonts(root)).toEqual([]);
    const registered = addProjectFont(root, fontFile);
    expect(registered).toBe(".dooc/fonts/udev-gothic-regular.woff2");
    expect(listProjectFonts(other)).toEqual([]);
    expect(() => addProjectFont(root, fontFile)).toThrow();
    const data = readFileSync(fontFile);
    expect(readFileSync(join(root, registered))).toEqual(data);
    const fonts = loadProjectFonts(root);
    expect(fonts[0]?.source).toBe(`url(data:font/woff2;base64,${data.toString("base64")})`);
    expect(loadProjectFonts(root)[0]?.family).toBe(fonts[0]?.family);
    expect(exportEntries(root).find((entry) => entry.name === registered)?.data).toEqual(data);
    removeProjectFont(root, "udev-gothic-regular.woff2");
    expect(listProjectFonts(root)).toEqual([]);
});

it("rejects unsupported formats, invalid headers, traversal and escaping registration directories", () => {
    const root = fixture();
    const outside = fixture();
    writeFileSync(join(root, "bad.ttf"), "not a font");
    writeFileSync(join(root, "wrong.txt"), readFileSync(fontFile));
    expect(() => addProjectFont(root, join(root, "bad.ttf"))).toThrow("invalid font header");
    expect(() => addProjectFont(root, join(root, "wrong.txt"))).toThrow("Expected a TTF");
    expect(() => removeProjectFont(root, "../bad.ttf")).toThrow();
    mkdirSync(join(root, ".dooc"));
    symlinkSync(outside, join(root, ".dooc/fonts"));
    expect(() => addProjectFont(root, fontFile)).toThrow("outside the docs root");
});
