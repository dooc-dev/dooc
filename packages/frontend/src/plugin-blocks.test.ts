import { describe, expect, it } from "vitest";
import {
    validatePluginActionRequest,
    validatePluginActions,
    validatePluginActionValues,
} from "../../../plugins/src/actions.js";
import { validatePluginView } from "../../../plugins/src/view.js";
import { pluginViewHtml } from "./plugin-view.js";

describe("plugin blocks", () => {
    it("renders structured content as escaped host DOM with safe markdown and action bindings", () => {
        const html = pluginViewHtml({
            header: { title: "Example" },
            blocks: [
                {
                    type: "heading",
                    text: '<img onerror="alert(1)">',
                    edit: { action: 'edit" onclick="alert(1)', field: "title" },
                },
                {
                    type: "text",
                    text: "**Bold** [safe](https://example.com) [unsafe](javascript:alert(1)) <script>alert(1)</script>",
                    markdown: true,
                },
                { type: "code", text: "+<img>\n-removed", diff: true },
                {
                    type: "message",
                    author: "Alice",
                    text: "Reply",
                    reactions: [
                        {
                            label: "👍",
                            count: 2,
                            action: "react",
                            active: true,
                            values: { emoji: "+1" },
                        },
                    ],
                },
            ],
        });
        expect(html).not.toMatch(/<iframe|<script|<img| onclick="|href="javascript:/);
        expect(html).toContain("<strong>Bold</strong>");
        expect(html).toContain('rel="noopener noreferrer"');
        expect(html).toContain('aria-pressed="true"');
        expect(html).toContain("&lt;img&gt;");
    });
    it("rejects unsafe links, arbitrary block types, malformed fields and unbounded nesting", () => {
        for (const block of [
            { type: "html", html: "<script>" },
            { type: "context", items: [{ text: "x", url: "javascript:alert(1)" }] },
            { type: "context", items: [{ text: "x", url: "https://user:secret@example.com" }] },
            { type: "fields", items: [{ label: "X", items: [null] }] },
            { type: "table", headers: ["x"], rows: [{ cells: [] }] },
            { type: "message", author: "X", text: "x", reactions: [{ label: "x", count: -1 }] },
            { type: "progress", label: "Done", value: 101 },
        ])
            expect(() => validatePluginView({ blocks: [block] })).toThrow();
        let block: unknown = { type: "text", text: "x" };
        for (let i = 0; i < 10; i++) block = { type: "section", title: "Nested", blocks: [block] };
        expect(() => validatePluginView({ blocks: [block] })).toThrow();
        expect(() =>
            validatePluginView({
                blocks: [],
                header: { title: "X", icon: { light: "https://tracking.example/icon.svg" } },
            }),
        ).toThrow();
    });
    it("validates form definitions and rejects forged selections, dates and versions", () => {
        const [action] = validatePluginActions([
            {
                id: "edit",
                label: "Edit",
                target: "Item",
                version: "v1",
                partial: true,
                fields: [
                    {
                        name: "state",
                        label: "State",
                        type: "select",
                        options: [{ value: "open", label: "Open" }],
                    },
                    {
                        name: "labels",
                        label: "Labels",
                        type: "multiselect",
                        value: "[]",
                        options: [{ value: "bug", label: "Bug" }],
                    },
                    { name: "due", label: "Due", type: "date" },
                    { name: "input:stage", label: "Stage", type: "text" },
                ],
            },
        ]);
        if (!action) throw new Error("Missing action");
        for (const values of [
            { state: "invalid" },
            { labels: '["bug","bug"]' },
            { due: "2026-02-30" },
            { forged: "x" },
            {},
        ] as Record<string, string>[])
            expect(() =>
                validatePluginActionValues(action, { id: "edit", version: "v1", values }),
            ).toThrow();
        expect(() =>
            validatePluginActionValues(action, {
                id: "edit",
                version: "old",
                values: { state: "open" },
            }),
        ).toThrow("Content changed");
        expect(() =>
            validatePluginActionValues(action, {
                id: "edit",
                version: "v1",
                values: { state: "open", "input:stage": "staging" },
            }),
        ).not.toThrow();
        expect(() => validatePluginActionRequest({ id: "edit", values: { state: {} } })).toThrow();
        expect(() =>
            validatePluginActions([
                {
                    ...action,
                    fields: [
                        { name: "x", label: "X", type: "multiselect", value: "{}", options: [] },
                    ],
                },
            ]),
        ).toThrow();
    });
});
