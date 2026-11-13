import { type SchemaObject, schemaObject } from "./schema-fields.js";

export interface SchemaContext {
    uri: string;
    schemas: Record<string, SchemaObject | boolean>;
}

/** Visit schema positions only; defaults, examples and enum values are data. */
export const visitSchema = (
    schema: unknown,
    base: string,
    visit: (schema: SchemaObject, base: string) => void,
): void => {
    if (!schemaObject(schema)) return;
    if (typeof schema.$id === "string") base = new URL(schema.$id, base).href;
    visit(schema, base);
    for (const key of [
        "properties",
        "patternProperties",
        "$defs",
        "definitions",
        "dependentSchemas",
    ])
        if (schemaObject(schema[key]))
            for (const child of Object.values(schema[key])) visitSchema(child, base, visit);
    for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"])
        if (Array.isArray(schema[key]))
            for (const child of schema[key]) visitSchema(child, base, visit);
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
    ])
        visitSchema(schema[key], base, visit);
};

export const schemaResolver = (schema: SchemaObject, context?: SchemaContext) => {
    const base = context?.uri ?? "file:///schema.json";
    const resources = new Map<string, unknown>();
    const bases = new WeakMap<SchemaObject, string>();
    for (const [uri, document] of Object.entries({ ...context?.schemas, [base]: schema })) {
        resources.set(uri, document);
        visitSchema(document, uri, (node, resolved) => {
            bases.set(node, resolved);
            if (node === document || typeof node.$id === "string") resources.set(resolved, node);
            for (const key of ["$anchor", "$dynamicAnchor"])
                if (typeof node[key] === "string")
                    resources.set(`${resolved.split("#")[0]}#${node[key]}`, node);
        });
    }
    /** `onRef` receives the absolute URI of every `$ref` hop followed. */
    return (definition: unknown, onRef?: (uri: string) => void): SchemaObject => {
        let current = schemaObject(definition) ? definition : {};
        let result = current;
        const seen = new Set<SchemaObject>();
        while (typeof current.$ref === "string" && !seen.has(current)) {
            seen.add(current);
            const uri = new URL(current.$ref, bases.get(current) ?? base);
            onRef?.(uri.href);
            let target = resources.get(uri.href);
            if (target === undefined) {
                const fragment = decodeURIComponent(uri.hash.slice(1));
                uri.hash = "";
                target = resources.get(uri.href);
                if (fragment && !fragment.startsWith("/")) break;
                for (const key of fragment ? fragment.slice(1).split("/") : []) {
                    const name = key.replaceAll("~1", "/").replaceAll("~0", "~");
                    target =
                        target && typeof target === "object" && Object.hasOwn(target, name)
                            ? (target as SchemaObject)[name]
                            : undefined;
                }
            }
            if (!schemaObject(target)) break;
            const { $ref: _ref, ...siblings } = result;
            result = { ...target, ...siblings };
            current = target;
        }
        return result;
    };
};
