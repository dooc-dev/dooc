import { describe, expect, it } from "vitest";
import {
    layoutSchemaGraph,
    parseSchemaSource,
    routeSchemaEdges,
    SCHEMA_FRAME_LABEL_H,
    SCHEMA_FRAME_PAD,
    SCHEMA_GAP_GROUP_Y,
    SCHEMA_LAYOUT_MARGIN,
    type SchemaLayout,
    schemaFlowEdges,
    schemaGraphClientData,
    schemaGraphUid,
} from "./schema-graph.js";

const SRC = [
    "### catalog",
    "categories:",
    "  id: pk",
    "  Category description",
    "",
    "### records",
    "items:",
    "  id: pk",
    "  versions: fk(versions)",
    "  categories: fk(categories)",
    "  tags: fk[](tags)",
    "  created_at: timestamp",
    "",
    "### targets",
    "versions:",
    "  id: pk",
    "  label: string",
    "",
    "tags:",
    "  id: pk",
    "  metadata: json",
].join("\n");

const errorsOf = (src: string): string[] => parseSchemaSource(src).errors.map((e) => e.message);

describe("parseSchemaSource", () => {
    it("ignores line, trailing and multiline comments without changing the schema", () => {
        const plain =
            "a:\n  id: pk\n  name: string\n  unique(name)\n  displayed note\nb:\n  id: pk\n  a: fk(a)";
        const commented = [
            "// schema description: not a declaration",
            "a: // table",
            "  id: pk /* primary key */",
            "  /* multiline comment",
            "missing_table:",
            "  invalid: fk(missing)",
            "  */",
            "  name: /* column type */ string",
            "  unique(name) // constraint",
            "  displayed note",
            "/** table description */",
            "b:",
            "  id: pk",
            "  a: fk(/* target */ a) // reference",
        ].join("\n");
        expect(parseSchemaSource(commented)).toEqual(parseSchemaSource(plain));
    });

    it("preserves comment markers inside quoted enum values", () => {
        const { model, errors } = parseSchemaSource(
            'a:\n  url: enum("https://example.com"|"/*literal*/") // comment\n  marker: "//"|"/**/"',
        );
        expect(errors).toEqual([]);
        expect(model.tables[0]?.fields.map((field) => field.type)).toEqual([
            '"https://example.com"|"/*literal*/"',
            '"//"|"/**/"',
        ]);
    });

    it("keeps original error lines after CRLF block comments", () => {
        const { errors } = parseSchemaSource(
            "/* first\r\nsecond */\r\na:\r\n  id: pk\r\n  missing: fk(none) // note",
        );
        expect(errors).toEqual([
            { line: 4, message: '"a.missing" references table "none", which is not declared' },
        ]);
    });

    it("reports an unterminated block at its opening line and keeps preceding fields", () => {
        const { model, errors } = parseSchemaSource(
            "a:\n  id: pk\n  /* unfinished\n  broken: nope",
        );
        expect(errors).toEqual([{ line: 2, message: "/* comment is not closed — */ is required" }]);
        expect(model.tables[0]?.fields).toEqual([{ name: "id", kind: "pk" }]);
    });

    it("does not treat comments as table content or join tokens across comments", () => {
        expect(errorsOf("a:\n  // explanation only")[0]).toContain('table "a" is empty');
        expect(errorsOf("a:\n  id: str/* split */ing")[0]).toContain("unknown type");
    });

    it("maps ### to groups, indented lines to fields / notes, and fk(...) to edges", () => {
        const { model, errors } = parseSchemaSource(SRC);
        expect(errors).toEqual([]);
        expect(model.groups).toEqual([
            { label: "catalog", tables: ["categories"] },
            { label: "records", tables: ["items"] },
            { label: "targets", tables: ["versions", "tags"] },
        ]);
        // A line without ":" = a note (not a field).
        expect(model.tables[0]).toEqual({
            name: "categories",
            fields: [{ name: "id", kind: "pk" }],
            notes: ["Category description"],
        });
        expect(model.tables[1]?.fields).toEqual([
            { name: "id", kind: "pk" },
            { name: "versions", kind: "fk", targets: ["versions"] },
            { name: "categories", kind: "fk", targets: ["categories"] },
            { name: "tags", kind: "fkList", targets: ["tags"] },
            { name: "created_at", kind: "scalar", type: "timestamp" },
        ]);
        expect(model.edges).toEqual([
            {
                from: "items",
                fieldIndex: 1,
                field: "versions",
                to: "versions",
                list: false,
            },
            {
                from: "items",
                fieldIndex: 2,
                field: "categories",
                to: "categories",
                list: false,
            },
            {
                from: "items",
                fieldIndex: 3,
                field: "tags",
                to: "tags",
                list: true,
            },
        ]);
    });

    it("a polymorphic fk(a|b) draws one edge per target", () => {
        const { model, errors } = parseSchemaSource(
            ["a:", "  id: pk", "b:", "  id: pk", "j:", "  ref: fk(a|b)"].join("\n"),
        );
        expect(errors).toEqual([]);
        expect(model.edges.map((e) => `${e.from}.${e.field}→${e.to}`)).toEqual([
            "j.ref→a",
            "j.ref→b",
        ]);
    });

    it("without group headings, puts every table in one unlabeled implicit group", () => {
        const { model } = parseSchemaSource(["a:", "  id: pk"].join("\n"));
        expect(model.groups).toEqual([{ tables: ["a"] }]);
    });

    it("reports undeclared reference targets / unknown types / fk without a target as errors", () => {
        expect(errorsOf(["a:", "  ref: fk(nope)"].join("\n"))).toEqual([
            '"a.ref" references table "nope", which is not declared',
        ]);
        expect(errorsOf(["a:", "  x: strng"].join("\n"))[0]).toContain('unknown type "strng"');
        expect(errorsOf(["a:", "  x: fk"].join("\n"))[0]).toContain("requires a reference target");
        expect(errorsOf(["a:", "  x: fk[]"].join("\n"))[0]).toContain(
            "requires a reference target",
        );
        expect(errorsOf(["a:", "  x: fk()"].join("\n"))[0]).toContain(
            "has an empty reference target",
        );
    });

    it("reports duplicate declarations / lines outside a declaration / empty tables as errors", () => {
        expect(errorsOf(["a:", "  id: pk", "a:", "  id: pk"].join("\n"))).toEqual([
            'table "a" is declared twice',
        ]);
        expect(errorsOf(["a:", "  id: pk", "  id: string"].join("\n"))).toEqual([
            'table "a" declares field "id" twice',
        ]);
        expect(errorsOf(["  id: pk"].join("\n"))[0]).toContain(
            "content before any table declaration",
        );
        expect(errorsOf(["a: b:", "  id: pk"].join("\n"))[0]).toContain("table declaration");
        expect(errorsOf("a:")).toEqual(['table "a" is empty (no fields or notes)']);
    });

    it("error line numbers are relative lines within the DSL (0-indexed)", () => {
        const { errors } = parseSchemaSource(
            ["a:", "  id: pk", "  x: nope", "", "  y: fk"].join("\n"),
        );
        expect(errors.map((e) => e.line)).toEqual([2, 4]);
    });

    it("returns the drawable part of the model even with errors (so the preview can show errors and the diagram together)", () => {
        const { model, errors } = parseSchemaSource(["a:", "  id: pk", "  x: nope"].join("\n"));
        expect(errors).toHaveLength(1);
        expect(model.tables[0]?.fields).toEqual([{ name: "id", kind: "pk" }]);
    });
});

