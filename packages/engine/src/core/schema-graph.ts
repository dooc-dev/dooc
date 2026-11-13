// SoT for the content dialect `schemath` (table DSL) — DSL parse / graph model / deterministic
// layout. Browser-safe (no dependencies). html.ts owns the markup (SVG); this module returns only
// semantics and geometry (= every consumer gets the same picture via docHtml).
//
// DSL inside a `schemath` code fence or a .schemath file:
//     ### <label>                group boundary (labeled = frame + heading on the graph;
//                                unlabeled only splits columns)
//     <table>:                   table declaration (the following indented lines are its body)
//       <field>: pk              primary key
//       <field>: fk(<table>)     reference (polymorphic = union `fk(a|b)` = multiple edges)
//       <field>: fk[](<table>)   array of references (1:N, drawn dashed)
//       <field>: string          scalar (types are the closed set SCHEMA_SCALAR_TYPES)
//       <field>: enum("a"|"b")   enum (display label joins the values with `|`; quoted strings
//                                and bare tokens are both allowed)
//       <field>: "a"|"b"         enum shorthand (only a union whose tokens are all quoted
//                                strings; same as `enum(...)`)
//     pk(<field>, <field>, ...)  composite primary key (2+ columns; may be written before or
//                                after the field lines; `pk` is shown alongside in type labels)
//       unique(<field>, ...)     unique constraint (inside the table, at field-line position;
//                                unqualified is fine. The qualified form `<table>.<field>` is
//                                also allowed but must match the enclosing table)
//       <note>                   a line without ":" = a note on that table (faint, no edges)
//     // comment                source comment to end of line (not shown in the diagram)
//     /* comment */             may span lines; not treated as a comment inside strings
//     unique(<table>.<field>, ...) unique constraint (outside the table, at line start, same
//                                column as table declarations. Qualified form required. A table
//                                may have several (they coexist). `uq` (only one) / `uq1`,`uq2`..
//                                (two or more, declaration order) is shown alongside in type
//                                labels)
//
// Undeclared reference targets / unknown types / duplicate declarations are all validation
// errors (= not publishable) (picked up by dialect.ts).
//
// Band order (SoT for layoutSchemaGraph): column bands are built from the depth (= level) of
// inter-group edges (edges closed within a group are excluded). Groups that reference no other
// group (including groups that are only referenced) are level 0; a referencing group is one
// level deeper (= the band to the right) than the group it references. Bands run left → right
// in ascending level; groups of the same level stack top → bottom in declaration order (a band
// may hold several groups).

import { depthLevels, hashId, orthPath, round1, splitByHeight, textW } from "./graph-common.js";
import { scanSchemaComments } from "./schema-comments.js";

/** Closed set of scalar types (anything else is a validation error). */
export const SCHEMA_SCALAR_TYPES = ["string", "number", "bool", "json", "timestamp"] as const;
export type SchemaScalarType = (typeof SCHEMA_SCALAR_TYPES)[number];

/** A single field. kind = pk / fk / fkList (fk[]) / scalar. */
export interface SchemaField {
    name: string;
    kind: "pk" | "fk" | "fkList" | "scalar";
    /**
     * Scalar only. `kind: "scalar"` has two origins: a plain scalar = one of the closed set
     * `SCHEMA_SCALAR_TYPES`; from `enum("a"|"b")` = the display label itself, the written values
     * joined with `|` (e.g. `"a"|"b"`).
     */
    type?: string;
    /** fk / fkList only. A union (`fk(a|b)`) yields several. */
    targets?: string[];
}

export interface SchemaTable {
    name: string;
    fields: SchemaField[];
    /** Lines without a value (= descriptions). */
    notes: string[];
    /**
     * Field names in the composite primary key (`pk(<field>, <field>, ...)`), in declaration
     * order. A single pk stays as `kind: "pk"` on the field (it can't coexist with this array =
     * validation error). Absent = no composite pk. The fields' own `kind` is unchanged (an fk
     * stays an fk = edges are unaffected).
     */
    pk?: string[];
    /**
     * Field names of each unique constraint (`unique(<field>, ...)`), in declaration order. One
     * element per constraint; a table may declare several uniques (= array of arrays;
     * `unique(a)` alongside `unique(b, c)` is valid). A unique over the same column set as the pk
     * is rejected as a validation error (the pk is already unique), so only column sets that
     * differ from the pk end up here. The fields' own `kind` is unchanged (= no extra edges).
     */
    unique?: string[][];
}

/** A group delimited by `###`. A frame + heading is drawn on the graph only when it has a label. */
export interface SchemaGroup {
    label?: string;
    /** Member table names (declaration order). groups partition all tables (none is ungrouped). */
    tables: string[];
}

/** One fk reference = one edge (a union yields one per target). */
export interface SchemaEdge {
    from: string;
    /** Field index within the from table (key for hover linkage). */
    fieldIndex: number;
    field: string;
    to: string;
    /** Whether it's fk[] (1:N). */
    list: boolean;
}

export interface SchemaModel {
    groups: SchemaGroup[];
    tables: SchemaTable[];
    edges: SchemaEdge[];
}

/** Error with a DSL line number (0-indexed, relative to the DSL). */
export interface SchemaParseError {
    line: number;
    message: string;
}

export interface SchemaParseResult {
    model: SchemaModel;
    errors: SchemaParseError[];
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TYPE_HINT = `pk / fk(<table>) / fk[](<table>) / enum("a"|"b") / ${SCHEMA_SCALAR_TYPES.join(" / ")}`;

// One value of enum(...). A quoted string (`"..."`) keeps its quotes in the label; a bare token
// is the plain string. A bare token can't contain `|` / `)` / whitespace (splitting on "|" has
// already happened, so effectively only ")"/whitespace are rejected).
const ENUM_BARE = /^[^\s|")]+$/;
// Enum with `enum(...)` omitted (`"a"|"b"`). Treated as an enum only when every token is a quoted
// string (an unquoted union like `foo|bar` becomes an unknown-type error, catching typos).
const QUOTED_UNION = /^"[^"]*"(\s*\|\s*"[^"]*")*$/;
const parseEnumToken = (token: string): { label: string; content: string } | undefined => {
    if (token.startsWith('"')) {
        const m = /^"([^"]*)"$/.exec(token);
        return m == null ? undefined : { label: token, content: m[1] ?? "" };
    }
    return ENUM_BARE.test(token) ? { label: token, content: token } : undefined;
};

