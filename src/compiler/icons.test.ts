import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileSite } from "./compile.js";
import { squareSvg } from "./icons.js";

describe("squareSvg (makes an icon 1:1)", () => {
    it("pads the shorter side to center it and removes fixed width / height", () => {
        expect(
            squareSvg('<svg xmlns="x" viewBox="0 0 200 100" width="200" height="100"><g/></svg>'),
        ).toBe(
            '<svg viewBox="0 -50 200 200" preserveAspectRatio="xMidYMid meet" xmlns="x"><g/></svg>',
        );
        // Adds xmlns if missing (since it's drawn via an img data URI)
        expect(squareSvg('<svg width="10" height="40"></svg>')).toBe(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-15 0 40 40" preserveAspectRatio="xMidYMid meet"></svg>',
        );
    });

    it("returns undefined when the size is unreadable / it is not an svg", () => {
        expect(squareSvg("<svg></svg>")).toBeUndefined();
        expect(squareSvg("<html></html>")).toBeUndefined();
    });
});

describe("compileSite icons/", () => {
    it("puts icons/<id>.svg on doc.icon and errors on an icon without a doc", () => {
        const root = mkdtempSync(join(tmpdir(), "docs-icons-"));
        mkdirSync(join(root, "content"));
        mkdirSync(join(root, "icons"));
        writeFileSync(join(root, "dooc.yaml"), "- a\n");
        writeFileSync(join(root, "content", "a.md"), '---\ntitle: "A"\n---\n');
        writeFileSync(join(root, "icons", "a.svg"), '<svg viewBox="0 0 1 1"/>');
        expect(compileSite(root).docs[0]?.icon).toBe('<svg viewBox="0 0 1 1"/>');
        writeFileSync(join(root, "icons", "ghost.svg"), '<svg viewBox="0 0 1 1"/>');
        expect(compileSite(root).errors).toContain(
            "icons/ghost.svg: no matching doc (content/ghost.md)",
        );
    });
});