describe("enum(...)", () => {
    it("with quoted strings, kind stays scalar and type gets a label of the values joined by |", () => {
        const { model, errors } = parseSchemaSource(
            ["a:", '  kind: enum("plain"|"draft"|"final")'].join("\n"),
        );
        expect(errors).toEqual([]);
        expect(model.tables[0]?.fields).toEqual([
            { name: "kind", kind: "scalar", type: '"plain"|"draft"|"final"' },
        ]);
    });

    it("also allows bare (unquoted) tokens and trims whitespace around values", () => {
        const { model, errors } = parseSchemaSource(["a:", "  x: enum( a | b )"].join("\n"));
        expect(errors).toEqual([]);
        expect(model.tables[0]?.fields).toEqual([{ name: "x", kind: "scalar", type: "a|b" }]);
    });

    it('reports enum() / enum("") as having no values', () => {
        expect(errorsOf(["a:", "  x: enum()"].join("\n"))[0]).toContain("has no values");
        expect(errorsOf(["a:", '  x: enum("")'].join("\n"))[0]).toContain("has no values");
    });

    it("reports duplicate values as an error", () => {
        expect(errorsOf(["a:", '  x: enum("a"|"a")'].join("\n"))[0]).toContain("duplicate");
    });

    it("enum without parentheses (`kind: enum`) reports 'requires values', not 'reference target'", () => {
        const msg = errorsOf(["a:", "  x: enum"].join("\n"))[0] ?? "";
        expect(msg).toContain("requires values");
        expect(msg).not.toContain("reference target");
    });

    it("reports a bare token containing whitespace as an error (quote it or split it)", () => {
        expect(errorsOf(["a:", "  x: enum(a b)"].join("\n"))[0]).toContain("bare token");
    });

    it("enum[] (list syntax) is unsupported = unknown type error", () => {
        expect(errorsOf(["a:", "  x: enum[]"].join("\n"))[0]).toContain('unknown type "enum[]"');
    });

    it('a quoted union without enum(...) (`"a"|"b"`) yields the same label', () => {
        const { model, errors } = parseSchemaSource(
            ["a:", '  kind: "plain"|"draft"|"final"', '  mode: "latest" | "exact"'].join("\n"),
        );
        expect(errors).toEqual([]);
        expect(model.tables[0]?.fields).toEqual([
            { name: "kind", kind: "scalar", type: '"plain"|"draft"|"final"' },
            { name: "mode", kind: "scalar", type: '"latest"|"exact"' },
        ]);
    });

    it("the shorthand is validated like enum(...) (duplicates are an error)", () => {
        expect(errorsOf(["a:", '  x: "a"|"a"'].join("\n"))[0]).toContain("duplicate");
    });

    it("an unquoted union (`foo|bar`) is not treated as an enum and stays an unknown type error", () => {
        expect(errorsOf(["a:", "  x: foo|bar"].join("\n"))[0]).toContain('unknown type "foo|bar"');
    });
});

