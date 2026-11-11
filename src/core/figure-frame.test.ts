import { describe, expect, it, vi } from "vitest";
import { figureFrameHtml, figureSrcdoc, mountFigureFrames } from "./figure-frame.js";

const svg = {
    name: "a",
    file: "figures/a.svg",
    kind: "svg" as const,
    markup: '<svg xmlns="x" width="300" viewBox="0 0 600 200"/>',
};
const html = {
    name: "b",
    file: "figures/b.html",
    kind: "html" as const,
    markup: "<div>x</div>",
    title: "Fig.b",
};

describe("figureFrameHtml (figure isolation)", () => {
    it("waits for loading before applying the theme and ignores invalid frame heights", () => {
        let message: (event: Partial<MessageEvent>) => void = () => {};
        let onLoad = () => {};
        let srcdoc = figureSrcdoc(html);
        let ready = false;
        const frame = {
            contentWindow: {},
            style: { height: "120px" },
            getAttribute: () => srcdoc,
            setAttribute: (name: string, value: string) => {
                if (name === "srcdoc") srcdoc = value;
                if (name === "data-theme-ready") ready = true;
            },
            removeAttribute: () => {
                ready = false;
            },
            closest: () => null,
            addEventListener: (_name: string, listener: typeof onLoad) => {
                onLoad = listener;
            },
        };
        vi.stubGlobal("window", {
            matchMedia: () => ({ matches: false, addEventListener() {} }),
            addEventListener: (_type: string, listener: typeof message) => {
                message = listener;
            },
        });
        vi.stubGlobal(
            "MutationObserver",
            class {
                observe() {}
            },
        );
        try {
            mountFigureFrames({
                documentElement: { dataset: {} },
                querySelectorAll: () => [frame],
            } as unknown as Document);
            expect(srcdoc).toContain('data-doc-theme="auto"');
            expect(ready).toBe(false);
            onLoad();
            expect(srcdoc).toContain('data-doc-theme="light"');
            expect(ready).toBe(false);
            onLoad();
            expect(ready).toBe(true);
            for (const height of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "20"])
                message({
                    data: { docFigureHeight: height },
                    source: frame.contentWindow as Window,
                });
            message({ data: { docFigureHeight: 300 }, source: {} as Window });
            expect(frame.style.height).toBe("120px");
            message({ data: { docFigureHeight: 48 }, source: frame.contentWindow as Window });
            expect(frame.style.height).toBe("48px");
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("svg goes in a no-script iframe; display width = width attribute / ratio = viewBox", () => {
        const out = figureFrameHtml(svg);
        expect(out).toContain('sandbox=""');
        expect(out).toContain('style="width:300px;aspect-ratio:600 / 200"');
        expect(figureSrcdoc(svg)).not.toContain("<script");
    });

    it("html allows only the height-notification script (no allow-same-origin)", () => {
        const out = figureFrameHtml(html);
        expect(out).toContain('sandbox="allow-scripts"');
        expect(out).not.toContain("allow-same-origin");
        expect(figureSrcdoc(html, "dark")).toContain('<html data-doc-theme="dark">');
        expect(figureSrcdoc(html)).toContain("docFigureHeight");
    });

    it("raster stays an <img>", () => {
        const img = {
            name: "c",
            file: "figures/c.png",
            kind: "image" as const,
            markup: '<img src="data:x" alt="c">',
        };
        expect(figureFrameHtml(img)).toBe('<img src="data:x" alt="c">');
        expect(figureFrameHtml(img, "fig-frame", "")).toBe('<img src="data:x" alt="">');
        expect(figureFrameHtml(img, "fig-frame", 'A & "B"')).toBe(
            '<img src="data:x" alt="A &amp; &quot;B&quot;">',
        );
    });

    it("uses video descriptions as accessible labels", () => {
        const video = {
            name: "demo",
            file: "demo.mp4",
            kind: "video" as const,
            markup: '<video controls aria-label="Video preview" src="data:video/mp4;base64,"></video>',
        };
        expect(figureFrameHtml(video, "fig-frame", 'Demo & "intro"')).toContain(
            'aria-label="Demo &amp; &quot;intro&quot;"',
        );
        expect(figureFrameHtml(video, "fig-frame", "")).toBe(video.markup);
    });
});
