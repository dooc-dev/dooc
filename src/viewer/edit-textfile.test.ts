import { EditorState } from "@codemirror/state";
import { expect, it } from "vitest";
import { createTextfileEditors, fileValidationState, textfileLines } from "./edit-textfile.js";

it("only reports validation success when preview generation has also succeeded", () => {
    expect(fileValidationState("valid", { state: "error", message: "Invalid range" })).toBe(
        "error",
    );
    expect(fileValidationState("valid", { state: "loading" })).toBe("checking");
    expect(fileValidationState("valid", { state: "pending" })).toBe("pending");
    expect(fileValidationState("error", { state: "valid" })).toBe("error");
    expect(fileValidationState("pending", { state: "valid" })).toBe("pending");
    expect(fileValidationState("valid", { state: "valid" })).toBe("valid");
    expect(fileValidationState("valid")).toBe("valid");
});

it("adds editors only to actual single-line references, preserving spaces and ignoring code/DSL examples", () => {
    const source = [
        "![](./examples/hello.rs#L1-L7)",
        "![](<examples/日本語 & example.rs#L2>)",
        "```md",
        "![](hidden.rs)",
        "```",
        "~~~schemath",
        "![](hidden.rs)",
        "~~~",
        "![]()",
        "Prose ![](hidden.rs)",
        "    ![](hidden.rs)",
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