describe("composite pk (pk(...))", () => {
    // Field names go into table.pk in declaration order. The fields' own kind is unchanged (an fk
    // stays an fk).
    const PK_SRC_AFTER = [
        "item_tag_map:",
        "  item_id: fk(items)",
        "  tag_id: fk(tags)",
        "  pk(item_id, tag_id)",
        "items:",
        "  id: pk",
        "tags:",
        "  id: pk",
    ].join("\n");
    const PK_SRC_BEFORE = [
        "item_tag_map:",
        "  pk(item_id, tag_id)",
        "  item_id: fk(items)",
        "  tag_id: fk(tags)",
        "items:",
        "  id: pk",
        "tags:",
        "  id: pk",
    ].join("\n");

    it("resolves to table.pk whether written after or before the fields (declaration order)", () => {
        for (const src of [PK_SRC_AFTER, PK_SRC_BEFORE]) {
            const { model, errors } = parseSchemaSource(src);
            expect(errors).toEqual([]);
            expect(model.tables[0]?.pk).toEqual(["item_id", "tag_id"]);
            // The field-side kind is unchanged (still fk = edges are unaffected).
            expect(model.tables[0]?.fields.map((f) => f.kind)).toEqual(["fk", "fk"]);
            expect(model.edges).toHaveLength(2);
        }
    });

    it("pk(...) does not become a note (not mixed into notes)", () => {
        const { model } = parseSchemaSource(
            ["a:", "  x: fk(b)", "  y: fk(b)", "  pk(x, y)", "b:", "  id: pk"].join("\n"),
        );
        expect(model.tables[0]?.notes).toEqual([]);
        expect(model.tables[0]?.pk).toEqual(["x", "y"]);
    });

    it("a composite key needs at least 2 columns (pk() / pk(a) are errors pointing to `<field>: pk` for a single column)", () => {
        expect(errorsOf(["a:", "  x: fk(b)", "  pk()", "b:", "  id: pk"].join("\n"))[0]).toContain(
            "at least 2 columns",
        );
        const msg = errorsOf(["a:", "  x: fk(b)", "  pk(x)", "b:", "  id: pk"].join("\n"))[0] ?? "";
        expect(msg).toContain("at least 2 columns");
        expect(msg).toContain("<field>: pk");
    });

    it("reports pk(...) referencing an undefined field as an error (naming the field)", () => {
        expect(
            errorsOf(["a:", "  x: fk(b)", "  pk(x, nope)", "b:", "  id: pk"].join("\n"))[0],
        ).toContain('"nope"');
    });

    it("reports listing the same field twice as an error", () => {
        expect(
            errorsOf(
                ["a:", "  x: fk(b)", "  y: fk(b)", "  pk(x, x)", "b:", "  id: pk"].join("\n"),
            )[0],
        ).toContain("duplicate");
    });

    it("reports two pk(...) lines in one table as a duplicate declaration", () => {
        expect(
            errorsOf(
                [
                    "a:",
                    "  x: fk(b)",
                    "  y: fk(b)",
                    "  z: fk(b)",
                    "  pk(x, y)",
                    "  pk(x, z)",
                    "b:",
                    "  id: pk",
                ].join("\n"),
            )[0],
        ).toContain("twice");
    });

    it("reports a single pk field (`<field>: pk`) together with pk(...) as an error (use one or the other)", () => {
        const msg =
            errorsOf(
                ["a:", "  id: pk", "  x: fk(b)", "  y: fk(b)", "  pk(x, y)", "b:", "  id: pk"].join(
                    "\n",
                ),
            )[0] ?? "";
        expect(msg).toContain("single pk");
        expect(msg).toContain("cannot combine");
    });

    it("reports a token invalid as a field name (IDENT mismatch) as an error", () => {
        expect(
            errorsOf(
                ["a:", "  x: fk(b)", "  y: fk(b)", "  pk(x, 1bad)", "b:", "  id: pk"].join("\n"),
            )[0],
        ).toContain("only alphanumerics and _");
    });

    it("on error, leaves table.pk unset but returns the drawable part of the model", () => {
        const { model, errors } = parseSchemaSource(
            ["a:", "  x: fk(b)", "  pk(x)", "b:", "  id: pk"].join("\n"),
        );
        expect(errors).toHaveLength(1);
        expect(model.tables[0]?.pk).toBeUndefined();
        expect(model.tables[0]?.fields).toEqual([{ name: "x", kind: "fk", targets: ["b"] }]);
    });

    describe("display labels (typeLabel / measure feed both the layout and the client data)", () => {
        it("member columns get the type label `pk fk` (layout row.type)", () => {
            const { model } = parseSchemaSource(PK_SRC_AFTER);
            const layout = layoutSchemaGraph(model);
            const table = layout.tables.find((t) => t.name === "item_tag_map");
            expect(table?.rows.map((r) => r.type)).toEqual(["pk fk", "pk fk"]);
        });

        it("the same label is carried in schemaGraphClientData rows.type (both static SVG and React Flow)", () => {
            const { model } = parseSchemaSource(PK_SRC_AFTER);
            const layout = layoutSchemaGraph(model);
            const data = schemaGraphClientData("sg-pk", model, layout);
            const node = data.nodes.find((n) => n.name === "item_tag_map");
            expect(node?.rows.map((r) => r.type)).toEqual(["pk fk", "pk fk"]);
        });

        it("a composite pk including fk[] becomes `pk fk[]`", () => {
            const { model } = parseSchemaSource(
                ["a:", "  x: fk(b)", "  ys: fk[](b)", "  pk(x, ys)", "b:", "  id: pk"].join("\n"),
            );
            const layout = layoutSchemaGraph(model);
            expect(layout.tables[0]?.rows.map((r) => r.type)).toEqual(["pk fk", "pk fk[]"]);
        });

        it("edges are unchanged (same kind / count as before)", () => {
            const { model } = parseSchemaSource(PK_SRC_AFTER);
            expect(model.edges).toHaveLength(2);
            expect(model.edges.map((e) => e.list)).toEqual([false, false]);
        });

        it("box width grows by the pk label (following the charWidth estimate) and type labels fit inside the box", () => {
            // Keep the table name short so the field rows (name + gap + type label) set the box
            // width (with a long table name the header width dominates and the extra pk width
            // wouldn't show).
            const FIELDS = [
                "t:",
                "  item_reference_id: fk(b)",
                "  tag_reference_id: fk(b)",
                "b:",
                "  id: pk",
            ];
            const withoutPk = layoutSchemaGraph(parseSchemaSource(FIELDS.join("\n")).model);
            const withPk = layoutSchemaGraph(
                parseSchemaSource(
                    [
                        ...FIELDS.slice(0, 3),
                        "  pk(item_reference_id, tag_reference_id)",
                        ...FIELDS.slice(3),
                    ].join("\n"),
                ).model,
            );
            const tPk = withPk.tables.find((t) => t.name === "t");
            const tPlain = withoutPk.tables.find((t) => t.name === "t");
            expect(tPk?.w ?? 0).toBeGreaterThan(tPlain?.w ?? 0);
            // The type label's right edge (typeX) stays inside the box.
            for (const row of tPk?.rows ?? []) {
                expect(row.typeX).toBeLessThanOrEqual((tPk?.x ?? 0) + (tPk?.w ?? 0));
                expect(row.typeX).toBeGreaterThanOrEqual(tPk?.x ?? 0);
            }
        });
    });
});

