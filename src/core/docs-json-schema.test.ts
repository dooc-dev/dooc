import { readdirSync } from "node:fs";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { compileSite } from "../compiler/compile.js";
import type { ArtifactDoc, DocsArtifact } from "./artifact-types.js";
import type { Block } from "./blocks.js";
import {
    getDocsJsonSchema,
    listDocsJsonSchemas,
    validateDocsArtifact,
} from "./docs-json-schema.js";
import { canRenderGeneration, GENERATION } from "./generation.js";
import { parseGraphSource } from "./graph.js";
import { parseSchemaSource } from "./schema-graph.js";

const blocks: Record<Block["type"], Block> = {
    p: { type: "p", text: "Text with `code` and [links](doc:guide)." },
    h: { type: "h", level: 3, text: "Heading", slug: "heading" },
    list: {
        type: "list",
        ordered: true,
        items: [
            "Leaf",
            { text: "Parent", ordered: false, children: [{ text: "Nested", children: ["Leaf"] }] },
        ],
    },
    code: {
        type: "code",
        lines: ["custom code"],
        lang: "custom-language",
        filename: "examples/sample.tdl",
        range: "#L1-L3",
        unavailable: "missing",
    },
    table: { type: "table", headers: ["A"], rows: [["B"]], caption: "Table", collapsible: true },
    callout: {
        type: "callout",
        title: "Note",
        body: [
            { type: "p", text: "Text" },
            { type: "list", items: ["Item"], ordered: true },
        ],
    },
    figureRef: { type: "figureRef", name: "figure-one", caption: "Figure" },
    term: {
        type: "term",
        entry: { id: "term-id", name: "Term", description: "Brief", definition: "Definition" },
    },
    figures: { type: "figures" },
    schemaGraph: {
        type: "schemaGraph",
        caption: "Schema",
        source: "teams:\n  id: pk\nusers:\n  id: pk\n  team_id: fk(teams)\n  name: string\n  unique(name)\n",
        graph: parseSchemaSource(
            "teams:\n  id: pk\nusers:\n  id: pk\n  team_id: fk(teams)\n  name: string\n  unique(name)\n",
        ).model,
    },
    graph: {
        type: "graph",
        caption: "Graph",
        source: "[a]: A @region\n[b]: B\n[a] --> [b]: Label\n",
        graph: parseGraphSource("[a]: A @region\n[b]: B\n[a] --> [b]: Label\n").model,
    },
};

const doc = (): ArtifactDoc => ({
    id: "guide",
    file: "content/guide.md",
    title: "Guide",
    lang: "ja-JP",
    icon: "<svg></svg>",
    body: "Source",
    blocks: structuredClone(Object.values(blocks)),
    toc: [{ depth: 3, text: "Heading", slug: "heading" }],
    refs: { figures: ["figure-one"], terms: ["term-id"] },
});

const artifact = (docs: unknown[] = [doc()]): unknown => ({
    generation: GENERATION,
    docs,
    terms: [{ id: "term-id", name: "Term", definition: "Definition" }],
    figures: [
        {
            name: "figure-one",
            file: "figures/figure-one.svg",
            kind: "svg",
            title: "Figure",
            desc: "Description",
        },
    ],
});

describe("docs.json schema registry", () => {
    it("keeps generation 10 validation available without claiming renderer compatibility", () => {
        expect(
            validateDocsArtifact({ generation: 10, docs: [], dictionary: [], figures: [] }),
        ).toEqual([]);
        expect(canRenderGeneration(11, 10)).toBe(false);
        expect(canRenderGeneration(10, 11)).toBe(false);
        expect(canRenderGeneration(11, 11)).toBe(true);
        expect(canRenderGeneration(17, 16)).toBe(false);
        expect(canRenderGeneration(16, 17)).toBe(false);
        expect(canRenderGeneration(18, 17)).toBe(true);
    });
    it("registers every versioned file, pins latest to GENERATION and rejects unknown versions", () => {
        const versions = listDocsJsonSchemas();
        expect(versions).toEqual(
            readdirSync(new URL("./docs-json-schema/", import.meta.url))
                .map((file) => Number(file.replace(/\.json$/, "")))
                .sort((a, b) => a - b),
        );
        expect(versions.at(-1)).toBe(GENERATION);
        expect(getDocsJsonSchema()).toEqual(getDocsJsonSchema(GENERATION));
        for (const version of ["nope", "../10", "toString", "010", 999]) {
            expect(() => getDocsJsonSchema(version)).toThrow("Unknown docs.json schema version");
        }
    });

    it("is independently usable by a standard validator, including separate figure payloads", () => {
        const ajv = new Ajv({ strict: true });
        for (const version of listDocsJsonSchemas()) {
            const schema = getDocsJsonSchema(version);
            ajv.addSchema(schema);
            expect(
                ajv.getSchema(schema.$id)?.({
                    generation: version,
                    docs: [],
                    ...(version === 10 ? { dictionary: [] } : { terms: [] }),
                    figures: [],
                }),
            ).toBe(true);
            const figure = ajv.compile({ $ref: `${schema.$id}#/definitions/FigureEntry` });
            expect(
                figure({ name: "a", file: "figures/a.svg", kind: "svg", markup: "<svg/>" }),
            ).toBe(true);
            expect(figure({ name: "a", file: "figures/a.svg", kind: "svg" })).toBe(false);
        }
    });
});

