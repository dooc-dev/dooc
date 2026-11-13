import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileReferences } from "../../../frontend/src/file-references.js";
import { publishHtml, resourcesMain, siteFrom } from "../../../server/src/serve.js";
import { figureFrameHtml } from "../core/figure-frame.js";
import { parseFigureLink, parseFileEmbed } from "../core/file-embed.js";
import { compileSite } from "./compile.js";
import { dxfSvg } from "./dxf.js";
import { exportEntries } from "./export.js";
import { figureName, figureUploadName, loadFigures } from "./figures.js";

const drawing = readFileSync(
    new URL("../../../../dooc-docs/contents/dxf/mounting-plate.dxf", import.meta.url),
    "utf8",
);
const pdf = readFileSync(
    new URL("../../../../dooc-docs/contents/pdf/meeting-notes.pdf", import.meta.url),
);
const dxf = (entity: string) => `0\nSECTION\n2\nENTITIES\n${entity}\n0\nENDSEC\n0\nEOF\n`;

describe("DXF and PDF previews", () => {
    it("renders curves, a closed profile and repeated blocks with a padded viewport", () => {
        const svg = dxfSvg(drawing);
        expect(svg).toMatch(/^<svg/);
        expect(svg.match(/<circle\b/g)).toHaveLength(4);
        expect(svg).toContain("<path");
        for (const label of [
            "160.0",
            "130.0",
            "100.0",
            "70.0",
            "6.0",
            "4x ⌀10 THRU",
            "±0.2 mm",
            "REVISION: B",
        ])
            expect(svg).toContain(label);
        expect(svg).toContain('stroke="rgb(0, 127, 255)"');
        expect(svg).toContain('width="800"');
        expect(svg).toContain('vector-effect="non-scaling-stroke" stroke-width="1.25"');
        expect(svg).toContain('stroke="var(--doc-fg, #000000)"');
        expect(svg).not.toMatch(/NaN|Infinity/);
        expect(dxfSvg(drawing.replace(/\n/g, "\r"))).toBe(svg);
    });

    it("keeps horizontal and vertical lines visible despite zero-sized source bounds", () => {
        for (const [x, y] of [
            [100, 0],
            [0, 100],
        ]) {
            const svg = dxfSvg(dxf(`0\nLINE\n10\n0\n20\n0\n11\n${x}\n21\n${y}`));
            const bounds = /viewBox="([^"]+)"/.exec(svg)?.[1]?.split(" ").map(Number);
            expect(bounds?.[2]).toBeGreaterThan(0);
            expect(bounds?.[3]).toBeGreaterThan(0);
        }
    });

    it.each([
        "not a drawing",
        "AutoCAD Binary DXF\r\n\u001a\0",
        drawing.replace(/0\nEOF\n$/, ""),
        dxf(""),
        dxf("0\nLINE\n10\nbad\n20\n0\n11\n100\n21\n50"),
    ])("rejects invalid or unrenderable drawings without returning a blank preview", (source) => {
        expect(() => dxfSvg(source)).toThrow();
    });

    it("renders numeric TEXT labels with alignment, rotation and escaped markup", () => {
        const svg = dxfSvg(
            dxf(
                "0\nTEXT\n10\n1\n20\n2\n11\n20\n21\n30\n40\n4\n41\n1.5\n50\n90\n72\n1\n73\n2\n1\n%%c10 %%p0.2 %%d <script>&",
            ),
        );
        expect(svg).toContain('transform="translate(20 -30) rotate(-90) scale(1.5 1)"');
        expect(svg).toContain('text-anchor="middle" dominant-baseline="central"');
        expect(svg).toContain("⌀10 ±0.2 ° &lt;script&gt;&amp;</text>");
        expect(svg).not.toContain("<script>");
        const [x = 0, y = 0, width = 0, height = 0] =
            /viewBox="([^"]+)"/.exec(svg)?.[1]?.split(" ").map(Number) ?? [];
        expect(x).toBeLessThan(20);
        expect(x + width).toBeGreaterThan(20);
        expect(y).toBeLessThan(-30);
        expect(y + height).toBeGreaterThan(-30);
    });

    it("includes annotation extents outside the geometry and rejects invalid text sizes", () => {
        const line = "0\nLINE\n10\n0\n20\n0\n11\n10\n21\n10";
        const text = "0\nTEXT\n10\n100\n20\n200\n40\n4\n1\nOutside";
        const svg = dxfSvg(dxf(`${line}\n${text}`));
        const [x = 0, y = 0, width = 0, height = 0] =
            /viewBox="([^"]+)"/.exec(svg)?.[1]?.split(" ").map(Number) ?? [];
        expect(x + width).toBeGreaterThan(100);
        expect(y).toBeLessThan(-200);
        expect(y + height).toBeGreaterThan(0);
        for (const size of ["0", "-1", "NaN", "Infinity", "1e308"])
            expect(() => dxfSvg(dxf(text.replace("40\n4", `40\n${size}`)))).toThrow(/DXF text/);
    });

    it("keeps the sample drawing and ordinary PDF as separate figures", () => {
        const compiled = compileSite(new URL("../../../../dooc-docs", import.meta.url).pathname);
        expect(compiled.errors).toEqual([]);
        const figures = compiled.docs.find(({ file }) => file === "contents/md/media.md")?.refs
            .figures;
        expect(figures).toContain(figureName("contents/dxf/mounting-plate.dxf"));
        expect(figures).toContain(figureName("contents/pdf/meeting-notes.pdf"));
        expect(pdf.toString()).toContain("Team meeting notes");
        expect(pdf.toString().toLowerCase()).not.toContain("mounting plate");
    });

    it("bounds conversion time for malformed arcs", () => {
        expect(() => dxfSvg(dxf("0\nARC\n10\n0\n20\n0\n40\n10\n50\nInfinity\n51\n90"))).toThrow(
            /timed out/,
        );
    });

    it("registers embeds, links, upload names and line references consistently", () => {
        for (const ext of ["pdf", "dxf"]) {
            const file = `files/Review & drawing.${ext.toUpperCase()}`;
            const url = encodeURI(file);
            expect(parseFileEmbed(url)).toEqual({ file, kind: "figure" });
            expect(parseFigureLink(url)).toEqual({ file, fragment: "" });
            expect(fileReferences(`![Review](${url})`)).toEqual([
                { file, kind: "figure", line: 1 },
            ]);
            expect(figureUploadName(`Review & drawing.${ext.toUpperCase()}`)).toBe(
                `review-drawing.${ext}`,
            );
            expect(() => parseFileEmbed(`../private.${ext}`)).toThrow();
        }
        expect(parseFileEmbed("drawing.dxf#L1-L4")).toEqual({
            file: "drawing.dxf",
            range: "#L1-L4",
            kind: "textfile",
        });
    });

    it("isolates broken PDF and DXF files while loading valid neighboring figures", () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-doc-previews-"));
        const figuresDir = join(root, "figures");
        mkdirSync(figuresDir);
        try {
            writeFileSync(join(figuresDir, "bad.pdf"), "<html>Not a PDF</html>");
            writeFileSync(join(figuresDir, "bad.dxf"), "not a drawing");
            writeFileSync(join(figuresDir, "plate.dxf"), drawing);
            writeFileSync(join(figuresDir, "review.pdf"), pdf);
            const loaded = loadFigures(figuresDir);
            expect(loaded.errors).toHaveLength(2);
            expect(loaded.errors.join("\n")).toContain("figures/bad.pdf: Expected a PDF");
            expect(loaded.errors.join("\n")).toContain("figures/bad.dxf: Expected an ASCII DXF");
            expect(loaded.figures.map(({ kind }) => kind)).toEqual(["svg", "pdf"]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("keeps existing visual formats working when extensions use uppercase", () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-doc-previews-"));
        try {
            writeFileSync(join(root, "photo.PNG"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
            writeFileSync(join(root, "clip.MP4"), "video");
            writeFileSync(
                join(root, "chart.SVG"),
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>',
            );
            const loaded = loadFigures(join(root, "figures"), [
                "photo.PNG",
                "clip.MP4",
                "chart.SVG",
            ]);
            expect(loaded.errors).toEqual([]);
            expect(loaded.figures.map(({ kind }) => kind)).toEqual(["image", "video", "svg"]);
            expect(loaded.figures[0]?.markup).toContain("data:image/png;base64,");
            expect(loaded.figures[1]?.markup).toContain("data:video/mp4;base64,");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("preserves source bytes and embeds both previews in resources and standalone HTML", () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-doc-previews-"));
        try {
            mkdirSync(join(root, "content"));
            mkdirSync(join(root, "files"));
            writeFileSync(join(root, "dooc.yaml"), "docs: [guide]\n");
            const files = ["files/My drawing.DXF", "files/Review.PDF"] as const;
            writeFileSync(join(root, files[0]), drawing);
            writeFileSync(join(root, files[1]), pdf);
            writeFileSync(
                join(root, "content/guide.md"),
                `${files.map((file) => `![Review](<${file}>)\n\n[File](<${file}>)`).join("\n\n")}\n`,
            );
            const compiled = compileSite(root);
            expect(compiled.errors).toEqual([]);
            expect(compiled.docs[0]?.refs.figures).toEqual(files.map(figureName));
            const site = siteFrom(compiled);
            for (const file of files) {
                const html = resourcesMain(site, `file/${encodeURIComponent(file)}`)?.main;
                expect(html).toContain(file.endsWith("PDF") ? "<object" : "<iframe");
            }
            const pdfFigure = compiled.figures.find((figure) => figure.kind === "pdf");
            if (!pdfFigure) throw new Error("Missing PDF figure");
            const frame = figureFrameHtml(pdfFigure, "fig-frame", 'Review & "notes"');
            expect(frame).toContain('aria-label="Review &amp; &quot;notes&quot;"');
            expect(frame).toContain(`data="data:application/pdf;base64,${pdf.toString("base64")}"`);
            expect(frame).toContain('download="Review.PDF"');
            expect(frame).not.toContain("srcdoc");
            const html = publishHtml(site, "");
            expect(html).toContain("object-src data:;");
            expect(html).toContain("connect-src 'none';");
            expect(html).toContain("data:application/pdf;base64,");
            expect(html).toContain("4x ⌀10 THRU");
            const exported = exportEntries(root);
            expect(exported.find(({ name }) => name === files[0])?.data.toString()).toBe(drawing);
            expect(exported.find(({ name }) => name === files[1])?.data).toEqual(pdf);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