describe("unique(...)", () => {
    // Outside form (outside the table, at line start; qualified form required) — an example
    // modeled on the user's real DSL.
    const UNIQUE_OUTSIDE = [
        "categories:",
        "  id: pk",
        "  display_name: string",
        "unique(categories.display_name)",
    ].join("\n");
    // Inside form (inside the table, at field-line position; unqualified is fine).
    const UNIQUE_INSIDE = [
        "categories:",
        "  id: pk",
        "  display_name: string",
        "  unique(display_name)",
    ].join("\n");
    // Inside form, qualified (allowed as long as it matches the enclosing table name).
    const UNIQUE_INSIDE_QUALIFIED = [
        "categories:",
        "  id: pk",
        "  display_name: string",
        "  unique(categories.display_name)",
    ].join("\n");

    it("the outside form (outside the table, qualified form required) resolves to table.unique", () => {
        const { model, errors } = parseSchemaSource(UNIQUE_OUTSIDE);
        expect(errors).toEqual([]);
        expect(model.tables[0]?.unique).toEqual([["display_name"]]);
    });

    it("the inside form (inside the table, unqualified) resolves to table.unique", () => {
        const { model, errors } = parseSchemaSource(UNIQUE_INSIDE);
        expect(errors).toEqual([]);
        expect(model.tables[0]?.unique).toEqual([["display_name"]]);
    });

    it("the inside form accepts a qualified name if it matches the enclosing table", () => {
        const { model, errors } = parseSchemaSource(UNIQUE_INSIDE_QUALIFIED);
        expect(errors).toEqual([]);
        expect(model.tables[0]?.unique).toEqual([["display_name"]]);
    });

    it("listing multiple columns makes a composite unique", () => {
        const { model, errors } = parseSchemaSource(
            ["a:", "  x: string", "  y: string", "  unique(x, y)"].join("\n"),
        );
        expect(errors).toEqual([]);
        expect(model.tables[0]?.unique).toEqual([["x", "y"]]);
    });

    it("line position is free — resolves even when written before the table (outside form) / before the fields (inside form)", () => {
        const before = parseSchemaSource(
            [
                "unique(categories.display_name)",
                "categories:",
                "  id: pk",
                "  display_name: string",
            ].join("\n"),
        );
        expect(before.errors).toEqual([]);
        expect(before.model.tables[0]?.unique).toEqual([["display_name"]]);

        const beforeInside = parseSchemaSource(
            ["categories:", "  unique(display_name)", "  id: pk", "  display_name: string"].join(
                "\n",
            ),
        );
        expect(beforeInside.errors).toEqual([]);
        expect(beforeInside.model.tables[0]?.unique).toEqual([["display_name"]]);
    });

    it("a table can have multiple uniques (unique(a) alongside unique(b, c) is valid)", () => {
        const { model, errors } = parseSchemaSource(
            [
                "a:",
                "  x: string",
                "  y: string",
                "  z: string",
                "  unique(x)",
                "  unique(y, z)",
            ].join("\n"),
        );
        expect(errors).toEqual([]);
        expect(model.tables[0]?.unique).toEqual([["x"], ["y", "z"]]);
    });

    it("unique(...) does not become a note (not mixed into notes)", () => {
        const { model } = parseSchemaSource(UNIQUE_INSIDE);
        expect(model.tables[0]?.notes).toEqual([]);
    });

    it("adds no edges (unique is independent of fk; same kind / count as before)", () => {
        const { model } = parseSchemaSource(
            [
                "a:",
                "  ref: fk(b)",
                "  other: string",
                "  unique(ref, other)",
                "b:",
                "  id: pk",
            ].join("\n"),
        );
        expect(model.edges).toHaveLength(1);
        expect(model.edges[0]).toEqual({
            from: "a",
            fieldIndex: 0,
            field: "ref",
            to: "b",
            list: false,
        });
    });

    describe("validation errors", () => {
        it("reports unique() / no values as requiring at least 1 column (both outside and inside)", () => {
            expect(errorsOf(["a:", "  x: string", "  unique()"].join("\n"))[0]).toContain(
                "requires at least 1 column",
            );
            expect(errorsOf(["a:", "  x: string", "unique()"].join("\n"))[0]).toContain(
                "requires at least 1 column",
            );
        });

        it("a qualifier naming an undeclared table (outside form) names the table", () => {
            const msg = errorsOf(["a:", "  id: pk", "unique(nope.x)"].join("\n"))[0] ?? "";
            expect(msg).toContain('"nope"');
            expect(msg).toContain("is not declared");
        });

        it("an undeclared field is named in the error (both outside and inside)", () => {
            expect(errorsOf(["a:", "  id: pk", "unique(a.missing)"].join("\n"))[0]).toContain(
                '"missing"',
            );
            expect(errorsOf(["a:", "  id: pk", "  unique(missing)"].join("\n"))[0]).toContain(
                '"missing"',
            );
        });

        it("reports a duplicate field within one constraint as an error", () => {
            expect(errorsOf(["a:", "  x: string", "  unique(x, x)"].join("\n"))[0]).toContain(
                "has duplicate",
            );
        });

        it("reports two uniques with the same columns in one table as a duplicate declaration (column order ignored)", () => {
            const msg =
                errorsOf(
                    ["a:", "  x: string", "  y: string", "  unique(x, y)", "  unique(y, x)"].join(
                        "\n",
                    ),
                )[0] ?? "";
            expect(msg).toContain("twice");
        });

        it("reports an error when a qualified prefix written inside a table does not match the enclosing table", () => {
            const msg =
                errorsOf(["a:", "  x: string", "  unique(b.x)", "b:", "  id: pk"].join("\n"))[0] ??
                "";
            expect(msg).toContain("does not match");
        });

        it("reports 'write <table>.<field> outside a table' when unqualified outside a table", () => {
            const msg =
                errorsOf(
                    ["categories:", "  display_name: string", "unique(display_name)"].join("\n"),
                )[0] ?? "";
            expect(msg).toContain("outside a table");
            expect(msg).toContain("<table>.<field>");
        });

        it("reports a unique with the same columns as the pk as redundant since the pk is already unique (both single and composite pk)", () => {
            const single = errorsOf(["a:", "  id: pk", "  unique(id)"].join("\n"))[0] ?? "";
            expect(single).toContain("same columns as the pk");
            expect(single).toContain("unique is redundant");

            const composite =
                errorsOf(
                    [
                        "a:",
                        "  x: fk(b)",
                        "  y: fk(b)",
                        "  pk(x, y)",
                        "  unique(x, y)",
                        "b:",
                        "  id: pk",
                    ].join("\n"),
                )[0] ?? "";
            expect(composite).toContain("same columns as the pk");
            expect(composite).toContain("unique is redundant");
        });

        it("reports a token invalid as a field / table name (IDENT mismatch) as an error", () => {
            expect(errorsOf(["a:", "  x: string", "  unique(1bad)"].join("\n"))[0]).toContain(
                "only alphanumerics and _",
            );
            expect(errorsOf(["a:", "  x: string", "unique(1bad.x)"].join("\n"))[0]).toContain(
                "only alphanumerics and _",
            );
        });

        it("reports an outside-form unique spanning tables as 'can only list columns of a single table'", () => {
            const msg =
                errorsOf(
                    ["a:", "  x: string", "b:", "  y: string", "unique(a.x, b.y)"].join("\n"),
                )[0] ?? "";
            expect(msg).toContain("only list columns of a single table");
        });

        it("on error, leaves table.unique unset but returns the drawable part of the model", () => {
            const { model, errors } = parseSchemaSource(
                ["a:", "  x: string", "  unique(nope)"].join("\n"),
            );
            expect(errors).toHaveLength(1);
            expect(model.tables[0]?.unique).toBeUndefined();
            expect(model.tables[0]?.fields).toEqual([
                { name: "x", kind: "scalar", type: "string" },
            ]);
        });
    });

    describe("display labels (typeLabel / measure feed both the layout and the client data)", () => {
        it("a table with only one unique gets an unnumbered `uq`", () => {
            const { model } = parseSchemaSource(UNIQUE_INSIDE);
            const layout = layoutSchemaGraph(model);
            const row = layout.tables[0]?.rows.find((r) => r.name === "display_name");
            expect(row?.type).toBe("uq string");
        });

        it("with two or more, labels them `uq1` / `uq2` in declaration order", () => {
            const { model } = parseSchemaSource(
                [
                    "a:",
                    "  y: fk(b)",
                    "  x: string",
                    "  unique(y)",
                    "  unique(x)",
                    "b:",
                    "  id: pk",
                ].join("\n"),
            );
            const layout = layoutSchemaGraph(model);
            expect(model.tables[0]?.unique).toEqual([["y"], ["x"]]);
            const rowY = layout.tables
                .find((t) => t.name === "a")
                ?.rows.find((r) => r.name === "y");
            const rowX = layout.tables
                .find((t) => t.name === "a")
                ?.rows.find((r) => r.name === "x");
            expect(rowY?.type).toBe("uq1 fk");
            expect(rowX?.type).toBe("uq2 string");
        });

        it("combined with pk the order is `pk uq <type>` (e.g. `pk uq fk[]`)", () => {
            const { model } = parseSchemaSource(
                [
                    "t:",
                    "  a: fk[](b)",
                    "  c: string",
                    "  d: string",
                    "  pk(a, c)",
                    "  unique(a, d)",
                    "b:",
                    "  id: pk",
                ].join("\n"),
            );
            const layout = layoutSchemaGraph(model);
            const rowA = layout.tables
                .find((t) => t.name === "t")
                ?.rows.find((r) => r.name === "a");
            expect(rowA?.type).toBe("pk uq fk[]");
        });

        it("the same label is carried in schemaGraphClientData rows.type (both static SVG and React Flow)", () => {
            const { model } = parseSchemaSource(UNIQUE_INSIDE);
            const layout = layoutSchemaGraph(model);
            const data = schemaGraphClientData("sg-uq", model, layout);
            const node = data.nodes.find((n) => n.name === "categories");
            const row = node?.rows.find((r) => r.label === "display_name");
            expect(row?.type).toBe("uq string");
        });
    });
});

