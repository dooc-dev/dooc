import { expect, it } from "vitest";
import { codeFoldRanges } from "./code-fold.js";

it("folds JSON objects and arrays without treating quoted brackets as structure", () => {
    const source = [
        "{",
        '  "text": "not a } or [",',
        '  "items": [',
        "    {",
        '      "name": "first"',
        "    }",
        "  ]",
        "}",
    ].join("\n");
    expect([...codeFoldRanges(source, "json")]).toEqual([
        [0, 7],
        [2, 6],
        [3, 5],
    ]);
    expect(codeFoldRanges('{"a": [1,2]}', "json").size).toBe(0);
});

it.each([
    "yaml",
    "yml",
])("folds %s mappings, sequence items and block text at their own boundaries", (language) => {
    const source = [
        "service:",
        "  name: api",
        "  ports:",
        "    - 80",
        "    - 443",
        "items:",
        "  - name: first",
        "    enabled: true",
        "  - name: second",
        "    enabled: false",
        "notes: |",
        "  service:",
        "    still text",
        "last: value",
        "",
    ].join("\n");
    expect([...codeFoldRanges(source, language)]).toEqual([
        [0, 4],
        [2, 4],
        [5, 9],
        [6, 7],
        [8, 9],
        [10, 12],
    ]);
});

it("folds TOML sections, arrays and multiline strings without phantom sections", () => {
    const source = [
        "title = 'Example'",
        "[server]",
        "ports = [",
        "  80,",
        "  443",
        "]",
        'notes = """',
        "[not.a.section]",
        '"""',
        "",
        "[[clients]]",
        "name = 'first'",
        "[[clients]] # next item",
        "name = 'second'",
        "",
    ].join("\n");
    expect([...codeFoldRanges(source, "toml")]).toEqual([
        [2, 5],
        [6, 8],
        [1, 8],
        [10, 11],
        [12, 13],
    ]);
});

it("keeps malformed JSON, unrelated languages and large files readable without folds", () => {
    expect(codeFoldRanges('{"broken": [', "json").size).toBe(0);
    expect(codeFoldRanges("function f() {\n return 1;\n}", "javascript").size).toBe(0);
    expect(codeFoldRanges("a".repeat(100_001), "yaml").size).toBe(0);
});

it("keeps sibling properties visible when they share a collection's closing line", () => {
    const source = '{\n  "items": [\n    1,\n    2\n  ], "other": true\n}';
    expect(codeFoldRanges(source, "json").get(1)).toBe(3);
});
