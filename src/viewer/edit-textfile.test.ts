import { EditorState } from "@codemirror/state";
import { expect, it } from "vitest";
import { createTextfileEditors, textfileLines } from "./edit-textfile.js";

it("adds editors only to actual single-line references, preserving spaces and ignoring code/DSL examples", () => {
    const source = [
        ":::textfile(./examples/hello.rs)[1:5,7:3]",
        ':::textfile(examples/日本語 & example.rs)["a,b", *]',
        "```md",
        ":::textfile(hidden.rs)",
        "```",
        ":::schema",
        ":::textfile(hidden.rs)",
        ":::",
        ":::textfile()",
        "Prose :::textfile(hidden.rs)",
        "    :::textfile(hidden.rs)",
    ].join("\n");
    expect(textfileLines(source)).toEqual([
        { line: 1, file: "examples/hello.rs" },
        { line: 2, file: "examples/日本語 & example.rs" },
    ]);
    const editors = createTextfileEditors(
        [],
        () => {},
        () => {},
    );
    const state = EditorState.create({ doc: source, extensions: editors.extension });
    expect(state.field(editors.extension).size).toBe(4);
    const updated = state.update({ changes: { from: 0, to: state.doc.line(1).to + 1 } }).state;
    expect(updated.field(editors.extension).size).toBe(2);
    expect(editors.hasUnsavedChanges()).toBe(false);
});