describe("layoutSchemaGraph", () => {
    const { model } = parseSchemaSource(SRC);
    const layout = layoutSchemaGraph(model);

    it("always returns the same coordinates for the same model (build reproducibility)", () => {
        expect(layoutSchemaGraph(model)).toEqual(layout);
    });

    it("turns every table into a box, and boxes do not overlap", () => {
        // The order of layout.tables follows the per-band (level) group processing order, so it
        // doesn't necessarily match the declaration order of model.tables (records moves to the
        // band on the right, as checked below). Only check that every table becomes exactly one
        // box.
        expect(new Set(layout.tables.map((t) => t.name))).toEqual(
            new Set(model.tables.map((t) => t.name)),
        );
        expect(layout.tables).toHaveLength(model.tables.length);
        for (const a of layout.tables) {
            for (const b of layout.tables) {
                if (a.index >= b.index) {
                    continue;
                }
                const apart =
                    a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
                expect(apart, `${a.name} and ${b.name} overlap`).toBe(true);
            }
        }
        // Boxes fit within the canvas.
        for (const t of layout.tables) {
            expect(t.x + t.w).toBeLessThanOrEqual(layout.width);
            expect(t.y + t.h).toBeLessThanOrEqual(layout.height);
        }
    });

    it("only labeled groups get frames, and the referencing group (records) lands in a band right of the referenced ones (catalog / targets)", () => {
        // catalog and `targets` are only referenced by records (level 0) = stacked in the same band.
        // records references both (level 1), so it lands in the band to the right.
        expect(layout.groups.map((g) => g.label)).toEqual(["catalog", "targets", "records"]);
        const byLabel = new Map(layout.groups.map((g) => [g.label, g]));
        expect(byLabel.get("catalog")?.x).toBe(byLabel.get("targets")?.x);
        expect(byLabel.get("records")?.x ?? 0).toBeGreaterThan(byLabel.get("catalog")?.x ?? 0);
        // catalog and `targets` are stacked in the same band, so their y differs.
        expect(byLabel.get("catalog")?.y).not.toBe(byLabel.get("targets")?.y);
        // Frames contain their member boxes (looked up by label, not by index matching).
        const inside = (name: string, label: string): boolean => {
            const t = layout.tables.find((x) => x.name === name);
            const g = byLabel.get(label);
            return (
                t != null &&
                g != null &&
                t.x >= g.x &&
                t.x + t.w <= g.x + g.w &&
                t.y >= g.y &&
                t.y + t.h <= g.y + g.h
            );
        };
        expect(inside("categories", "catalog")).toBe(true);
        expect(inside("items", "records")).toBe(true);
        expect(inside("tags", "targets")).toBe(true);
    });

    it("unlabeled groups have no frame", () => {
        const bare = layoutSchemaGraph(
            parseSchemaSource(["###", "a:", "  id: pk"].join("\n")).model,
        );
        expect(bare.groups).toEqual([]);
        expect(bare.tables).toHaveLength(1);
    });

    it("edges leave from fk rows and have a path; only fk[] is a list", () => {
        expect(layout.edges).toHaveLength(model.edges.length);
        for (const e of layout.edges) {
            expect(e.d.startsWith("M")).toBe(true);
            expect(Number.isNaN(Number(e.d.slice(1).split(",")[0]))).toBe(false);
        }
        expect(layout.edges.filter((e) => e.list)).toHaveLength(1);
        // A legend is placed only when fk[] exists.
        expect(layout.legendY).toBeGreaterThan(0);
        expect(layoutSchemaGraph(parseSchemaSource("a:\n  id: pk").model).legendY).toBeUndefined();
    });

    it("edges entering the same target from the same column share the trunk and entry (= lines are bundled)", () => {
        // Three sources in the same column (no group heading = one column) reference the same hub.
        const bundled = layoutSchemaGraph(
            parseSchemaSource(
                [
                    "hub:",
                    "  id: pk",
                    "a:",
                    "  ref: fk(hub)",
                    "b:",
                    "  ref: fk(hub)",
                    "c:",
                    "  ref: fk(hub)",
                ].join("\n"),
            ).model,
        );
        expect(bundled.edges).toHaveLength(3);
        // The final trunk → entry segment (trunk x + entry y) is identical = they overlap as one.
        const tails = bundled.edges.map((e) => e.d.slice(e.d.lastIndexOf(" Q")));
        expect(new Set(tails).size).toBe(1);
        // Exit y differs per field row (= the origin stays visible even when bundled).
        const heads = bundled.edges.map((e) => e.d.slice(0, e.d.indexOf(" ")));
        expect(new Set(heads).size).toBe(3);
    });

    it("a self-referencing fk also gets a path (detouring right of its column)", () => {
        const self = layoutSchemaGraph(
            parseSchemaSource(["a:", "  id: pk", "  parent: fk(a)"].join("\n")).model,
        );
        expect(self.edges).toHaveLength(1);
        expect(self.edges[0]?.d).toMatch(/^M[\d.]+,[\d.]+ /);
    });

    it("routes edges spanning distant bands below the tables and includes them in the canvas height", () => {
        const distant = layoutSchemaGraph(
            parseSchemaSource(
                [
                    "### A",
                    "a:",
                    "  id: pk",
                    "### B",
                    "b:",
                    "  a: fk(a)",
                    "### C",
                    "c:",
                    "  a: fk(a)",
                    "  b: fk(b)",
                ].join("\n"),
            ).model,
        );
        const a = distant.tables.find((table) => table.name === "a");
        const c = distant.tables.find((table) => table.name === "c");
        const long = distant.edges.find((edge) => edge.from === c?.index && edge.to === a?.index);
        const tableBottom = Math.max(...distant.tables.map((table) => table.y + table.h));
        const pathYs = [...(long?.d ?? "").matchAll(/-?\d+(?:\.\d+)?,-?(\d+(?:\.\d+)?)/g)].map(
            (match) => Number(match[1]),
        );
        const edgeBottom = Math.max(...pathYs);

        expect(edgeBottom).toBeGreaterThan(tableBottom);
        expect(distant.height).toBeGreaterThan(edgeBottom);
    });

    it("splits a tall group into multiple columns internally (instead of stretching vertically)", () => {
        const many = Array.from({ length: 40 }, (_, i) => `t${i}:\n  id: pk`).join("\n");
        const wide = layoutSchemaGraph(parseSchemaSource(many).model);
        expect(new Set(wide.tables.map((t) => t.x)).size).toBeGreaterThan(1);
        expect(wide.height).toBeLessThan(1400);
    });

    describe("level (depth of inter-group references) and bands", () => {
        // Z is an isolated group unrelated to the others (declared first). A references nothing,
        // but is referenced by B (= only referenced). B references A (level 1). C references B
        // (level 2).
        const CHAIN_SRC = [
            "### Z",
            "z1:",
            "  id: pk",
            "",
            "### A",
            "a1:",
            "  id: pk",
            "",
            "### B",
            "b1:",
            "  id: pk",
            "  ref: fk(a1)",
            "",
            "### C",
            "c1:",
            "  id: pk",
            "  ref: fk(b1)",
        ].join("\n");

        const xOf = (l: SchemaLayout, label: string): number =>
            l.groups.find((g) => g.label === label)?.x ?? Number.NaN;

        it("groups referencing no other group (including only-referenced ones) are band 0, their referrers band 1, and those referrers band 2", () => {
            const { model } = parseSchemaSource(CHAIN_SRC);
            const l = layoutSchemaGraph(model);
            // Z (isolated) and A (only referenced) share a band (level 0).
            expect(xOf(l, "Z")).toBe(xOf(l, "A"));
            expect(xOf(l, "A")).toBeLessThan(xOf(l, "B"));
            expect(xOf(l, "B")).toBeLessThan(xOf(l, "C"));
        });

        it("stacking: two groups in the same band share the x range at different y (top→bottom in declaration order)", () => {
            const { model } = parseSchemaSource(CHAIN_SRC);
            const l = layoutSchemaGraph(model);
            const z = l.groups.find((g) => g.label === "Z");
            const a = l.groups.find((g) => g.label === "A");
            expect(z != null && a != null).toBe(true);
            expect(z?.x).toBe(a?.x);
            expect(z?.w).toBe(a?.w);
            expect(z?.y).not.toBe(a?.y);
            expect((z?.y ?? 0) < (a?.y ?? 0)).toBe(true);
        });

        it("group frames do not overlap (even when stacked, the lower group's label area does not hit the upper frame)", () => {
            const { model } = parseSchemaSource(CHAIN_SRC);
            const l = layoutSchemaGraph(model);
            for (const g1 of l.groups) {
                for (const g2 of l.groups) {
                    if (g1 === g2) {
                        continue;
                    }
                    const apart =
                        g1.x + g1.w <= g2.x ||
                        g2.x + g2.w <= g1.x ||
                        g1.y + g1.h <= g2.y ||
                        g2.y + g2.h <= g1.y;
                    expect(apart, `${g1.label} and ${g2.label} overlap`).toBe(true);
                }
            }
            // Z (upper) → A (lower) are stacked in the same band. The upper frame's bottom +
            // gapGroupY must be ≤ the top of the lower group's label area (= the group's
            // allocation start, frameLabelH above frame.y).
            const z = l.groups.find((g) => g.label === "Z");
            const a = l.groups.find((g) => g.label === "A");
            expect(z != null && a != null).toBe(true);
            const upperBottom = (z?.y ?? 0) + (z?.h ?? 0);
            const lowerLabelTop = (a?.y ?? 0) - (SCHEMA_FRAME_LABEL_H - SCHEMA_FRAME_PAD);
            expect(upperBottom + SCHEMA_GAP_GROUP_Y).toBeLessThanOrEqual(lowerLabelTop);
        });

        it("width shrinks: mixing isolated and connected groups fits in the width of the bands (bands < groups)", () => {
            const { model } = parseSchemaSource(CHAIN_SRC); // Z, A (band 0) / B (1) / C (2)
            const l = layoutSchemaGraph(model);
            expect(l.groups).toHaveLength(4);
            const bandXs = [...new Set(l.groups.map((g) => g.x))].sort((a, b) => a - b);
            expect(bandXs).toHaveLength(3); // 4 groups but 3 bands (Z and A stacked in band 0)

            // Measure the gap between bands (band 0's right edge → band 1's left edge).
            const widthOfBand = (bx: number): number =>
                Math.max(...l.groups.filter((g) => g.x === bx).map((g) => g.w));
            const gap = (bandXs[1] ?? 0) - ((bandXs[0] ?? 0) + widthOfBand(bandXs[0] ?? 0));

            // If each group had its own band, it would need margin*2 + sum of group widths +
            // gap × (groups - 1). Sharing bands fits in the band count (3), so it's always
            // narrower than that.
            const naiveWidth =
                SCHEMA_LAYOUT_MARGIN * 2 +
                l.groups.reduce((sum, g) => sum + g.w, 0) +
                gap * (l.groups.length - 1);
            expect(l.width).toBeLessThan(naiveWidth);
        });

        it("edges closed within a group (self-reference / same-group fk) do not add to the level (stays band 0)", () => {
            const src = [
                "### D",
                "d1:",
                "  id: pk",
                "  parent: fk(d1)",
                "  d2ref: fk(d2)",
                "d2:",
                "  id: pk",
                "",
                "### E",
                "e1:",
                "  id: pk",
            ].join("\n");
            const { model } = parseSchemaSource(src);
            const l = layoutSchemaGraph(model);
            // All of D's edges are closed within D (d1→d1, d1→d2), so D is level 0 too = same band
            // as E.
            expect(l.groups.map((g) => g.label)).toEqual(["D", "E"]);
            expect(xOf(l, "D")).toBe(xOf(l, "E"));
        });

        it("terminates deterministically on a cycle (A→B, B→A), placing both groups in the same or adjacent bands", () => {
            const src = [
                "### A",
                "a1:",
                "  id: pk",
                "  ref: fk(b1)",
                "",
                "### B",
                "b1:",
                "  id: pk",
                "  ref: fk(a1)",
            ].join("\n");
            const { model } = parseSchemaSource(src);
            const l1 = layoutSchemaGraph(model);
            // Deterministic (same input → same output).
            expect(layoutSchemaGraph(model)).toEqual(l1);
            const a = l1.groups.find((g) => g.label === "A");
            const b = l1.groups.find((g) => g.label === "B");
            expect(a != null && b != null).toBe(true);
            // A, explored first in declaration order, goes right as the referencing group
            // (level 1); the B→A reference, treated as a back-edge, doesn't count, so B is
            // level 0 = the band to the left (adjacent band).
            expect((b?.x ?? 0) < (a?.x ?? 0)).toBe(true);
        });

        it("always yields the same bands (x) for the same model (build reproducibility)", () => {
            const { model } = parseSchemaSource(CHAIN_SRC);
            expect(layoutSchemaGraph(model).groups.map((g) => g.label)).toEqual(
                layoutSchemaGraph(model).groups.map((g) => g.label),
            );
            expect(layoutSchemaGraph(model).groups.map((g) => g.x)).toEqual(
                layoutSchemaGraph(model).groups.map((g) => g.x),
            );
        });
    });
});