/**
 * table DSL → graph model + errors. Even with errors, a partial model is returned
 * (so preview can show "validation errors + as much as can be drawn" at the same time).
 */
export const parseSchemaSource = (source: string): SchemaParseResult => {
    const scanned = scanSchemaComments(source);
    const errors: SchemaParseError[] = [...scanned.errors];
    const tables: SchemaTable[] = [];
    const groups: SchemaGroup[] = [];
    const byName = new Map<string, SchemaTable>();
    // Declaration lines (so later cross-check errors point at the right line).
    // key = table name / `<table>.<field>`.
    const declLine = new Map<string, number>();
    // table name → composite pk (`pk(...)`) declaration (line number + field names, declaration
    // order). Only the first one per table is kept (later ones are rejected as duplicate
    // declarations). Field existence / coexistence with a single pk isn't checked here; a later
    // pass resolves them after the whole table has been read.
    const pkDecl = new Map<string, { line: number; fields: string[] }>();
    // table name (owner) → unique(...) declarations (line number + field names, declaration
    // order). Unlike pk, a table may have several, hence an array (`unique(a)` alongside
    // `unique(b, c)` is valid). As with pk(...), checks for field existence / column-set match
    // against the pk / duplicate declarations run in a later pass after the whole table has been
    // read (since it may be written before or after the table).
    const uniqueDecl = new Map<string, { line: number; fields: string[] }[]>();
    let group: SchemaGroup | undefined;
    let current: SchemaTable | undefined;
    /** Skip the body of a table whose declaration errored (prevents cascading errors). */
    let skipping = false;

    const err = (line: number, message: string): void => {
        errors.push({ line, message });
    };
    // Validates the body of unique(...) (comma-separated tokens) and records it on the owner
    // table (inside a table: enclosing; outside: determined from each token's qualifier) as a
    // declaration for later resolution. enclosing == null means outside a table (qualified form
    // `<table>.<field>` required); otherwise inside a table (unqualified is fine, but a qualifier
    // must match enclosing). Field existence / cross-check with the pk / duplicate declarations
    // are resolved after the whole table has been read (same approach as pk(...)).
    const recordUnique = (line: number, inner: string, enclosing: string | undefined): void => {
        const tokens = inner
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t !== "");
        if (tokens.length === 0) {
            err(line, `unique(...) requires at least 1 column (e.g. "unique(<field>)")`);
            return;
        }
        // token → qualifier (table part) / field part. No "." means unqualified (tbl = undefined).
        const parsed = tokens.map((token) => {
            const idx = token.indexOf(".");
            return idx < 0
                ? { token, tbl: undefined as string | undefined, fld: token }
                : { token, tbl: token.slice(0, idx).trim(), fld: token.slice(idx + 1).trim() };
        });
        if (enclosing == null) {
            const bare = parsed.filter((p) => p.tbl == null).map((p) => p.token);
            if (bare.length > 0) {
                err(
                    line,
                    `"${bare.join(", ")}" must be written as "<table>.<field>" outside a table (qualified form required)`,
                );
                return;
            }
        } else {
            const mismatched = parsed
                .filter((p) => p.tbl != null && p.tbl !== enclosing)
                .map((p) => p.token);
            if (mismatched.length > 0) {
                err(
                    line,
                    `"${mismatched.join(", ")}" has a qualifier prefix that does not match the enclosing table "${enclosing}"`,
                );
                return;
            }
        }
        const badTokens = parsed
            .filter((p) => (p.tbl != null && !IDENT.test(p.tbl)) || !IDENT.test(p.fld))
            .map((p) => p.token);
        if (badTokens.length > 0) {
            err(
                line,
                `unique(...) field name "${badTokens.join(", ")}" must contain only alphanumerics and _ (starting with a letter or _)`,
            );
            return;
        }
        const fields = parsed.map((p) => p.fld);
        const dup = fields.find((f, idx) => fields.indexOf(f) !== idx);
        if (dup != null) {
            err(line, `unique(...) has duplicate field "${dup}"`);
            return;
        }
        const owner = enclosing ?? parsed[0]?.tbl;
        if (owner == null) {
            return;
        }
        if (enclosing == null) {
            // The outside form's grammar lets each token name its own table, but unique is a
            // constraint over the columns of a single table (SchemaTable.unique is confined to
            // one table), so every token must match the first token's table.
            const foreign = parsed.filter((p) => p.tbl !== owner).map((p) => p.token);
            if (foreign.length > 0) {
                err(
                    line,
                    `unique(...) can only list columns of a single table ("${owner}" and "${foreign.join(", ")}" are mixed)`,
                );
                return;
            }
        }
        const entry = { line, fields };
        const list = uniqueDecl.get(owner);
        if (list) {
            list.push(entry);
        } else {
            uniqueDecl.set(owner, [entry]);
        }
    };
    // Tables that appear before any group heading go into an implicit unlabeled group
    // (= groups partition all tables).
    const ensureGroup = (): SchemaGroup => {
        if (group == null) {
            group = { tables: [] };
            groups.push(group);
        }
        return group;
    };

    scanned.source.split("\n").forEach((raw, i) => {
        const body = raw.trim();
        if (body === "") {
            return;
        }
        if (body.startsWith("```")) {
            err(i, "``` is not allowed (write the table DSL directly inside schemath)");
            return;
        }
        if (!/^\s/.test(raw)) {
            // Clear the skip state at each new top-level declaration (= at most one error per
            // declaration).
            skipping = false;
            const heading = /^###\s*(.*)$/.exec(body);
            if (heading) {
                const label = (heading[1] ?? "").trim();
                group = { ...(label === "" ? {} : { label }), tables: [] };
                groups.push(group);
                current = undefined;
                return;
            }
            // unique(...) outside a table (qualified form required). It doesn't end with ":", so
            // without this check it would fall into the "table declaration or group heading
            // required" error below (= check before decl).
            const uniqueOutside = /^unique\((.*)\)$/.exec(body);
            if (uniqueOutside) {
                recordUnique(i, uniqueOutside[1] ?? "", undefined);
                return;
            }
            const decl = /^([^:]*):$/.exec(body);
            if (decl == null) {
                err(
                    i,
                    `a table declaration (\`<name>:\`) or group heading (\`###\`) is required ("${body}") — fields must be indented`,
                );
                current = undefined;
                skipping = true;
                return;
            }
            const name = (decl[1] ?? "").trim();
            if (!IDENT.test(name)) {
                err(
                    i,
                    `table name "${name}" must contain only alphanumerics and _ (starting with a letter or _)`,
                );
                current = undefined;
                skipping = true;
                return;
            }
            if (byName.has(name)) {
                err(i, `table "${name}" is declared twice`);
                current = undefined;
                skipping = true;
                return;
            }
            const table: SchemaTable = { name, fields: [], notes: [] };
            tables.push(table);
            byName.set(name, table);
            declLine.set(name, i);
            ensureGroup().tables.push(name);
            current = table;
            return;
        }
        // Silently drop the body of a table whose declaration is broken (no cascading errors).
        if (skipping) {
            return;
        }
        if (current == null) {
            err(i, `content before any table declaration ("${body}")`);
            return;
        }
        const sep = body.indexOf(":");
        if (sep < 0) {
            // Composite primary key (`pk(<field>, <field>, ...)`). It contains no ":", so check
            // it before the note check (= otherwise it would become a note). Field existence /
            // coexistence with a single pk are validated in a later pass after the whole table
            // has been read (so fields may be written before or after pk(...)).
            const pkCall = /^pk\((.*)\)$/.exec(body);
            if (pkCall) {
                const fields = (pkCall[1] ?? "")
                    .split(",")
                    .map((t) => t.trim())
                    .filter((t) => t !== "");
                if (fields.length < 2) {
                    err(
                        i,
                        `composite key requires at least 2 columns (use "<field>: pk" for a single column) — "pk(${pkCall[1] ?? ""})"`,
                    );
                    return;
                }
                const badTokens = fields.filter((t) => !IDENT.test(t));
                if (badTokens.length > 0) {
                    err(
                        i,
                        `pk(...) field name "${badTokens.join(", ")}" must contain only alphanumerics and _ (starting with a letter or _)`,
                    );
                    return;
                }
                const dup = fields.find((t, idx) => fields.indexOf(t) !== idx);
                if (dup != null) {
                    err(i, `pk(...) has duplicate field "${dup}"`);
                    return;
                }
                if (pkDecl.has(current.name)) {
                    err(i, `table "${current.name}" declares pk(...) twice`);
                    return;
                }
                pkDecl.set(current.name, { line: i, fields });
                return;
            }
            // unique(...) (inside a table; unqualified is fine, a qualifier must match the
            // enclosing table). Like pk(...), it has no ":", so check it before the note check.
            const uniqueInside = /^unique\((.*)\)$/.exec(body);
            if (uniqueInside) {
                recordUnique(i, uniqueInside[1] ?? "", current.name);
                return;
            }
            current.notes.push(body);
            return;
        }
        const name = body.slice(0, sep).trim();
        const value = body.slice(sep + 1).trim();
        if (!IDENT.test(name)) {
            err(
                i,
                `field name "${name}" must contain only alphanumerics and _ (starting with a letter or _)`,
            );
            return;
        }
        if (current.fields.some((f) => f.name === name)) {
            err(i, `table "${current.name}" declares field "${name}" twice`);
            return;
        }
        if (value === "pk") {
            current.fields.push({ name, kind: "pk" });
            return;
        }
        const fk = /^fk(\[\])?\((.*)\)$/.exec(value);
        if (fk) {
            const targets = (fk[2] ?? "")
                .split("|")
                .map((t) => t.trim())
                .filter((t) => t !== "");
            if (targets.length === 0) {
                err(
                    i,
                    `"${name}: ${value}" has an empty reference target — write it as fk(<table>)`,
                );
                return;
            }
            const bad = targets.filter((t) => !IDENT.test(t));
            if (bad.length > 0) {
                err(i, `"${name}" references "${bad.join(", ")}", which is an invalid table name`);
                return;
            }
            declLine.set(`${current.name}.${name}`, i);
            current.fields.push({ name, kind: fk[1] == null ? "fk" : "fkList", targets });
            return;
        }
        if (/^fk(\[\])?$/.test(value)) {
            err(
                i,
                `"${name}: ${value}" requires a reference target — write it as fk(<table>) / fk[](<table>)`,
            );
            return;
        }
        // Enum — `enum("a"|"b")` and the shorthand `"a"|"b"` (a union whose tokens are all quoted
        // strings). Both produce the same label (values joined with `|`). Stop at the first error.
        const enumBody =
            /^enum\((.*)\)$/.exec(value)?.[1] ?? (QUOTED_UNION.test(value) ? value : undefined);
        if (enumBody != null) {
            const values: string[] = [];
            const seen = new Set<string>();
            for (const token of enumBody.split("|").map((t) => t.trim())) {
                if (token === "") {
                    continue;
                }
                const parsed = parseEnumToken(token);
                if (parsed == null) {
                    err(
                        i,
                        `"${name}" value "${token}" must be a "..."-quoted string or a bare token (no |, ) or whitespace)`,
                    );
                    return;
                }
                if (parsed.content === "") {
                    err(i, `"${name}: ${value}" has no values — write it as enum("a"|"b")`);
                    return;
                }
                if (seen.has(parsed.content)) {
                    err(i, `"${name}" has duplicate value "${parsed.label}"`);
                    return;
                }
                seen.add(parsed.content);
                values.push(parsed.label);
            }
            if (values.length === 0) {
                err(i, `"${name}: ${value}" has no values — write it as enum("a"|"b")`);
                return;
            }
            current.fields.push({ name, kind: "scalar", type: values.join("|") });
            return;
        }
        if (value === "enum") {
            err(i, `"${name}: ${value}" requires values — write it as enum("a"|"b")`);
            return;
        }
        if ((SCHEMA_SCALAR_TYPES as readonly string[]).includes(value)) {
            current.fields.push({ name, kind: "scalar", type: value });
            return;
        }
        err(i, `unknown type "${value}" ("${name}") — allowed: ${TYPE_HINT}`);
    });

    for (const table of tables) {
        if (table.fields.length === 0 && table.notes.length === 0) {
            err(
                declLine.get(table.name) ?? 0,
                `table "${table.name}" is empty (no fields or notes)`,
            );
        }
    }

    // Composite pks (`pk(...)`) are resolved after the whole table has been read: validate
    // coexistence with a single-pk field / existence of the referenced fields, and set `table.pk`
    // only when there's no error (keeping the policy of returning a drawable model even with
    // errors = on error, pk is simply left unset).
    for (const [tableName, decl] of pkDecl) {
        const table = byName.get(tableName);
        if (table == null) {
            continue;
        }
        if (table.fields.some((f) => f.kind === "pk")) {
            err(
                decl.line,
                `table "${tableName}" cannot combine a single pk ("<field>: pk") with pk(...) (use one or the other)`,
            );
            continue;
        }
        const known = new Set(table.fields.map((f) => f.name));
        const missing = decl.fields.filter((f) => !known.has(f));
        if (missing.length > 0) {
            err(decl.line, `pk(...) field "${missing.join(", ")}" is not declared`);
            continue;
        }
        table.pk = decl.fields;
    }

    // Like pk(...), unique(...) is resolved after the whole table has been read: validate table /
    // field existence, that it isn't the pk's column set (redundant; the pk is already unique),
    // and that no unique with the same column set is duplicated within a table; only constraints
    // without errors are added to `table.unique` (policy of returning a drawable model even with
    // errors = on error, that constraint is simply not added).
    const sameFieldSet = (a: readonly string[], b: readonly string[]): boolean =>
        a.length === b.length && [...a].sort().join(" ") === [...b].sort().join(" ");
    for (const [tableName, decls] of uniqueDecl) {
        const table = byName.get(tableName);
        if (table == null) {
            for (const decl of decls) {
                err(decl.line, `unique(...) table "${tableName}" is not declared`);
            }
            continue;
        }
        const known = new Set(table.fields.map((f) => f.name));
        const singlePk = table.fields.find((f) => f.kind === "pk")?.name;
        const pkFieldSet = table.pk ?? (singlePk == null ? undefined : [singlePk]);
        const accepted: string[][] = [];
        for (const decl of decls) {
            const missing = decl.fields.filter((f) => !known.has(f));
            if (missing.length > 0) {
                err(decl.line, `unique(...) field "${missing.join(", ")}" is not declared`);
                continue;
            }
            if (pkFieldSet != null && sameFieldSet(decl.fields, pkFieldSet)) {
                err(
                    decl.line,
                    `unique(${decl.fields.join(", ")}) has the same columns as the pk — the pk is already unique, so unique is redundant`,
                );
                continue;
            }
            if (accepted.some((f) => sameFieldSet(f, decl.fields))) {
                err(
                    decl.line,
                    `table "${tableName}" declares unique(${decl.fields.join(", ")}) twice (same columns)`,
                );
                continue;
            }
            accepted.push(decl.fields);
        }
        if (accepted.length > 0) {
            table.unique = accepted;
        }
    }

    // Edges in declaration order (table → field → union target). Target existence is validated
    // here.
    const edges: SchemaEdge[] = [];
    const seen = new Set<string>();
    for (const table of tables) {
        table.fields.forEach((field, fieldIndex) => {
            if (field.kind !== "fk" && field.kind !== "fkList") {
                return;
            }
            for (const to of field.targets ?? []) {
                if (!byName.has(to)) {
                    err(
                        declLine.get(`${table.name}.${field.name}`) ?? 0,
                        `"${table.name}.${field.name}" references table "${to}", which is not declared`,
                    );
                    continue;
                }
                const key = `${table.name}.${field.name}→${to}`;
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                edges.push({
                    from: table.name,
                    fieldIndex,
                    field: field.name,
                    to,
                    list: field.kind === "fkList",
                });
            }
        });
    }

    return { model: { groups, tables, edges }, errors };
};