describe("validateDocsArtifact", () => {
    it("validates new embed labels and line fragments while preserving the released range format", () => {
        const current = { ...blocks.code, alt: "Example", range: "#L1-L3" };
        expect(validateDocsArtifact(artifact([{ ...doc(), blocks: [current] }]))).toEqual([]);
        expect(
            validateDocsArtifact(artifact([{ ...doc(), blocks: [{ ...current, range: "[1,3]" }] }]))
                .length,
        ).toBeGreaterThan(0);
        expect(
            validateDocsArtifact({
                generation: 14,
                docs: [{ ...doc(), blocks: [{ ...blocks.code, range: "[1,3]" }] }],
                terms: [],
                figures: [],
            }),
        ).toEqual([]);
    });
    it("rejects document descriptions in the current format while retaining released schemas", () => {
        const legacyDoc = { ...doc(), description: "Legacy description" };
        expect(validateDocsArtifact(artifact([legacyDoc])).join()).toContain("docs.json/docs/0");
        expect(
            validateDocsArtifact({ generation: 13, docs: [legacyDoc], terms: [], figures: [] }),
        ).toEqual([]);
    });

    it("accepts a site icon and rejects document tags in the current format", () => {
        const value = {
            generation: GENERATION,
            docs: [doc()],
            terms: [],
            figures: [],
            icon: '<svg viewBox="0 0 10 10"/>',
        };
        expect(validateDocsArtifact(value)).toEqual([]);
        expect(
            validateDocsArtifact({ ...value, docs: [{ ...doc(), tags: ["obsolete"] }] }).join(),
        ).toContain("additional properties");
    });
    it("accepts all block variants and nested structures without changing data", () => {
        const value = artifact([
            doc(),
            { ...doc(), id: "child", parent: "guide", file: "content/child.md" },
        ]);
        const before = structuredClone(value);
        expect(validateDocsArtifact(value)).toEqual([]);
        expect(value).toEqual(before);
        const minimal: DocsArtifact = {
            generation: GENERATION,
            docs: [],
            terms: [],
            figures: [],
        };
        expect(validateDocsArtifact(minimal)).toEqual([]);
    });

    it("accepts serialized compiler output and every separate sample figure", () => {
        const compiled = compileSite(new URL("../../sample-content", import.meta.url).pathname);
        expect(compiled.errors).toEqual([]);
        expect(validateDocsArtifact(JSON.parse(JSON.stringify(compiled.artifact)))).toEqual([]);
        const schema = getDocsJsonSchema();
        const figure = new Ajv()
            .addSchema(schema)
            .compile({ $ref: `${schema.$id}#/definitions/FigureEntry` });
        for (const entry of compiled.figures) expect(figure(entry)).toBe(true);
    });

    it.each([
        null,
        [],
        {},
        { generation: "10" },
        { generation: 10.5 },
        { generation: 999 },
        { generation: { toString: null } },
    ])("rejects missing, malformed or unsupported generations: %j", (value) => {
        expect(validateDocsArtifact(value).join()).toContain("docs.json/generation");
    });

    it.each([
        { type: "unknown" },
        { type: "p", text: 1 },
        { type: "p", text: "Text", typo: true },
        { type: "h", level: 4, text: "Text", slug: "heading" },
        { type: "list", items: [{ text: "Parent", children: [1] }] },
        { type: "list", items: [], ordered: "true" },
        { type: "code", lines: [1] },
        { type: "code", lines: [], unavailable: true },
        { type: "table", headers: [], rows: [[1]] },
        { type: "callout", body: [{ type: "code", lines: [] }] },
        { type: "figureRef" },
        { type: "term", entry: { id: "term-id", name: "Term" } },
        {
            type: "schemaGraph",
            graph: { groups: [], tables: [{ name: "a", fields: [], notes: [1] }], edges: [] },
        },
        {
            type: "schemaGraph",
            graph: {
                groups: [],
                tables: [],
                edges: [{ from: "a", fieldIndex: -1, field: "id", to: "b", list: false }],
            },
        },
        {
            type: "graph",
            graph: { nodes: [], edges: [{ from: "a", to: "b", kind: "wrong" }], regions: [] },
        },
    ])("rejects invalid nested blocks: %j", (block) => {
        expect(validateDocsArtifact(artifact([{ ...doc(), blocks: [block] }])).join()).toContain(
            "docs.json/docs/0/blocks/0",
        );
    });

    it("rejects missing fields, malformed metadata and figure markup in the index", () => {
        const { title: _title, ...missingTitle } = doc();
        for (const value of [
            { generation: GENERATION },
            artifact([missingTitle]),
            artifact([{ ...doc(), lang: 1 }]),
            artifact([{ ...doc(), toc: [{ depth: 4, text: "Text", slug: "heading" }] }]),
            artifact([{ ...doc(), refs: { figures: [1] } }]),
            {
                generation: GENERATION,
                docs: [],
                terms: [{ term: "Term", definition: 1 }],
                figures: [],
            },
            {
                generation: GENERATION,
                docs: [],
                terms: [],
                figures: [{ name: "a", file: "figures/a.svg", kind: "svg", markup: "<svg/>" }],
            },
        ])
            expect(validateDocsArtifact(value).length).toBeGreaterThan(0);
    });
});
