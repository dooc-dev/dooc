import { markdown } from "@codemirror/lang-markdown";
import { foldable, foldEffect } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { inlineFoldMarkers } from "./edit-fold.js";
import { editorSetup } from "./edit-setup.js";

const buttons = (state: EditorState) => {
    const result: number[] = [];
    inlineFoldMarkers({ state, visibleRanges: [{ from: 0, to: state.doc.length }] }).between(
        0,
        state.doc.length,
        (from) => {
            result.push(from);
        },
    );
    return result;
};

describe("inline fold buttons", () => {
    it("places controls at heading and fence line ends and updates on folding", () => {
        let state = EditorState.create({
            doc: "## Heading\n\nParagraph\n\n```js\nx()\n```\n",
            extensions: [markdown(), editorSetup],
        });
        expect(buttons(state)).toEqual([state.doc.line(1).to, state.doc.line(5).to]);
        const range = foldable(state, 0, state.doc.line(1).to);
        if (!range) throw new Error("Expected heading fold range");
        state = state.update({ effects: foldEffect.of(range) }).state;
        expect(buttons(state)).not.toContain(state.doc.line(1).to);
    });
    it("does not add controls to plain paragraphs", () => {
        const state = EditorState.create({
            doc: "Plain paragraph",
            extensions: [markdown(), editorSetup],
        });
        expect(buttons(state)).toEqual([]);
    });
});
