import { describe, expect, it } from "vitest";
import { fontCss, readFont } from "./fonts.js";

describe("bundled monospace font", () => {
    it("serves the bundled Japanese programming font only", () => {
        const css = fontCss(false);
        expect(css).toContain("UDEV Gothic");
        const paths = [...css.matchAll(/url\(\/assets\/fonts\/([^()]+)\)/g)];
        expect(paths.length).toBe(1);
        for (const path of paths)
            expect(
                readFont(path[1] ?? "")
                    ?.subarray(0, 4)
                    .toString(),
            ).toBe("wOF2");
        expect(readFont("../../package.json")).toBeUndefined();
    });
    it("embeds font data and license in offline HTML CSS", () => {
        const css = fontCss(true);
        expect(css).toContain("data:font/woff2;base64,");
        expect(css).toContain("SIL OPEN FONT LICENSE");
        expect(css).not.toContain("/assets/fonts/");
    });
});