/**
 * Short id derived deterministically from the model contents. Used as the namespace for SVG
 * markers / classes (no id collisions when one page has several graphs; no randomness / time =
 * reproducible builds).
 */
export const schemaGraphUid = (model: SchemaModel): string => hashId(JSON.stringify(model));

/* ---------------------------------------------------------------- layout ---- */

/**
 * One row in a table box (field or note). All coordinates are absolute px (= the renderer holds
 * no geometry). y = row center, baseline = text baseline, x = left edge of the name,
 * typeX = right edge of the type label.
 */
export interface SchemaLayoutRow {
    kind: SchemaField["kind"] | "note";
    name: string;
    /** Type label (`pk` / `fk` / `fk[]` / scalar type name; empty for notes). */
    type: string;
    y: number;
    baseline: number;
    x: number;
    typeX: number;
    /** Field rows only (undefined for notes). Key for hover linkage. */
    fieldIndex?: number;
}

export interface SchemaLayoutTable {
    name: string;
    index: number;
    x: number;
    y: number;
    w: number;
    h: number;
    headerH: number;
    /** Text baseline y of the header (table name). */
    headerBaseline: number;
    /** Corner radius of the box. */
    radius: number;
    rows: SchemaLayoutRow[];
}

export interface SchemaLayoutGroup {
    label: string;
    x: number;
    y: number;
    w: number;
    h: number;
    /**
     * Member table names (declaration order). Column reordering (independent groups pushed left)
     * makes the order of `layout.groups` diverge from the declaration order of `model.groups`, so
     * this lets the mapping be looked up without relying on index matching (used by
     * `schemaGraphClientData`).
     */
    members: string[];
}

