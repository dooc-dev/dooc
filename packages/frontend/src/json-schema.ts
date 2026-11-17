import { escapeHtml } from "../../engine/src/core/escape-html.js";
import { type SchemaObject, schemaObject } from "../../engine/src/core/schema-fields.js";
import { type SchemaContext, schemaResolver } from "../../engine/src/core/schema-refs.js";

/** Readable schema documentation; native disclosures also work in standalone HTML. */
export const jsonSchemaHtml = (schema: SchemaObject, context: SchemaContext): string => {
    const resolve = schemaResolver(schema, context);
    const text = (value: unknown): string =>
        escapeHtml(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    const render = (
        value: unknown,
        name: string,
        required: boolean | undefined,
        ancestors: ReadonlySet<string>,
        depth: number,
    ): string => {
        const node = schemaObject(value) ? value : {};
        let reference: { uri: string; target: unknown } | undefined;
        const resolved = resolve(value, (uri, target) => {
            reference ??= { uri, target };
        });
        const type =
            typeof value === "boolean"
                ? value
                    ? "Any type"
                    : "No values allowed"
                : Array.isArray(resolved.type)
                  ? resolved.type.join(" | ")
                  : typeof resolved.type === "string"
                    ? resolved.type
                    : "Any type";
        const status = required === undefined ? "" : required ? "Required" : "Optional";
        const summary = `<summary><code>${escapeHtml(name)}</code> <span class="json-schema-type" data-i18n="${escapeHtml(type)}">${escapeHtml(type)}</span>${status ? ` <span class="json-schema-required" data-i18n="${status}">${status}</span>` : ""}</summary>`;
        // shortcut: deeply nested schemas keep their JSON; add lazy expansion if needed.
        if (depth >= 16)
            return `<details class="json-schema-node">${summary}<div class="json-schema-body"><pre>${text(value)}</pre></div></details>`;
        const children: string[] = [];
        if (reference?.target !== undefined) {
            children.push(
                ancestors.has(reference.uri)
                    ? '<p data-i18n="Recursive reference">Recursive reference</p>'
                    : render(
                          reference.target,
                          "$ref",
                          undefined,
                          new Set([...ancestors, reference.uri]),
                          depth + 1,
                      ),
            );
        }
        const nested = new Set<string>();
        for (const key of [
            "properties",
            "patternProperties",
            "$defs",
            "definitions",
            "dependentSchemas",
        ]) {
            if (!schemaObject(node[key])) continue;
            nested.add(key);
            const items = Object.entries(node[key]).map(([field, definition]) =>
                render(
                    definition,
                    field,
                    key === "properties"
                        ? Array.isArray(node.required) && node.required.includes(field)
                        : undefined,
                    ancestors,
                    depth + 1,
                ),
            );
            if (items.length)
                children.push(
                    `<div class="json-schema-children"><p class="json-schema-keyword"><code>${key}</code></p>${items.join("")}</div>`,
                );
        }
        for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
            if (!Array.isArray(node[key])) continue;
            nested.add(key);
            children.push(
                ...node[key].map((child, index) =>
                    render(child, `${key} ${index + 1}`, undefined, ancestors, depth + 1),
                ),
            );
        }
        for (const key of [
            "items",
            "additionalProperties",
            "unevaluatedProperties",
            "unevaluatedItems",
            "contains",
            "propertyNames",
            "not",
            "if",
            "then",
            "else",
        ]) {
            if (!schemaObject(node[key])) continue;
            nested.add(key);
            children.push(render(node[key], key, undefined, ancestors, depth + 1));
        }
        const rules = Object.entries(node)
            .filter(([key]) => !["title", "description", "type"].includes(key) && !nested.has(key))
            .map(
                ([key, value]) =>
                    `<div><dt><code>${escapeHtml(key)}</code></dt><dd><code>${text(value)}</code></dd></div>`,
            )
            .join("");
        const description = [node.title, node.description]
            .filter((value): value is string => typeof value === "string")
            .map((value) => `<p>${escapeHtml(value)}</p>`)
            .join("");
        const constraints = rules ? `<dl class="json-schema-rules">${rules}</dl>` : "";
        const body =
            depth === 0
                ? `${children.join("")}${constraints ? `<details><summary data-i18n="Schema settings">Schema settings</summary>${constraints}</details>` : ""}`
                : constraints + children.join("");
        return `<details class="json-schema-node"${depth === 0 ? " open" : ""}>${summary}<div class="json-schema-body">${description}${body}</div></details>`;
    };
    return `<section class="json-schema" aria-label="JSON Schema">${render(schema, "$", undefined, new Set(), 0)}</section>`;
};
