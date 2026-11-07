import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { figureUploadName, loadFigures } from "./figures.js";

describe("loadFigures", () => {
    it("rejects html fragments with a missing meta comment / a script", () => {
        const dir = mkdtempSync(join(tmpdir(), "docs-figs-html-"));
        writeFileSync(join(dir, "nometa.html"), "<div>x</div>");
        writeFileSync(
            join(dir, "scripted.html"),
            "<!--fig\ntitle: Fig.scripted\n-->\n<div><script>alert(1)</script></div>",
        );
        const { errors } = loadFigures(dir);
        expect(errors.some((e) => e.includes("meta comment is required"))).toBe(true);
        expect(errors.some((e) => e.includes("<script> is not allowed"))).toBe(true);
    });

    it("rejects missing xmlns / viewBox and var without a fallback", () => {
        const dir = mkdtempSync(join(tmpdir(), "docs-figs-"));
        writeFileSync(
            join(dir, "bad.svg"),
            '<svg viewBox="0 0 1 1"><rect fill="var(--doc-fg)"/></svg>',
        );
        writeFileSync(join(dir, "Bad Name.svg"), "<svg/>");
        const { errors } = loadFigures(dir);
        expect(errors.some((e) => e.includes("xmlns"))).toBe(true);
        expect(errors.some((e) => e.includes("var(--doc-*) without a fallback"))).toBe(true);
        expect(errors.some((e) => e.includes("file name must be"))).toBe(true);
        // The name part allows only [a-z0-9_-] (no spaces, uppercase or ".").
        expect(errors.some((e) => e.includes("Bad Name.svg"))).toBe(true);
    });

    it("injects theme fallbacks into figure markup and turns only white surface backgrounds into variables", () => {
        const dir = mkdtempSync(join(tmpdir(), "docs-figs-theme-"));
        writeFileSync(
            join(dir, "themed.svg"),
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><title>Fig.themed</title><desc>x</desc><text style="stroke:var(--doc-bg, #ffffff)">x</text></svg>',
        );
        writeFileSync(
            join(dir, "panel.html"),
            '<!--fig\ntitle: Fig.panel\ndesc: x\n-->\n<div><style>.box{background-color:#fff}</style><div class="box">x</div></div>',
        );
        const { figures, errors } = loadFigures(dir);
        expect(errors).toEqual([]);
        const svg = figures.find((f) => f.name === "themed");
        const html = figures.find((f) => f.name === "panel");
        expect(svg?.markup).toContain('data-doc-figure=""');
        expect(svg?.markup).toContain('[data-doc-theme="dark"] [data-doc-figure]');
        expect(html?.markup).toContain("background-color:var(--doc-panel, #ffffff)");
        expect(html?.markup).toContain("data-doc-figure-theme");
    });

    it.each([
        "",
        "<!-- layout -->\n",
    ])("keeps leading styles intact and themes the whole HTML fragment (%s)", (prefix) => {
        const dir = mkdtempSync(join(tmpdir(), "docs-figs-style-"));
        const fragment = `${prefix}<style>.intro{display:grid}</style><div class="intro">First</div><p>Second</p>`;
        writeFileSync(join(dir, "intro.html"), `<!--fig\ntitle: Intro\n-->\n${fragment}`);
        const { figures, errors } = loadFigures(dir);
        expect(errors).toEqual([]);
        expect(figures[0]?.markup).toMatch(
            /^<div data-doc-figure=""><style data-doc-figure-theme>/,
        );
        expect(figures[0]?.markup).toContain(`</style>${fragment}</div>`);
    });

    it("still rejects plain text after HTML metadata", () => {
        const dir = mkdtempSync(join(tmpdir(), "docs-figs-text-"));
        writeFileSync(join(dir, "text.html"), "<!--fig\ntitle: Text\n-->\nplain text");
        expect(loadFigures(dir).errors).toContain(
            "figures/text.html: the meta comment must be followed by an HTML fragment",
        );
    });

    it("embeds png / webp / jpeg as data URI <img>, with the stem in the same name space as other formats", () => {
        const dir = mkdtempSync(join(tmpdir(), "docs-figs-img-"));
        writeFileSync(join(dir, "photo.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
        writeFileSync(join(dir, "shot.webp"), "x");
        writeFileSync(join(dir, "shot.png"), "x");
        const { figures, errors } = loadFigures(dir);
        expect(figures.find((f) => f.name === "photo")).toEqual({
            name: "photo",
            file: "figures/photo.jpg",
            kind: "image",
            markup: '<img src="data:image/jpeg;base64,/9j/" alt="photo">',
        });
        expect(errors).toEqual([
            'figures/shot.webp: duplicate name "shot" (also used by figures/shot.png)',
        ]);
    });

    it.each([
        "mp4",
        "webm",
    ])("marks %s for shared playback controls while keeping the native fallback", (extension) => {
        const dir = mkdtempSync(join(tmpdir(), "docs-figs-video-"));
        writeFileSync(join(dir, `clip.${extension}`), "video");
        const { figures, errors } = loadFigures(dir);
        expect(errors).toEqual([]);
        expect(figures[0]?.kind).toBe("video");
        expect(figures[0]?.markup).toContain("<video data-dooc-video controls playsinline");
        expect(figures[0]?.markup).toContain(`src="data:video/${extension};base64,dmlkZW8="`);
    });

    it("yields zero figures without figures/ (no error)", () => {
        const { figures, errors } = loadFigures("/nonexistent-figures-dir");
        expect(figures).toEqual([]);
        expect(errors).toEqual([]);
    });
});

describe("loadFigures (draw.io exports placed in figures/)", () => {
    // Output of draw.io's File > Export as > SVG (prolog + diagram copy + external-link fallback).
    // drawio.test.ts covers normalization in detail; here we check it takes the same path as
    // hand-written figures.
    const drawio = (page: string): string => {
        const mxfile = `<mxfile><diagram name="${page}" id="a"><mxGraphModel/></diagram></mxfile>`;
        const content = mxfile
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
        return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" style="color-scheme: light dark;" content="${content}"><rect fill="#1b4994"/><switch><g requiredFeatures="x"/><a xlink:href="https://www.drawio.com/x"><text>Text is not SVG - cannot display</text></a></switch></svg>`;
    };

    it("normalizes draw.io svg and then runs the same validation as hand-written figures", () => {
        const dir = mkdtempSync(join(tmpdir(), "docs-figs-dio-"));
        writeFileSync(
            join(dir, "hand.svg"),
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><title>Fig.hand</title></svg>',
        );
        writeFileSync(join(dir, "flow.svg"), drawio("Authentication flow"));
        const { figures, errors } = loadFigures(dir);
        expect(errors).toEqual([]);
        expect(figures.map((f) => f.name)).toEqual(["flow", "hand"]);
        const flow = figures.find((f) => f.name === "flow");
        expect(flow?.file).toBe("figures/flow.svg");
        expect(flow?.title).toBe("Fig.flow");
        expect(flow?.desc).toBe("Authentication flow");
        // No mxfile copy or external domains left in the rendered output. Colors stay draw.io's.
        expect(flow?.markup).not.toContain("mxfile");
        expect(flow?.markup).not.toContain("drawio.com");
        expect(flow?.markup).toContain("data-doc-figure");
        expect(flow?.markup).toContain('fill="#1b4994"');
        // Hand-written figures are left untouched.
        const hand = figures.find((f) => f.name === "hand");
        expect(hand?.markup).not.toContain("--ge-dark-color");
    });

    // Output of File > Save as (Editable SVG). It differs from the export format in that a draw.io
    // comment sits in the prolog and it always carries the mxfile copy (= reopenable in draw.io).
    const editable = (page: string): string =>
        drawio(page).replace(
            '<?xml version="1.0" encoding="UTF-8"?>\n',
            '<?xml version="1.0" encoding="UTF-8"?>\n<!-- Do not edit this file with editors other than draw.io -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n',
        );

    it(".drawio.svg (Editable SVG) takes the same path, and its name is the stem without .drawio.svg", () => {
        const dir = mkdtempSync(join(tmpdir(), "docs-figs-dio-edit-"));
        writeFileSync(join(dir, "infra.drawio.svg"), editable("Core infra"));
        const { figures, errors } = loadFigures(dir);
        expect(errors).toEqual([]);
        const infra = figures.find((f) => f.name === "infra");
        expect(infra?.file).toBe("figures/infra.drawio.svg");
        expect(infra?.title).toBe("Fig.infra");
        expect(infra?.desc).toBe("Core infra");
        expect(infra?.markup.startsWith("<svg")).toBe(true);
        expect(infra?.markup).not.toContain("Do not edit this file");
        expect(infra?.markup).not.toContain("mxfile");
    });

    it(".drawio.svg shares the name space with .svg / .html (duplicates are errors)", () => {
        const dir = mkdtempSync(join(tmpdir(), "docs-figs-dio-dup-"));
        writeFileSync(join(dir, "flow.drawio.svg"), editable("a"));
        writeFileSync(join(dir, "flow.svg"), drawio("b"));
        const { errors } = loadFigures(dir);
        expect(
            errors.some((e) =>
                e.includes('duplicate name "flow" (also used by figures/flow.drawio.svg)'),
            ),
        ).toBe(true);
    });

    it("errors on a .drawio.svg without an mxfile copy (rejects a merely renamed export)", () => {
        const dir = mkdtempSync(join(tmpdir(), "docs-figs-dio-nomx-"));
        writeFileSync(
            join(dir, "plain.drawio.svg"),
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" style="color-scheme: light dark;"><rect/></svg>',
        );
        const { errors } = loadFigures(dir);
        expect(errors.some((e) => e.includes("a copy of the mxfile"))).toBe(true);
    });
});

describe("figureUploadName (figures added from the editing UI)", () => {
    it("conforms to the figures/ convention (lowercase, symbols become -, svg / html / raster only)", () => {
        expect(figureUploadName("System Overview (v2).SVG")).toBe("system-overview-v2.svg");
        expect(figureUploadName("C:\\tmp\\図.png")).toBe("figure.png");
        expect(figureUploadName("flow.drawio.svg")).toBe("flow.drawio.svg");
        expect(figureUploadName("photo.JPEG")).toBe("photo.jpeg");
        expect(figureUploadName("Page.HTML")).toBe("page.html");
        expect(figureUploadName("notes.txt")).toBeUndefined();
    });
});
