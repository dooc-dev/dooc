import { describe, expect, it } from "vitest";
import { parseDoc } from "../compiler/dialect.js";
import { toBlocks } from "../compiler/from-mdast.js";
import { blocksHtml } from "../core/html.js";
import { parsePluginUrl, validatePluginView } from "../plugins/view.js";
import { pluginViewHtml } from "./plugin-view.js";

describe("plugin references and presentation", () => {
    it("keeps service embeds and their fragments as links outside the viewer", () => {
        const source = `---\ntitle: Plugin\n---\n
![Ticket](https://service.example/tickets/42?view=full#comment-7)

> ![](https://service.example/pulls/17)

![](https://service.example/files/source.ts#L2-L8)

[Ordinary link](https://service.example/tickets/99)

\`\`\`md
![](https://service.example/example)
\`\`\`
`;
        const parsed = parseDoc(source);
        expect(parsed.errors).toEqual([]);
        const { blocks } = toBlocks(parsed.root, parsed.source);
        expect(blocks[0]).toEqual({
            type: "external",
            url: "https://service.example/tickets/42?view=full#comment-7",
            alt: "Ticket",
        });
        const html = blocksHtml(blocks);
        expect(html.match(/data-embed-url=/g)).toHaveLength(3);
        expect(html).toContain('href="https://service.example/files/source.ts#L2-L8"');
        expect(html).not.toContain("data-plugin-controls");
        expect(html).not.toContain("/api/plugins");
        for (const value of [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "https://user:secret@example.com/card",
            {},
            "https://example.com/\nprivate",
        ]) {
            expect(() => parsePluginUrl(value)).toThrow();
        }
    });

    it("escapes all JSON preset content and validates table cells", () => {
        expect(
            pluginViewHtml({
                format: "json",
                preset: "card",
                title: "<img onerror=alert(1)>",
                text: "<script>",
            }),
        ).toContain("&lt;script&gt;");
        expect(pluginViewHtml({ format: "json", preset: "list", items: ["<b>"] })).toBe(
            "<ul><li>&lt;b&gt;</li></ul>",
        );
        expect(
            pluginViewHtml({
                format: "json",
                preset: "table",
                headers: ["<head>"],
                rows: [[null], [false], [12]],
            }),
        ).toContain("<td>false</td>");
        expect(
            pluginViewHtml({ format: "json", preset: "code", value: { x: "</code><script>" } }),
        ).not.toContain("<script>");
        expect(() =>
            validatePluginView({ format: "json", preset: "table", headers: ["x"], rows: [[{}]] }),
        ).toThrow();
        expect(() =>
            validatePluginView({ format: "json", preset: "table", headers: ["x"], rows: [[1, 2]] }),
        ).toThrow();
        expect(() => validatePluginView({ format: "json", preset: "unknown" })).toThrow();
    });

    it("places HTML inside an opaque sandbox with a restrictive CSP before the content", () => {
        const html = pluginViewHtml({
            format: "html",
            html: '<script>parent.alert(1)</script><img src="https://remote.example/track">',
        });
        expect(html).toContain('sandbox=""');
        expect(html).toContain('referrerpolicy="no-referrer"');
        expect(html).toContain("default-src 'none'");
        expect(html).not.toContain("allow-scripts");
        expect(html).not.toContain("allow-same-origin");
        expect(html).not.toContain("<script>");
        expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("parent.alert"));
    });

    it("allows bounded HTML heights without accepting CSS as a size", () => {
        expect(pluginViewHtml({ format: "html", html: "card" })).toContain("height:240px");
        expect(pluginViewHtml({ format: "html", html: "card", height: 196 })).toContain(
            "height:196px",
        );
        for (const height of [0, 31, 1201, 196.5, "196;position:fixed", null]) {
            expect(() => validatePluginView({ format: "html", html: "card", height })).toThrow(
                "Invalid plugin view",
            );
        }
    });

    it("allows only the trusted height reporter to execute in auto-sized HTML", () => {
        const html = pluginViewHtml({
            format: "html",
            height: "auto",
            html: "<script>parent.alert(1)</script>",
        });
        expect(html).toContain('sandbox="allow-scripts"');
        expect(html).not.toContain("allow-same-origin");
        expect(html).toContain("default-src 'none'");
        expect(html).not.toContain("script-src 'unsafe-inline'");
        const nonce = /script-src 'nonce-([a-z0-9-]+)'/.exec(html)?.[1];
        expect(nonce).toBeTruthy();
        expect(html).toContain(`script nonce=&quot;${nonce}&quot;`);
        expect(html).toContain("doocPluginHeight");
    });

    it("validates rich collapsed views with the same rendering boundaries", () => {
        const view = validatePluginView({
            format: "json",
            preset: "card",
            title: "Ticket",
            text: "Details",
            collapsed: { format: "html", height: 56, html: "<b>Open</b><script>alert(1)</script>" },
        });
        if (!view.collapsed) throw new Error("Expected a collapsed view");
        const html = pluginViewHtml(view.collapsed);
        expect(html).toContain('sandbox=""');
        expect(html).toContain("height:56px");
        expect(html).not.toContain("allow-scripts");
        for (const collapsed of [
            "text only",
            null,
            { format: "html", html: "x", height: 0 },
            { format: "json", preset: "card", title: "Missing text" },
        ]) {
            expect(() => validatePluginView({ ...view, collapsed })).toThrow("Invalid plugin view");
        }
    });
});
