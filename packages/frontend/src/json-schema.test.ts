import { expect, it } from "vitest";
import type { SchemaObject } from "../../engine/src/core/schema-fields.js";
import { jsonSchemaHtml } from "./json-schema.js";

it("documents nested requirements, constraints and boolean schemas while escaping schema content", () => {
    const schema = {
        type: "object",
        description: '<img src=x onerror="alert(1)">',
        properties: {
            address: {
                type: "object",
                properties: { postcode: { type: "string", pattern: "^[0-9]+$" } },
                required: ["postcode"],
            },
            tags: { type: "array", items: { type: "string", enum: ["<script>", "&"] } },
            count: { type: ["integer", "null"], minimum: 0, default: 0 },
            active: { type: "boolean", default: false },
            forbidden: false,
        },
        required: ["address"],
        additionalProperties: false,
    };
    const html = jsonSchemaHtml(schema, { uri: "file:///schema.json", schemas: {} });
    expect(html).toMatch(/<code>address<\/code>\s*<span[^>]*>object<\/span>\s*<span[^>]*>Required/);
    expect(html).toMatch(
        /<code>postcode<\/code>\s*<span[^>]*>string<\/span>\s*<span[^>]*>Required/,
    );
    expect(html).toMatch(/<code>tags<\/code>\s*<span[^>]*>array<\/span>\s*<span[^>]*>Optional/);
    expect(html).toContain("integer | null");
    expect(html).toContain("No values allowed");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("^[0-9]+$");
    expect(html).toContain("<dd><code>0</code></dd>");
    expect(html).toContain("<dd><code>false</code></dd>");
    expect(html.indexOf("<code>address</code>")).toBeLessThan(html.indexOf("Schema settings"));
});

it("keeps reference and sibling rules separate and stops recursive references", () => {
    const schema = {
        type: "object",
        properties: {
            name: { $ref: "common.json#name", type: "string", minLength: 5 },
            child: { $ref: "#" },
            forbidden: { $ref: "#/$defs/never" },
        },
        $defs: { never: false },
    };
    const common = { $anchor: "name", type: "string", minLength: 2, description: "Shared name" };
    const html = jsonSchemaHtml(schema, {
        uri: "https://schemas.example.com/root.json",
        schemas: { "https://schemas.example.com/common.json": common },
    });
    expect(html).toContain("Shared name");
    expect(html).toContain("common.json#name");
    expect(html).toContain("<dd><code>5</code></dd>");
    expect(html).toContain("<dd><code>2</code></dd>");
    expect(html).toContain("Recursive reference");
    expect(html).toContain("No values allowed");
    expect(html.length).toBeLessThan(30_000);
    expect(html).not.toContain("https://schemas.example.com/root.json");
});

it("preserves composition, tuple items and deeply nested definitions", () => {
    let nested: SchemaObject = { const: "Deep value" };
    for (let i = 0; i < 20; i++) nested = { type: "array", items: nested };
    const schema = {
        type: "object",
        properties: {
            choice: { oneOf: [{ type: "string" }, { type: "integer" }] },
            tuple: { type: "array", prefixItems: [{ type: "boolean" }], items: false },
            nested,
        },
    };
    const html = jsonSchemaHtml(schema, { uri: "file:///schema.json", schemas: {} });
    expect(html).toContain("oneOf 1");
    expect(html).toContain("oneOf 2");
    expect(html).toContain("prefixItems 1");
    expect(html).toContain("<dd><code>false</code></dd>");
    expect(html).toContain("Deep value");
});
