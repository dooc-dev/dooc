import { isolateHistory, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { EditorState, StateField, type Transaction } from "@codemirror/state";
import { expect, it } from "vitest";
import { editorHistory, HISTORY_MAX_BYTES } from "./edit-history.js";
import { editorSetup } from "./edit-setup.js";

it("retains 10,000 separate edits for undo and redo", () => {
    const editor = {
        state: EditorState.create({ extensions: editorSetup }),
        dispatch: (transaction: Transaction) => {
            editor.state = transaction.state;
        },
    };
    for (let i = 0; i < 10_000; i++) {
        editor.dispatch(
            editor.state.update({
                changes: { from: editor.state.doc.length, insert: "x" },
                annotations: isolateHistory.of("full"),
            }),
        );
    }
    expect(undoDepth(editor.state)).toBe(10_000);
    for (let i = 0; i < 10_000; i++) expect(undo(editor)).toBe(true);
    expect(editor.state.doc.toString()).toBe("");
    expect(undo(editor)).toBe(false);
    expect(redoDepth(editor.state)).toBe(10_000);
    for (let i = 0; i < 10_000; i++) expect(redo(editor)).toBe(true);
    expect(editor.state.doc.toString()).toBe("x".repeat(10_000));
    expect(redo(editor)).toBe(false);
});

it("resets old history at the size limit while preserving the latest edit and other state", () => {
    const marker = StateField.define({ create: () => "kept", update: (value) => value });
    const editor = {
        state: EditorState.create({ extensions: [editorHistory, marker] }),
        dispatch: (transaction: Transaction) => {
            editor.state = transaction.state;
        },
    };
    const text = "あ".repeat(HISTORY_MAX_BYTES / 8);
    for (let cycle = 0; cycle < 2; cycle++) {
        for (let i = 0; i < 4; i++) {
            editor.dispatch(
                editor.state.update({
                    changes: { from: 0, to: editor.state.doc.length, insert: i % 2 ? "" : text },
                    annotations: isolateHistory.of("full"),
                    selection: { anchor: 0 },
                }),
            );
        }
        expect(undoDepth(editor.state)).toBe(cycle + 1);
        expect(editor.state.doc.length).toBe(0);
        expect(editor.state.selection.main.head).toBe(0);
        expect(editor.state.field(marker)).toBe("kept");
        expect(undo(editor)).toBe(true);
        expect(editor.state.doc.toString()).toBe(text);
        expect(redo(editor)).toBe(true);
        expect(editor.state.doc.length).toBe(0);
    }
});

it.each([
    "insert",
    "delete",
])("applies an oversized %s without retaining it in history", (action) => {
    const text = "あ".repeat(HISTORY_MAX_BYTES / 2);
    const editor = {
        state: EditorState.create({
            doc: action === "delete" ? text : "",
            extensions: editorHistory,
        }),
        dispatch: (transaction: Transaction) => {
            editor.state = transaction.state;
        },
    };
    editor.dispatch(editor.state.update({ changes: { from: 0, insert: "small" } }));
    editor.dispatch(
        editor.state.update({
            changes: { from: 0, insert: "other" },
            annotations: isolateHistory.of("full"),
        }),
    );
    expect(undo(editor)).toBe(true);
    expect(undoDepth(editor.state)).toBe(1);
    expect(redoDepth(editor.state)).toBe(1);
    editor.dispatch(
        editor.state.update({
            changes: {
                from: 0,
                to: editor.state.doc.length,
                insert: action === "insert" ? text : "",
            },
        }),
    );
    expect(editor.state.doc.length).toBe(action === "insert" ? text.length : 0);
    expect(undo(editor)).toBe(false);
    expect(redo(editor)).toBe(false);
    editor.dispatch(editor.state.update({ changes: { from: 0, insert: "new" } }));
    expect(undo(editor)).toBe(true);
    expect(editor.state.doc.length).toBe(action === "insert" ? text.length : 0);
    expect(redo(editor)).toBe(true);
    expect(editor.state.doc.sliceString(0, 3)).toBe("new");
});
