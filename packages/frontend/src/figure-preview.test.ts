import { expect, it } from "vitest";
import { blocksHtml } from "../../engine/src/core/html.js";
import { deferredFigureHtml } from "./figure-preview.js";

it("defers large local figures without embedding bytes, preserving offline exports and labels", () => {
    const figure = {
        name: "large",
        file: 'assets/large "file".pdf',
        kind: "pdf" as const,
        markup: `<object>${"X".repeat(100_001)}</object>`,
    };
    const ctx = { figures: new Map([[figure.name, figure]]), terms: [] };
    const blocks = [{ type: "figureRef" as const, name: figure.name, alt: '<Demo> "PDF"' }];
    const local = blocksHtml(blocks, { ...ctx, figurePreview: deferredFigureHtml });
    expect(local).toContain(
        'data-figure-preview="/api/figure-preview?file=assets%2Flarge%20%22file%22.pdf&amp;label=%3CDemo%3E%20%22PDF%22"',
    );
    expect(local).toContain("&lt;Demo&gt; &quot;PDF&quot;");
    expect(local).toContain('role="status"');
    expect(local).not.toContain(figure.markup);
    expect(local.length).toBeLessThan(600);
    expect(blocksHtml(blocks, ctx)).toContain(figure.markup);
    expect(deferredFigureHtml({ ...figure, markup: "small" })).toBe("small");
    expect(deferredFigureHtml(figure, "fig-frame figpop-frame")).not.toContain("button");
});