/**
 * Minimal box shape read by edge routing (`SchemaLayoutTable` satisfies it structurally). The
 * client passes data of this shape, embedded in the SVG, to the same `routeSchemaEdges` (= the
 * routing rules aren't implemented twice).
 */
export interface SchemaRouteBox {
    name: string;
    index: number;
    x: number;
    y: number;
    w: number;
    h: number;
    headerH: number;
    /** Used to look up fk rows' y (no fieldIndex = note row). */
    rows: readonly { y: number; fieldIndex?: number }[];
}

/** One interactive-UI (React Flow) node = a table box, with the static SVG's position / content. */
export interface SchemaFlowNode {
    name: string;
    index: number;
    x: number;
    y: number;
    w: number;
    h: number;
    headerH: number;
    /** Rows (field / note). dy = center y from the box top (vertical position of the handle). */
    rows: {
        kind: SchemaField["kind"] | "note";
        label: string;
        type: string;
        dy: number;
        fieldIndex?: number;
    }[];
}

/**
 * Client data embedded in the SVG (`data-sg-layout`). The interactive UI (React Flow) reads only
 * this and starts from the same picture as the static SVG (= no parse or layout on the client).
 */
export interface SchemaGraphClientData {
    uid: string;
    width: number;
    height: number;
    nodes: SchemaFlowNode[];
    edges: SchemaEdge[];
    /** Group frames (labeled only). members = member table names (to refit frames after drag). */
    groups: { label: string; x: number; y: number; w: number; h: number; members: string[] }[];
    /**
     * Source text of the table DSL as written (the `schemath` body itself). The interactive UI's
     * source viewer shows it as-is. Not derived from the model, since rebuilding it from the model
     * would lose notes / blank lines / ordering. When absent, the viewer button isn't shown.
     */
    source?: string;
}