describe("routeSchemaEdges", () => {
    const { model } = parseSchemaSource(SRC);
    const layout = layoutSchemaGraph(model);

    it("given the same boxes as the layout, yields the same routes (route SoT for the static SVG)", () => {
        expect(routeSchemaEdges(layout.tables, model.edges)).toEqual(layout.edges);
    });
});

describe("schemaGraphClientData / schemaFlowEdges", () => {
    // The interactive UI (React Flow) starts from the static SVG's model / initial layout.
    const { model } = parseSchemaSource(SRC);
    const layout = layoutSchemaGraph(model);
    const data = schemaGraphClientData("sg-x", model, layout);

    it("source holds the given DSL text verbatim, and the field is omitted when unset / empty", () => {
        // The interactive UI's source viewer shows the source text (rebuilding it from the model
        // would lose notes / blank lines / ordering).
        expect(schemaGraphClientData("sg-s", model, layout, SRC).source).toBe(SRC);
        // Without source, the viewer button isn't shown = the field itself is omitted.
        expect(data.source).toBeUndefined();
        expect("source" in schemaGraphClientData("sg-s", model, layout, "")).toBe(false);
    });

    it("nodes match the static SVG boxes in position / content (rows carry display text and a dy for handles)", () => {
        expect(data.nodes.map((n) => n.name)).toEqual(layout.tables.map((t) => t.name));
        const first = data.nodes[0];
        const box = layout.tables[0];
        expect(first?.x).toBe(box?.x);
        expect(first?.y).toBe(box?.y);
        expect(first?.rows[0]).toEqual({
            kind: "pk",
            label: "id",
            type: "pk",
            dy: 35.5,
            fieldIndex: 0,
        });
        // Note rows have no fieldIndex (no handles are attached).
        expect(first?.rows[1]?.fieldIndex).toBeUndefined();
        expect(data.edges).toEqual(model.edges);
        // Group frames carry their member table names (to redraw frames after drag). records
        // references both catalog / `targets`, so it's level 1 (the band to the right) = pushed after
        // catalog, `targets` in band 0.
        expect(data.groups.map((g) => g.label)).toEqual(["catalog", "targets", "records"]);
        expect(data.groups[1]?.members).toEqual(["versions", "tags"]);
    });

    it("connection sides follow relative position and swap when a box moves", () => {
        const placed = data.nodes.map((n) => ({ name: n.name, x: n.x, w: n.w }));
        const initial = schemaFlowEdges(placed, model.edges);
        // items (referencing, level 1 = right band) → versions (referenced, level 0 = left band)
        // exits left and enters from the right.
        const toVersions = initial.find((e) => e.to === "versions");
        expect(toVersions?.sourceSide).toBe("l");
        expect(toVersions?.targetSide).toBe("r");
        // Moving versions far to the right of records reverses it.
        const moved = placed.map((p) => (p.name === "versions" ? { ...p, x: 4000 } : p));
        const after = schemaFlowEdges(moved, model.edges).find((e) => e.to === "versions");
        expect(after?.sourceSide).toBe("r");
        expect(after?.targetSide).toBe("l");
        // ids are unique per edge (React Flow key).
        expect(new Set(initial.map((e) => e.id)).size).toBe(initial.length);
    });

    it("group members keep their original tables even when bands change (no index matching)", () => {
        // B is referenced only by A (level 0), C is isolated (no edges, level 0) — they stack in
        // band 0 as B → C, in declaration order. A references B, so level 1 = band 1.
        // members keeps the table names in declaration order (c1, c2).
        const src = [
            "### A",
            "a1:",
            "  id: pk",
            "  ref: fk(b1)",
            "",
            "### B",
            "b1:",
            "  id: pk",
            "",
            "### C",
            "c1:",
            "  id: pk",
            "c2:",
            "  id: pk",
        ].join("\n");
        const { model } = parseSchemaSource(src);
        const layout2 = layoutSchemaGraph(model);
        const data2 = schemaGraphClientData("sg-y", model, layout2);
        expect(data2.groups.map((g) => g.label)).toEqual(["B", "C", "A"]);
        expect(data2.groups[0]?.members).toEqual(["b1"]);
        expect(data2.groups[1]?.members).toEqual(["c1", "c2"]);
        expect(data2.groups[2]?.members).toEqual(["a1"]);
    });
});

describe("schemaGraphUid", () => {
    it("is derived deterministically from model content and changes when the content changes", () => {
        const a = parseSchemaSource(SRC).model;
        expect(schemaGraphUid(a)).toBe(schemaGraphUid(parseSchemaSource(SRC).model));
        expect(schemaGraphUid(a)).not.toBe(schemaGraphUid(parseSchemaSource("b:\n  id: pk").model));
    });
});
