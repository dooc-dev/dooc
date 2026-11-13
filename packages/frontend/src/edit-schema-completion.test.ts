import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { schemaCompletion } from "./edit-schema-completion.js";

const complete = (source: string) => {
    const pos = source.indexOf("¦");
    const state = EditorState.create({ doc: source.replace("¦", "") });
    return schemaCompletion(new CompletionContext(state, pos, false));
};

describe("schemaCompletion", () => {
    it("does not offer completions within line or block comments", () => {
        for (const body of [
            "  // refs: ¦",
            "  id: pk // refs: ¦",
            "  /* comment\n  refs: fk(¦)\n  */",
            "  /* unfinished\n  refs: ¦",
        ])
            expect(complete(`~~~schemath\na:\n${body}`)).toBeNull();
    });

    it("excludes commented declarations and supports comments after real declarations", () => {
        const result = complete(
            "~~~schemath\na: // table\n  refs: fk(/* target */ ¦)\n/*\nhidden:\n*/\n// ignored:\nb: /* table */\n  id: pk\n~~~",
        );
        expect(result?.options.map((o) => o.label)).toEqual(["a", "b"]);
    });

    it("offers self and forward references only from the current schema", () => {
        const result = complete(
            `~~~schemath\nother:\n~~~\n~~~schemath\nsample_items:\n  refs: fk[](¦)\n  unfinished:\nsample_tags:\n~~~\n~~~schemath\nelsewhere:\n~~~`,
        );
        expect(result?.options.map((o) => o.label)).toEqual(["sample_items", "sample_tags"]);
    });

    it("replaces the whole target at the cursor and supports union references", () => {
        const source = "~~~schemath\na:\n  refs: fk(a | mo¦dule)\nmodule:\n~~~";
        const result = complete(source);
        expect(result?.from).toBe(source.indexOf("mo¦"));
        expect(result?.to).toBe(source.indexOf(")") - 1);
        expect(result?.options.map((o) => o.label)).toEqual(["a", "module"]);
    });

    it("offers schema types even with incomplete syntax and an unclosed container", () => {
        const result = complete("~~~schemath\na:\n  refs: ¦");
        expect(result?.options.map((o) => o.label)).toEqual([
            "pk",
            "string",
            "number",
            "bool",
            "json",
            "timestamp",
            "fk",
            "fk[]",
            "enum",
        ]);
    });

    it("supports a commonly indented schema and deduplicates declarations", () => {
        const result = complete("  ~~~schemath\n  a:\n    refs: fk(¦)\n  a:\n  b:\n  ~~~");
        expect(result?.options.map((o) => o.label)).toEqual(["a", "b"]);
    });

    it("does not suggest in headings, notes, enum values or closing markers", () => {
        for (const line of ["### ¦", "  note¦", '  kind: enum("¦")', "~~~¦"]) {
            expect(complete(`~~~schemath\na:\n${line}`)).toBeNull();
        }
    });

    it("does not treat Markdown examples or other directives as schema", () => {
        for (const source of [
            "a:\n  refs: fk(¦)",
            "```md\n~~~schemath\na:\n  refs: fk(¦)\n```",
            "~~~md\n~~~schemath\na:\n  refs: fk(¦)\n~~~",
            "~~~schemath\na:\n~~~\n  refs: fk(¦)",
            "~~~graph\na:\n  refs: fk(¦)",
        ])
            expect(complete(source)).toBeUndefined();
    });
});