/** One interactive-UI edge, with its exit and entry sides decided (independent of the UI lib). */
export interface SchemaFlowEdge {
    id: string;
    from: string;
    to: string;
    fieldIndex: number;
    list: boolean;
    /** Exit side / entry side (l = left, r = right). Recomputed when a box moves. */
    sourceSide: "l" | "r";
    targetSide: "l" | "r";
}

/**
 * Decides each edge's connecting sides from the current box positions (a pure function meant to
 * be re-called on every drag). Target to the right: exit right, enter left; to the left: the
 * reverse; overlapping: rightward.
 */
export const schemaFlowEdges = (
    nodes: readonly { name: string; x: number; w: number }[],
    edges: readonly SchemaEdge[],
): SchemaFlowEdge[] => {
    const byName = new Map(nodes.map((n) => [n.name, n]));
    return edges.map((e) => {
        const s = byName.get(e.from);
        const t = byName.get(e.to);
        const rightward = s != null && t != null && t.x + t.w / 2 >= s.x + s.w / 2;
        return {
            id: `${e.from}.${e.field}-${e.fieldIndex}→${e.to}`,
            from: e.from,
            to: e.to,
            fieldIndex: e.fieldIndex,
            list: e.list,
            sourceSide: rightward ? "r" : "l",
            targetSide: rightward ? "l" : "r",
        };
    });
};

export interface SchemaLayoutEdge {
    /** Table index (index into SchemaLayout.tables). */
    from: number;
    to: number;
    fieldIndex: number;
    list: boolean;
    /** SVG path d: orthogonal, 3 segments up close, 5 below the tables between distant columns. */
    d: string;
}

export interface SchemaLayout {
    width: number;
    height: number;
    groups: SchemaLayoutGroup[];
    tables: SchemaLayoutTable[];
    edges: SchemaLayoutEdge[];
    /** Baseline y of the legend (only when fk[] exists). */
    legendY?: number;
}

// Geometry constants (px). Font metrics can't be measured, so widths are charWidth estimates
// (= deterministic).
const M = {
    headerH: 26,
    rowH: 19,
    padX: 11,
    padBottom: 9,
    gapNameType: 18,
    minW: 158,
    gapY: 22,
    gapInnerX: 30,
    gapGroupX: 108,
    /** Gap between groups stacked in one band (frame bottom → top of next group's label area). */
    gapGroupY: 40,
    framePad: 14,
    frameLabelH: 22,
    maxColH: 1020,
    lane: 10,
    corner: 7,
    margin: 16,
    legendH: 24,
    radius: 10,
    /** How far the text baseline sits below the row center (assumes a ~11.5px font). */
    baselineDrop: 4,
} as const;

/** Left edge of the legend / group labels (used by the renderer). */
export const SCHEMA_LAYOUT_MARGIN = M.margin;
/** Minimum gap between groups stacked in one band (tests use it to verify non-overlap). */
export const SCHEMA_GAP_GROUP_Y = M.gapGroupY;
/** Group frame label-area height / padding (tests use them to derive the "label top"). */
export const SCHEMA_FRAME_LABEL_H = M.frameLabelH;
export const SCHEMA_FRAME_PAD = M.framePad;

// compositePk = whether this field takes part in the table's composite pk (`pk(...)`).
// uniqueLabel = label of the unique constraint it takes part in ("uq", or "uq1"/"uq2".. in
// declaration order; undefined if none). The combined order is `pk uq <type>` (e.g. `pk fk` /
// `uq1 fk` / `pk uq fk[]` / `uq string`). A single pk (`kind: "pk"`) has no "type" slot (base is
// undefined), so only isPk (from kind or from compositePk) goes first and "pk" isn't listed
// twice. A single pk and a composite pk never coexist (error at parse time), so a field with
// compositePk true never has kind "pk". Handling it all here means both the static SVG (html.ts)
// and React Flow (schemaGraphClientData) pick it up automatically, with no extra render branches.
const typeLabel = (f: SchemaField, compositePk = false, uniqueLabel?: string): string => {
    const isPk = f.kind === "pk" || compositePk;
    const base =
        f.kind === "pk"
            ? undefined
            : f.kind === "fk"
              ? "fk"
              : f.kind === "fkList"
                ? "fk[]"
                : (f.type ?? "");
    return [
        ...(isPk ? ["pk"] : []),
        ...(uniqueLabel == null ? [] : [uniqueLabel]),
        ...(base == null ? [] : [base]),
    ].join(" ");
};

// Builds a reverse lookup from table.unique: field name → uq label ("uq", or "uq1"/"uq2".. in
// declaration order). A table with a single unique gets no number (every column belongs to the
// same one constraint, so it's unnecessary); with two or more, declaration-order numbers show
// which columns share a constraint. If a field takes part in several constraints (rare), the
// label of the first one found (= earliest in declaration order) wins.
const uniqueLabelsOf = (table: SchemaTable): Map<string, string> => {
    const constraints = table.unique ?? [];
    const labels = new Map<string, string>();
    constraints.forEach((fields, i) => {
        const label = constraints.length > 1 ? `uq${i + 1}` : "uq";
        for (const f of fields) {
            if (!labels.has(f)) {
                labels.set(f, label);
            }
        }
    });
    return labels;
};

/** Row from the measure stage (y relative to the table top; layout assigns absolute coords). */
interface MeasuredRow {
    kind: SchemaLayoutRow["kind"];
    name: string;
    type: string;
    y: number;
    fieldIndex?: number;
}

interface Measured {
    w: number;
    h: number;
    rows: MeasuredRow[];
}

