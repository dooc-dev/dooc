import { describe, expect, it } from "vitest";
import { parseManifestText } from "../compiler/manifest.js";
import {
    allowedPreviewUrl,
    defaultPreviewSettings,
    parsePreviewSettings,
    resolvePreviewer,
} from "./previewers.js";

describe("preview registration", () => {
    it.each([
        ["data/a.csv", "table"],
        ["a.tsv", "table"],
        ["a.PNG", "image"],
        ["a.drawio.svg", "image"],
        ["a.html", "html"],
        ["a.md", "markdown"],
        ["a.ts", "code"],
        ["a%20b.ts#L10-L20", "code"],
        ["a.webm", "video"],
        ["a.bin", undefined],
    ])("selects %s without reading the file", (file, kind) => {
        expect(resolvePreviewer(file)).toBe(kind);
    });

    it("keeps default domains independent and normalizes application settings", () => {
        const settings = parsePreviewSettings({
            domains: [" EXAMPLE.COM "],
        });
        expect(settings.domains).toEqual(["example.com"]);
        settings.domains.push("other.example.com");
        expect(defaultPreviewSettings().domains).toEqual([]);
        expect(resolvePreviewer("a.png", defaultPreviewSettings())).toBe("image");
    });

    it("rejects network policy in document metadata", () => {
        const manifest = parseManifestText("docs: []\npreviews: { domains: [example.com] }\n");
        expect(manifest.errors).toContain('dooc.yaml: unknown field "previews"');
        expect(manifest).not.toHaveProperty("previews");
    });

    it("denies external access by default and matches exact HTTPS hosts", () => {
        const settings = parsePreviewSettings({ domains: ["example.com"] });
        expect(resolvePreviewer("https://example.com/a.csv")).toBeUndefined();
        expect(resolvePreviewer("https://EXAMPLE.com/a%2Ecsv?download=1#part", settings)).toBe(
            "table",
        );
        for (const url of [
            "https://sub.example.com/a.csv",
            "https://example.com.evil.com/a.csv",
            "https://example.com./a.csv",
            "https://example.com:8443/a.csv",
            "http://example.com/a.csv",
            "https://user@example.com/a.csv",
            "https://example.com@evil.com/a.csv",
            "https://example.com\\@evil.com/a.csv",
            "//example.com/a.csv",
            "file:///a.csv",
        ]) {
            expect(() => allowedPreviewUrl(url, settings.domains), url).toThrow();
            expect(resolvePreviewer(url, settings), url).toBeUndefined();
        }
    });

    it.each([
        { domains: ["*.example.com"] },
        { domains: ["https://example.com/"] },
        { domains: ["localhost"] },
        { domains: ["127.0.0.1"] },
        { domains: ["example.com:443"] },
        { domains: ["example.local"] },
        { domains: ["example.com", "EXAMPLE.COM"] },
        { domains: [1] },
        { domains: "example.com" },
        { formats: { other: ["csv"] } },
        { formats: { table: [".csv"] } },
        { formats: { table: ["json"] } },
        { formats: { table: ["csv", "csv"] } },
        { formats: [] },
        { typo: [] },
    ])("rejects ambiguous or invalid registrations: %j", (settings) => {
        expect(() => parsePreviewSettings(settings)).toThrow();
    });
});
