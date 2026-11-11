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

export const schemaJsonParameters = [
    "const",
    "default",
    "examples",
    "oneOf",
    "anyOf",
    "allOf",
    "not",
    "$defs",
];

const matchesType = (value: unknown, type: unknown): boolean =>
    type === undefined ||
    (Array.isArray(type)
        ? type.some((item) => matchesType(value, item))
        : type === "null"
          ? value === null
          : type === "integer"
            ? Number.isSafeInteger(value)
            : type === "array"
              ? Array.isArray(value)
              : type === "object"
                ? schemaObject(value)
                : typeof value === type);

const parseSchemaJson = (content: string): unknown =>
    JSON.parse(content, (_key, value) => {
        if (
            typeof value === "number" &&
            (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
        )
            throw new Error("Use JSON text for numbers outside the safe integer range.");
        return value;
    });

export const parseFieldSchema = (content: string): SchemaObject => {
    const schema = parseSchemaJson(content);
    if (!schemaObject(schema)) throw new Error("Build kit requires a schema object.");
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
            ].includes(key) ||
            (!["enum", "const", "default", "examples"].includes(key) &&
                schemaFieldNamesLocked(value)),
    );
};

export const setSchemaType = (schema: SchemaObject, type: string): void => {
    if (type && !schemaTypes.includes(type)) throw new Error("Choose a schema type.");
    if ((schema.type ?? "") === type) return;
    const values = [
        ...(Array.isArray(schema.enum) ? schema.enum : []),
        ...["const", "default"].flatMap((key) => (Object.hasOwn(schema, key) ? [schema[key]] : [])),
    ];
    if (type && values.some((value) => !matchesType(value, type)))
        throw new Error("Change existing choices or defaults before changing the type.");
    if (
        (schemaObject(schema.properties) && Object.keys(schema.properties).length) ||
        (schemaObject(schema.items) && Object.keys(schema.items).some((key) => key !== "type")) ||
        schema.prefixItems
    )
        throw new Error("Remove nested fields before changing the type.");
    for (const key of new Set(Object.values(schemaConstraints).flat()))
        if (!(schemaConstraints[type] ?? []).includes(key)) delete schema[key];
    if (type !== "string") delete schema.format;
    if (type !== "array") delete schema.items;
    if (type !== "object") {
        delete schema.properties;
        delete schema.required;
        delete schema.additionalProperties;
    }
    if (type) schema.type = type;
    else delete schema.type;
    if (type === "object") schema.properties ??= {};
    if (type === "array") schema.items ??= { type: "string" };
};

export const formatSchemaChoices = (values: unknown[], type: unknown): string =>
    values
        .map((value) =>
            type === "string" &&
            typeof value === "string" &&
            value !== "" &&
            !/[\r\n]/.test(value) &&
            !value.trimStart().startsWith('"')
                ? value
                : JSON.stringify(value),
        )
        .join("\n");

export const schemaChoices = (text: string, type: unknown): unknown[] => {
    const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
    const values = lines.map((line) => {
        const value: unknown =
            type === "string" && !line.trimStart().startsWith('"') ? line : parseSchemaJson(line);
        if (!matchesType(value, type)) throw new Error("Each choice must match the field type.");
        return value;
    });
    if (!values.length) throw new Error("Enter at least one choice.");
    if (
        new Set(
            values.map((value) =>
                JSON.stringify(value, (_key, item) =>
                    schemaObject(item)
                        ? Object.fromEntries(
                              Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
                          )
                        : item,
                ),
            ),
        ).size !== values.length
    )
        throw new Error("Choices must be unique.");
    return values;
};

export const parseSchemaParameter = (key: string, text: string, type: unknown): unknown => {
    const value = parseSchemaJson(text);
    const isSchema = (item: unknown) => typeof item === "boolean" || schemaObject(item);
    if (
        ["oneOf", "anyOf", "allOf"].includes(key) &&
        (!Array.isArray(value) || !value.length || !value.every(isSchema))
    )
        throw new Error("Enter a non-empty JSON array of schemas.");
    if (key === "not" && !isSchema(value))
        throw new Error("Enter a JSON schema object or boolean.");
    if (key === "$defs" && (!schemaObject(value) || !Object.values(value).every(isSchema)))
        throw new Error("Enter an object containing named schemas.");
    if (key === "examples" && !Array.isArray(value))
        throw new Error("Examples must be a JSON array.");
    if (key === "const" && !matchesType(value, type))
        throw new Error("The constant must match the field type.");
    return value;
};