// Box size + rows (y relative to the table top). Width fits the longest "name + type label" row.
const measure = (table: SchemaTable): Measured => {
    const rows: MeasuredRow[] = [];
    let y = M.headerH;
    let inner = textW(table.name, 12.5 / 12);
    const pkFields = new Set(table.pk ?? []);
    const uqLabels = uniqueLabelsOf(table);
    table.fields.forEach((f, fieldIndex) => {
        const type = typeLabel(f, pkFields.has(f.name), uqLabels.get(f.name));
        inner = Math.max(inner, textW(f.name) + M.gapNameType + textW(type, 10.5 / 12));
        rows.push({ kind: f.kind, name: f.name, type, y: y + M.rowH / 2, fieldIndex });
        y += M.rowH;
    });
    for (const note of table.notes) {
        inner = Math.max(inner, textW(note, 10.5 / 12));
        rows.push({ kind: "note", name: note, type: "", y: y + M.rowH / 2 });
        y += M.rowH;
    }
    return {
        w: Math.max(M.minW, Math.ceil(inner + M.padX * 2)),
        h: y + M.padBottom,
        rows,
    };
};

// Split tall groups into several internal columns (so they don't grow too tall). The split is
// greedy = deterministic (graph-common.splitByHeight is the SoT for the rule; this only maps it
// to table indices).
const splitColumns = (indices: number[], measured: Measured[]): number[][] =>
    splitByHeight(
        indices.map((i) => measured[i]?.h ?? 0),
        M.gapY,
        M.maxColH,
    ).map((col) =>
        col.flatMap((k) => {
            const i = indices[k];
            return i == null ? [] : [i];
        }),
    );

interface Routed {
    edge: SchemaEdge;
    from: number;
    to: number;
    /** Exit point (box side at the fk field row). */
    sx: number;
    sy: number;
    /** Entry x (side of the target box). */
    tx: number;
    /** Side through which the edge enters the target. */
    side: "l" | "r";
    /**
     * Bundle key = target + entry side + exit column. A bundle shares its trunk x and entry y
     * (= lines are merged).
     */
    bundle: string;
    /** Reference trunk x (center of the gutter next to the exit column). */
    base: number;
    /** Spread of the trunk lanes, determined by the gutter width. */
    room: number;
    /**
     * Long-distance edge with another table column in between. Diverted to a dedicated lane
     * outside the tables.
     */
    long: boolean;
    /** Center of the gutter next to the target's side. Used for a long edge's entry-side trunk. */
    targetBase: number;
}

interface RoutedSchemaEdges {
    edges: SchemaLayoutEdge[];
    /** Bottom of the drawn area including edges. Feeds the layout height and legend position. */
    bottom: number;
}

/**
 * Converts a purely horizontal/vertical polyline into an SVG path with rounded corners. A long
 * edge drops from the source-side gutter into a lane below the tables and comes back up via the
 * target-side gutter, so it has more bends than a regular orthPath.
 */
const roundedOrthogonalPath = (
    points: readonly { x: number; y: number }[],
    corner: number,
): string => {
    const p = (point: { x: number; y: number }): string => `${round1(point.x)},${round1(point.y)}`;
    const first = points[0];
    const last = points[points.length - 1];
    if (first == null || last == null) {
        return "";
    }
    const parts = [`M${p(first)}`];
    for (let i = 1; i < points.length - 1; i += 1) {
        const prev = points[i - 1];
        const current = points[i];
        const next = points[i + 1];
        if (prev == null || current == null || next == null) {
            continue;
        }
        const inDx = Math.sign(current.x - prev.x);
        const inDy = Math.sign(current.y - prev.y);
        const outDx = Math.sign(next.x - current.x);
        const outDy = Math.sign(next.y - current.y);
        const incoming = Math.abs(current.x - prev.x) + Math.abs(current.y - prev.y);
        const outgoing = Math.abs(next.x - current.x) + Math.abs(next.y - current.y);
        const radius = Math.min(corner, incoming / 2, outgoing / 2);
        const before = {
            x: current.x - inDx * radius,
            y: current.y - inDy * radius,
        };
        const after = {
            x: current.x + outDx * radius,
            y: current.y + outDy * radius,
        };
        parts.push(`L${p(before)}`, `Q${p(current)} ${p(after)}`);
    }
    parts.push(`L${p(last)}`);
    return parts.join(" ");
};

/**
 * graph model → deterministic layout. Column bands are decided by the depth (level) of
 * inter-group references: groups that reference no other group (including groups that are only
 * referenced) are level 0; a referencing group is one level deeper than the group it references
 * (= referenced groups land in bands to the left, referencing groups to the right). Reference
 * cycles are cut deterministically by excluding back-edges to an ancestor on the search path
 * from the level computation (see depthLevels).
 * Bands run left → right in ascending level; groups in the same band stack top → bottom in
 * declaration order (a band may hold several groups; independent groups land in the level-0
 * band).
 * Within a group (one group in a band), splitColumns may split the tables, in declaration order,
 * into several internal columns.
 * Edges leave from the fk field's row and enter the target box's header. Routes are bundled:
 * edges that "enter the same target from the same column" share a trunk (vertical line) in the
 * gutter next to that column and an entry point, so they merge into short exit stubs + one trunk
 * + one crossing (the number of lines depends on target × column, not on the reference count).
 * The same input always yields the same coordinates.
 */
