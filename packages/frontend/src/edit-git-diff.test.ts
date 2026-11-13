import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { gitBaseState, gitDiffState, setGitBase } from "./edit-git-diff.js";

const create = (base: string | null, doc: string) =>
    EditorState.create({ doc, extensions: [gitBaseState.init(() => base), gitDiffState] });
const marks = (state: EditorState) => {
    const result: [number, string][] = [];
    state.field(gitDiffState).between(0, state.doc.length, (from, _to, value) => {
        result.push([state.doc.lineAt(from).number, value.elementClass]);
    });
    return result;
};

describe("Git editor lines", () => {
    it("marks insertions and replacements without marking unchanged lines", () => {
        expect(marks(create("a\nb\nc\n", "new\na\nchanged\nc\n"))).toEqual([
            [1, "cm-git-added"],
            [3, "cm-git-modified"],
        ]);
        expect(marks(create(null, "new\n"))).toEqual([]);
        expect(marks(create("a\r\nb\r\n", "a\nb\n"))).toEqual([]);
        expect(marks(create("", "a\n\nb\n"))).toHaveLength(3);
    });
    it("marks deletion boundaries, including an empty document", () => {
        expect(marks(create("a\nb", "b"))).toEqual([[1, "cm-git-deleted-start"]]);
        expect(marks(create("a\nb", "a\n"))).toEqual([[2, "cm-git-deleted-start"]]);
        expect(marks(create("a", ""))).toEqual([[1, "cm-git-deleted-start"]]);
    });
    it("recomputes on editing, undoing and refreshing HEAD", () => {
        const initial = create("a\n", "a\n");
        const edited = initial.update({ changes: { from: 0, to: 1, insert: "b" } }).state;
        expect(marks(edited)).toEqual([[1, "cm-git-modified"]]);
        expect(marks(edited.update({ changes: { from: 0, to: 1, insert: "a" } }).state)).toEqual(
            [],
        );
        expect(marks(edited.update({ effects: setGitBase.of("b\n") }).state)).toEqual([]);
        expect(marks(edited.update({ effects: setGitBase.of(null) }).state)).toEqual([]);
    });
    it("adds background decorations at line starts without changing the document", () => {
        const state = create("a\nb\n", "a\nc\nextra\n");
        const classes: string[] = [];
        for (const decorations of state.facet(EditorView.decorations)) {
            if (typeof decorations === "function") continue;
            decorations.between(0, state.doc.length, (from, _to, value) => {
                expect(from).toBe(state.doc.lineAt(from).from);
                classes.push(value.spec.class);
            });
        }
        expect(classes).toEqual(["cm-git-modified", "cm-git-modified"]);
        expect(state.doc.toString()).toBe("a\nc\nextra\n");
    });
});
