import { describe, expect, it } from "vitest";
import { parsePluginUrl, validatePluginView } from "../../../plugins/src/view.js";
import { parseDoc } from "../../engine/src/compiler/dialect.js";
import { toBlocks } from "../../engine/src/compiler/from-mdast.js";
import { blocksHtml } from "../../engine/src/core/html.js";
import { pluginViewHtml } from "./plugin-view.js";

describe("plugin references and presentation", () => {
    it("keeps service embeds and their fragments as links outside the viewer", () => {
        const source = `
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

    it("renders expanded and collapsed blocks without a format discriminator", () => {
        const view = validatePluginView({
            header: { title: "Ticket", reference: "runtime-id" },
            blocks: [{ type: "text", text: "<script>alert(1)</script>" }],
            collapsed: { blocks: [{ type: "context", items: ["Open", "runtime-id"] }] },
        });
        expect(pluginViewHtml(view)).toContain("&lt;script&gt;");
        expect(pluginViewHtml(view)).not.toContain("<iframe");
        expect(view).not.toHaveProperty("format");
        if (!view.collapsed) throw new Error("Expected a collapsed view");
        expect(pluginViewHtml(view.collapsed)).toContain("runtime-id");
        for (const collapsed of [null, "text", {}, { blocks: [{ type: "html", html: "<b>" }] }])
            expect(() => validatePluginView({ ...view, collapsed })).toThrow("Invalid plugin view");
    });

    it.each([
        { format: "html", html: "<script>alert(1)</script>" },
        { format: "json", preset: "card", title: "Old", text: "Old" },
        { format: "json", preset: "list", items: ["Old"] },
        { format: "json", preset: "table", headers: ["Old"], rows: [[1]] },
        { format: "json", preset: "code", value: { old: true } },
        { format: "blocks", blocks: [] },
    ])("rejects removed view formats: %j", (legacy) => {
        expect(() => validatePluginView(legacy)).toThrow("Invalid plugin view");
        expect(() => validatePluginView({ blocks: [], collapsed: legacy })).toThrow(
            "Invalid plugin view",
        );
    });
});