export const layoutSchemaGraph = (model: SchemaModel): SchemaLayout => {
    const measured = model.tables.map(measure);
    const indexOf = new Map(model.tables.map((t, i) => [t.name, i]));

    const groupOfTable = new Map<string, number>();
    model.groups.forEach((g, gi) => {
        for (const name of g.tables) {
            groupOfTable.set(name, gi);
        }
    });

    // Set of groups referenced by group gi (edges closed within a group are excluded).
    const refsOf: Set<number>[] = model.groups.map(() => new Set<number>());
    for (const edge of model.edges) {
        const gf = groupOfTable.get(edge.from);
        const gt = groupOfTable.get(edge.to);
        if (gf == null || gt == null || gf === gt) {
            continue;
        }
        refsOf[gf]?.add(gt);
    }

    // level(g) = 0 if it references nothing, otherwise 1 + max(level of referenced groups)
    // (SoT for the rule, including cycle cutting = graph-common.depthLevels).
    const level = depthLevels(refsOf);

    // Bands = ascending level. Within a band, stack top-down in declaration order (single rule:
    // level → band. filter keeps the original order, so the order within a band is deterministic).
    const bandLevels = [...new Set(level)].sort((a, b) => a - b);

    const tables: SchemaLayoutTable[] = [];
    const groups: SchemaLayoutGroup[] = [];
    // Annotate explicitly as `number`: M.margin etc. have literal types from `as const`
    // (non-widening), so without it later assignments (e.g. Math.max results) are rejected.
    let bandX: number = M.margin;
    let bottom: number = M.margin;

    for (const lv of bandLevels) {
        const bandGroups = model.groups.filter((_, gi) => level[gi] === lv);
        let bandWidth = 0;
        let groupTop: number = M.margin;

        for (const group of bandGroups) {
            const indices = group.tables
                .map((name) => indexOf.get(name))
                .filter((i): i is number => i != null);
            if (indices.length === 0) {
                continue;
            }
            const labeled = group.label != null && group.label !== "";
            // Reserve the label area (frameLabelH) per group (contentTop is set per group so a
            // lower stacked group's label doesn't collide with the frame of the group above).
            const contentTop = groupTop + (labeled ? M.frameLabelH : 0);
            const left = bandX + (labeled ? M.framePad : 0);
            let colX = left;
            let groupBottom = contentTop;
            for (const col of splitColumns(indices, measured)) {
                const colW = col.reduce((w, i) => Math.max(w, measured[i]?.w ?? 0), 0);
                let y = contentTop;
                for (const i of col) {
                    const m = measured[i];
                    const table = model.tables[i];
                    if (m == null || table == null) {
                        continue;
                    }
                    tables.push({
                        name: table.name,
                        index: i,
                        x: colX,
                        y,
                        w: m.w,
                        h: m.h,
                        headerH: M.headerH,
                        headerBaseline: y + M.headerH / 2 + M.baselineDrop,
                        radius: M.radius,
                        rows: m.rows.map((r) => ({
                            ...r,
                            y: r.y + y,
                            baseline: r.y + y + M.baselineDrop,
                            x: colX + M.padX,
                            typeX: colX + m.w - M.padX,
                        })),
                    });
                    y += m.h + M.gapY;
                }
                groupBottom = Math.max(groupBottom, y - M.gapY);
                colX += colW + M.gapInnerX;
            }
            const contentW = colX - M.gapInnerX - left;
            let groupTotalBottom: number;
            if (labeled) {
                groups.push({
                    label: group.label ?? "",
                    x: left - M.framePad,
                    y: contentTop - M.framePad,
                    w: contentW + M.framePad * 2,
                    h: groupBottom - contentTop + M.framePad * 2,
                    members: group.tables,
                });
                groupTotalBottom = groupBottom + M.framePad;
            } else {
                groupTotalBottom = groupBottom;
            }
            // Band width = max width of the band's groups (frame pad included). Groups in a band
            // are left-aligned to the band's left edge (bandX), so the occupied width is
            // "(framePad margin if labeled) + contentW + (same)".
            const occupiedW = (labeled ? M.framePad * 2 : 0) + contentW;
            bandWidth = Math.max(bandWidth, occupiedW);
            bottom = Math.max(bottom, groupTotalBottom);
            groupTop = groupTotalBottom + M.gapGroupY;
        }
        bandX += bandWidth + M.gapGroupX;
    }

    const routed = routeSchemaEdgesWithExtent(tables, model.edges);
    const edges = routed.edges;

    const hasList = model.edges.some((e) => e.list);
    const width = Math.max(
        M.minW + M.margin * 2,
        Math.ceil(tables.reduce((w, t) => Math.max(w, t.x + t.w), 0) + M.margin),
    );
    const contentBottom = Math.max(bottom, routed.bottom);
    const legendY = hasList ? contentBottom + M.legendH - 8 : undefined;
    const height = Math.ceil(contentBottom + M.margin + (hasList ? M.legendH : 0));

    return {
        width,
        height,
        groups,
        tables,
        edges,
        ...(legendY == null ? {} : { legendY }),
    };
};

/**
 * Boxes + references → edge routes. A pure function so that layout (at build time) and the
 * client (recomputing after a box drag) share the same routing rules (= one SoT for drawing).
 * Bundling: edges that "enter the same target from the same column" share a trunk (vertical
 * line) in the gutter next to that column and an entry point, merging into short exit stubs +
 * one trunk + one crossing (the number of lines is target × column, not the reference count).
 */
