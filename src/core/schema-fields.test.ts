import { expect, it } from "vitest";
import { compileSubformatSchema } from "../compiler/subformats.js";
import {
    formatSchemaChoices,
    parseFieldSchema,
    parseSchemaParameter,
    renameSchemaField,
    type SchemaObject,
    schemaChoices,
    schemaFieldNamesLocked,
    schemaKeyword,
    schemaTypes,
    setSchemaType,
} from "./schema-fields.js";
import { SUBFORMAT_SCHEMA_TEMPLATE } from "./subformats.js";

it("reads type choices and keyword constraints from the 2020-12 meta-schema", () => {
    expect(schemaTypes).toEqual([
        "array",
        "boolean",
        "integer",
        "null",
        "number",
        "object",
        "string",
    ]);
    expect(schemaKeyword("minLength")).toMatchObject({ type: "integer", minimum: 0, default: 0 });
    expect(schemaKeyword("multipleOf")).toMatchObject({ type: "number", exclusiveMinimum: 0 });
    expect(schemaKeyword("description")).toMatchObject({ type: "string" });
});

it("renames a field and its required entry without losing annotations or other rules", () => {
    const schema = parseFieldSchema(SUBFORMAT_SCHEMA_TEMPLATE);
    expect(schema.properties).toEqual({});
    expect(schema.required).toBeUndefined();
    expect(() => compileSubformatSchema(SUBFORMAT_SCHEMA_TEMPLATE)).not.toThrow();
    schema.properties = { title: { type: "string", minLength: 1 } };
    schema.required = ["title"];
    schema.examples = [{ title: "Keep the example" }];
    renameSchemaField(schema, "title", "name");
    expect(schema.required).toEqual(["name"]);
    expect(schema.properties).toEqual({ name: { type: "string", minLength: 1 } });
    expect(schema.examples).toEqual([{ title: "Keep the example" }]);
    expect(() => compileSubformatSchema(JSON.stringify(schema))).not.toThrow();
    expect(() => renameSchemaField(schema, "name", "")).toThrow();
    (schema.properties as SchemaObject).other = { type: "number" };
    expect(() => renameSchemaField(schema, "name", "other")).toThrow("already exists");
    expect(schema.required).toEqual(["name"]);
});

it("updates type-specific controls without leaving invalid constraints or deleting nested rules", () => {
    const field: SchemaObject = {
        type: "string",
        minLength: 2,
        title: "Count",
        description: "Keep me",
    };
    setSchemaType(field, "integer");
    expect(field).toEqual({ type: "integer", title: "Count", description: "Keep me" });
    setSchemaType(field, "array");
    expect(field.items).toEqual({ type: "string" });
    setSchemaType(field, "object");
    expect(field.properties).toEqual({});
    (field.properties as SchemaObject).nested = { type: "string" };
    const before = JSON.stringify(field);
    expect(() => setSchemaType(field, "number")).toThrow("nested");
    expect(JSON.stringify(field)).toBe(before);
    expect(() => setSchemaType({ type: "string", enum: ["One"] }, "integer")).toThrow("choices");
});

it("keeps references and conditional schemas intact and locks linked field names", () => {
    const schema = {
        type: "object",
        properties: { owner: { $ref: "#/$defs/person" } },
        $defs: { person: { type: "object" } },
        if: { properties: { owner: { type: "object" } } },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword.
        then: { required: ["owner"] },
    };
    expect(schemaFieldNamesLocked(schema)).toBe(true);
    expect(parseFieldSchema(JSON.stringify(schema))).toEqual(schema);
    expect(schemaFieldNamesLocked(JSON.parse(SUBFORMAT_SCHEMA_TEMPLATE))).toBe(false);
    expect(
        schemaFieldNamesLocked({
            type: "object",
            properties: { value: { enum: [{ $ref: "literal data" }] } },
        }),
    ).toBe(false);
});

it("keeps incomplete, unsupported and imprecise JSON in text mode", () => {
    for (const source of [
        '{"type":',
        '{"type":"object","default":9007199254740993}',
        '{"$schema":"http://json-schema.org/draft-07/schema#"}',
    ])
        expect(() => parseFieldSchema(source)).toThrow();
});

it("parses enum controls with the selected type and rejects duplicates or mixed types", () => {
    expect(schemaChoices("Todo\nDone", "string")).toEqual(["Todo", "Done"]);
    expect(schemaChoices("1\n2", "integer")).toEqual([1, 2]);
    expect(schemaChoices("true\nfalse", "boolean")).toEqual([true, false]);
    expect(() => schemaChoices("one\none", "string")).toThrow("unique");
    expect(() => schemaChoices("1\n1.5", "integer")).toThrow("field type");
});

it("roundtrips every JSON enum value without losing empty, multiline or quoted strings", () => {
    for (const [type, values] of [
        ["string", ["", "a\nb", "a\rb", '"quoted"', "  space  ", "Todo"]],
        ["number", [0, -1.5, 2]],
        ["boolean", [true, false]],
        ["null", [null]],
        ["array", [[1], ["a", null]]],
        ["object", [{ a: 1 }, { b: [true] }]],
        [undefined, ["text", 1, false, null, [], {}]],
        [
            ["string", "null"],
            ["", null],
        ],
    ] as const) {
        const choices = [...values];
        expect(schemaChoices(formatSchemaChoices(choices, type), type)).toEqual(choices);
    }
    expect(() =>
        schemaChoices('{"a":1,"b":{"x":2,"y":3}}\n{"b":{"y":3,"x":2},"a":1}', "object"),
    ).toThrow("unique");
    for (const invalid of ["\n", "1e400", "9007199254740993", '"a","type":"object"'])
        expect(() => schemaChoices(invalid, undefined)).toThrow();
});

it("edits constants and composed schemas without accepting malformed parameter shapes", () => {
    expect(parseSchemaParameter("const", '""', "string")).toBe("");
    expect(parseSchemaParameter("const", "null", ["string", "null"])).toBeNull();
    for (const key of ["oneOf", "anyOf", "allOf"]) {
        expect(parseSchemaParameter(key, '[{"type":"string"},false]', undefined)).toEqual([
            { type: "string" },
            false,
        ]);
        for (const invalid of ["[]", "{}", "[null]", "[1]"])
            expect(() => parseSchemaParameter(key, invalid, undefined)).toThrow();
    }
    expect(parseSchemaParameter("$defs", '{"status":{"enum":["Todo","Done"]}}', undefined)).toEqual(
        { status: { enum: ["Todo", "Done"] } },
    );
    expect(() => parseSchemaParameter("$defs", '{"status":null}', undefined)).toThrow();
    expect(() => parseSchemaParameter("not", "[]", undefined)).toThrow();
    expect(() => parseSchemaParameter("const", "1", "string")).toThrow("field type");
    expect(() => parseSchemaParameter("default", "1e400", undefined)).toThrow();
    const schema = { type: "string", enum: ["a"] };
    setSchemaType(schema, "");
    expect(schema).toEqual({ enum: ["a"] });
    const reference = { type: "string", $ref: "common.schema.json", oneOf: [{ type: "number" }] };
    setSchemaType(reference, "");
    expect(reference).toEqual({ $ref: "common.schema.json", oneOf: [{ type: "number" }] });
});
