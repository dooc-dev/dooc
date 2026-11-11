import metadata from "ajv/dist/refs/json-schema-2020-12/meta/meta-data.json" with { type: "json" };
import validation from "ajv/dist/refs/json-schema-2020-12/meta/validation.json" with {
    type: "json",
};
import { SUBFORMAT_SCHEMA_VERSION } from "./subformats.js";

export type SchemaObject = Record<string, unknown>;
export const schemaTypes = validation.$defs.simpleTypes.enum;
export const schemaObject = (value: unknown): value is SchemaObject =>
    !!value && typeof value === "object" && !Array.isArray(value);

export const schemaKeyword = (name: string): SchemaObject => {
    const value =
        (validation.properties as Record<string, unknown>)[name] ??
        (metadata.properties as Record<string, unknown>)[name];
    let rule = schemaObject(value) ? value : {};
    while (typeof rule.$ref === "string" && rule.$ref.startsWith("#/$defs/")) {
        const target = (validation.$defs as Record<string, SchemaObject>)[rule.$ref.slice(8)];
        if (!target) break;
        const { $ref: _ref, ...rest } = rule;
        rule = { ...target, ...rest };
    }
    return rule;
};

export const schemaConstraints: Record<string, string[]> = {
    string: ["minLength", "maxLength", "pattern"],
    number: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
    integer: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
    array: ["minItems", "maxItems", "uniqueItems"],
    object: ["minProperties", "maxProperties"],
};

export const parseFieldSchema = (content: string): SchemaObject => {
    const schema: unknown = JSON.parse(content, (_key, value) => {
        if (
            typeof value === "number" &&
            (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
        )
            throw new Error("Use JSON text for numbers outside the safe integer range.");
        return value;
    });
    if (
        !schemaObject(schema) ||
        (schema.type !== undefined && schema.type !== "object") ||
        schema.$ref ||
        schema.$dynamicRef
    )
        throw new Error("Build kit requires an object schema.");
    if (schema.$schema !== undefined && schema.$schema !== SUBFORMAT_SCHEMA_VERSION)
        throw new Error("Build kit uses JSON Schema 2020-12.");
    return schema;
};

export const renameSchemaField = (parent: SchemaObject, from: string, to: string): void => {
    if (!to.trim()) throw new Error("Enter a field name.");
    if (from === to) return;
    const properties = schemaObject(parent.properties) ? parent.properties : {};
    if (Object.hasOwn(properties, to)) throw new Error("A field with this name already exists.");
    parent.properties = Object.fromEntries(
        Object.entries(properties).map(([name, schema]) => [name === from ? to : name, schema]),
    );
    if (Array.isArray(parent.required))
        parent.required = parent.required.map((name) => (name === from ? to : name));
};

export const schemaFieldNamesLocked = (schema: unknown): boolean => {
    if (Array.isArray(schema)) return schema.some(schemaFieldNamesLocked);
    if (!schemaObject(schema)) return false;
    return Object.entries(schema).some(
        ([key, value]) =>
            [
                "$ref",
                "$dynamicRef",
                "dependentRequired",
                "dependentSchemas",
                "if",
                "then",
                "else",
                "allOf",
                "anyOf",
                "oneOf",
                "not",
                "patternProperties",
                "propertyNames",
            ].includes(key) || schemaFieldNamesLocked(value),
    );
};

export const setSchemaType = (schema: SchemaObject, type: string): void => {
    if (!schemaTypes.includes(type)) throw new Error("Choose a schema type.");
    if (schema.type === type) return;
    const values = [
        ...(Array.isArray(schema.enum) ? schema.enum : []),
        ...["const", "default"].flatMap((key) => (Object.hasOwn(schema, key) ? [schema[key]] : [])),
    ];
    if (
        values.some((value) =>
            type === "null"
                ? value !== null
                : type === "integer"
                  ? !Number.isSafeInteger(value)
                  : type === "array"
                    ? !Array.isArray(value)
                    : type === "object"
                      ? !schemaObject(value)
                      : typeof value !== type,
        )
    )
        throw new Error(
            "Change existing choices or defaults in JSON text before changing the type.",
        );
    if (
        (schemaObject(schema.properties) && Object.keys(schema.properties).length) ||
        (schemaObject(schema.items) && Object.keys(schema.items).some((key) => key !== "type")) ||
        schema.prefixItems ||
        schema.$ref ||
        schema.oneOf ||
        schema.anyOf ||
        schema.allOf
    )
        throw new Error("Use JSON text to change a type with nested or composed rules.");
    for (const key of new Set(Object.values(schemaConstraints).flat()))
        if (!(schemaConstraints[type] ?? []).includes(key)) delete schema[key];
    if (type !== "string") delete schema.format;
    if (type !== "array") delete schema.items;
    if (type !== "object") {
        delete schema.properties;
        delete schema.required;
        delete schema.additionalProperties;
    }
    schema.type = type;
    if (type === "object") schema.properties ??= {};
    if (type === "array") schema.items ??= { type: "string" };
};

export const schemaChoices = (text: string, type: unknown): unknown[] => {
    const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
    const values = lines.map((line) => {
        if (type === "string" || type === undefined) return line;
        const value: unknown = JSON.parse(line);
        if (
            (type === "number" && typeof value === "number" && Number.isFinite(value)) ||
            (type === "integer" && Number.isSafeInteger(value)) ||
            (type === "boolean" && typeof value === "boolean") ||
            (type === "null" && value === null)
        )
            return value;
        throw new Error("Each choice must match the field type.");
    });
    if (new Set(values.map((value) => JSON.stringify(value))).size !== values.length)
        throw new Error("Choices must be unique.");
    return values;
};