const routeSchemaEdgesWithExtent = (
    boxes: readonly SchemaRouteBox[],
    edges: readonly SchemaEdge[],
): RoutedSchemaEdges => {
    const indexOf = new Map(boxes.map((t) => [t.name, t.index]));
    const byIndex = new Map(boxes.map((t) => [t.index, t]));
    // Right edge of each column (= boxes sharing an x) and the gutters next to columns (vertical
    // free lanes that carry trunks).
    const colRight = new Map<number, number>();
    for (const t of boxes) {
        colRight.set(t.x, Math.max(colRight.get(t.x) ?? 0, t.x + t.w));
    }
    const colXs = [...colRight.keys()].sort((a, b) => a - b);
    const colIndex = new Map(colXs.map((x, i) => [x, i]));
    // gutter = [left, right]. Outside the outermost columns, a virtual gutter `gapInnerX` wide.
    const gutterRight = (colX: number): [number, number] => {
        const right = colRight.get(colX) ?? colX;
        const next = colXs.find((x) => x > colX);
        return [right, next ?? right + M.gapInnerX];
    };
    const gutterLeft = (colX: number): [number, number] => {
        const prevs = colXs.filter((x) => x < colX);
        const prev = prevs[prevs.length - 1];
        return [prev == null ? colX - M.gapInnerX : (colRight.get(prev) ?? colX), colX];
    };
    const mid = ([a, b]: [number, number]): number => (a + b) / 2;
    // Spread of the trunk lanes (kept within the gutter; 0 in a narrow gutter = all overlap).
    const roomOf = ([a, b]: [number, number]): number => Math.max(0, Math.min(12, (b - a) / 2 - 6));

    // 1st pass: decide exit / entry / trunk gutter, and bundle edges that "enter the same target
    // from the same column".
    const routed: Routed[] = [];
    for (const edge of edges) {
        const from = indexOf.get(edge.from);
        const to = indexOf.get(edge.to);
        if (from == null || to == null) {
            continue;
        }
        const s = byIndex.get(from);
        const t = byIndex.get(to);
        if (s == null || t == null) {
            continue;
        }
        const row = s.rows.find((r) => r.fieldIndex === edge.fieldIndex);
        const sy = row?.y ?? s.y + s.headerH / 2;
        // Target to the right = exit right, enter its left edge / to the left = exit left, enter
        // its right edge / same column (incl. self-reference) = detour via the right gutter and
        // enter its right edge.
        const rightward = t.x >= s.x + s.w;
        const sameCol = !rightward && t.x + t.w > s.x;
        const g = rightward || sameCol ? gutterRight(s.x) : gutterLeft(s.x);
        const targetGutter = rightward ? gutterLeft(t.x) : gutterRight(t.x);
        const sourceColumn = colIndex.get(s.x) ?? 0;
        const targetColumn = colIndex.get(t.x) ?? 0;
        routed.push({
            edge,
            from,
            to,
            sx: rightward || sameCol ? s.x + s.w : s.x,
            sy,
            tx: rightward ? t.x : t.x + t.w,
            side: rightward ? "l" : "r",
            bundle: `${to}:${rightward ? "l" : "r"}:${s.x}`,
            base: mid(g),
            room: roomOf(g),
            long: Math.abs(sourceColumn - targetColumn) > 1,
            targetBase: mid(targetGutter),
        });
    }

    // 2nd pass: pick one trunk x and one entry y per bundle (= lines to the same target gather on
    // the trunk, and a long crossing becomes one line per bundle). Bundles sharing a gutter get
    // offset lanes so they don't overlap.
    const bundles = new Map<string, Routed[]>();
    for (const r of routed) {
        const bucket = bundles.get(r.bundle);
        if (bucket) {
            bucket.push(r);
        } else {
            bundles.set(r.bundle, [r]);
        }
    }
    const trunkX = new Map<string, number>();
    const laneGroups = new Map<string, string[]>();
    for (const [key, bucket] of bundles) {
        const first = bucket[0];
        if (first == null) {
            continue;
        }
        const laneKey = `${Math.round(first.base)}`;
        const group = laneGroups.get(laneKey);
        if (group) {
            group.push(key);
        } else {
            laneGroups.set(laneKey, [key]);
        }
    }
    for (const group of laneGroups.values()) {
        group.forEach((key, k) => {
            const first = bundles.get(key)?.[0];
            if (first == null) {
                return;
            }
            const step =
                group.length <= 1
                    ? 0
                    : Math.min(M.lane, (first.room * 2) / (group.length - 1) || 0);
            trunkX.set(key, first.base + (k - (group.length - 1) / 2) * step);
        });
    }
    // Entry y = center of the target box's header. Fan out slightly only when several bundles
    // enter the same side.
    const entryY = new Map<string, number>();
    const sides = new Map<string, string[]>();
    for (const [key, bucket] of bundles) {
        const first = bucket[0];
        if (first == null) {
            continue;
        }
        const sideKey = `${first.to}:${first.side}`;
        const group = sides.get(sideKey);
        if (group) {
            group.push(key);
        } else {
            sides.set(sideKey, [key]);
        }
    }
    for (const group of sides.values()) {
        group.forEach((key, k) => {
            const first = bundles.get(key)?.[0];
            const t = first == null ? undefined : byIndex.get(first.to);
            if (t == null) {
                return;
            }
            const step = Math.min(6, (t.h - M.headerH) / Math.max(1, group.length));
            entryY.set(key, t.y + t.headerH / 2 + (k - (group.length - 1) / 2) * step);
        });
    }

    // Edges with another table column in between are diverted, per bundle, below the bottom of
    // the graph so their horizontal lines don't cross those tables. A bundle also shares its lane,
    // so the height doesn't grow in proportion to the number of lines.
    const tableBottom = boxes.reduce((value, box) => Math.max(value, box.y + box.h), 0);
    const longLaneY = new Map<string, number>();
    const longBundles = [...bundles.entries()].filter(([, bucket]) => bucket[0]?.long === true);
    longBundles.forEach(([key], i) => {
        longLaneY.set(key, tableBottom + M.gapY + i * M.lane);
    });
    const edgeBottom =
        longBundles.length === 0
            ? tableBottom
            : tableBottom + M.gapY + (longBundles.length - 1) * M.lane;

    return {
        edges: routed.map((r) => {
            const sourceTrunk = trunkX.get(r.bundle) ?? r.base;
            const targetY = entryY.get(r.bundle) ?? r.sy;
            const laneY = longLaneY.get(r.bundle);
            return {
                from: r.from,
                to: r.to,
                fieldIndex: r.edge.fieldIndex,
                list: r.edge.list,
                d:
                    laneY == null
                        ? orthPath(r.sx, r.sy, sourceTrunk, targetY, r.tx, M.corner)
                        : roundedOrthogonalPath(
                              [
                                  { x: r.sx, y: r.sy },
                                  { x: sourceTrunk, y: r.sy },
                                  { x: sourceTrunk, y: laneY },
                                  { x: r.targetBase, y: laneY },
                                  { x: r.targetBase, y: targetY },
                                  { x: r.tx, y: targetY },
                              ],
                              M.corner,
                          ),
            };
        }),
        bottom: edgeBottom,
    };
};

export const routeSchemaEdges = (
    boxes: readonly SchemaRouteBox[],
    edges: readonly SchemaEdge[],
): SchemaLayoutEdge[] => routeSchemaEdgesWithExtent(boxes, edges).edges;

/** layout → interactive-UI data (payload embedded in the static SVG; same positions / content). */
export const schemaGraphClientData = (
    uid: string,
    model: SchemaModel,
    layout: SchemaLayout,
    source?: string,
): SchemaGraphClientData => ({
    uid,
    width: layout.width,
    height: layout.height,
    nodes: layout.tables.map((t) => ({
        name: t.name,
        index: t.index,
        x: t.x,
        y: t.y,
        w: t.w,
        h: t.h,
        headerH: t.headerH,
        rows: t.rows.map((r) => ({
            kind: r.kind,
            label: r.name,
            type: r.type,
            dy: round1(r.y - t.y),
            ...(r.fieldIndex == null ? {} : { fieldIndex: r.fieldIndex }),
        })),
    })),
    edges: model.edges,
    groups: layout.groups.map((g) => ({
        label: g.label,
        x: g.x,
        y: g.y,
        w: g.w,
        h: g.h,
        members: g.members,
    })),
    ...(source == null || source === "" ? {} : { source }),
});
