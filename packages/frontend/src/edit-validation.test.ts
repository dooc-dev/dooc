import { markdown } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { isEditingCodeBlock } from "./edit-validation.js";

const stateAt = (doc: string, anchor: number): EditorState =>
    EditorState.create({ doc, selection: { anchor }, extensions: [markdown()] });

describe("automatic validation while editing code", () => {
    it.each([
        "```typescript\nx()\n```",
        "~~~js\nx()\n~~~",
    ])("waits throughout the fence, including the language and closing line: %s", (block) => {
        const doc = `Before\n\n${block}\n\nAfter`;
        for (let position = 8; position <= 8 + block.length; position++) {
            expect(
                isEditingCodeBlock({ state: stateAt(doc, position), hasFocus: true }),
                String(position),
            ).toBe(true);
        }
        for (const position of [0, 7, 9 + block.length, doc.length]) {
            expect(isEditingCodeBlock({ state: stateAt(doc, position), hasFocus: true })).toBe(
                false,
            );
        }
    });

    it.each([
        "```js",
        "```js\nx(\n",
        "> ```js\n> x(",
        "- item\n\n  ```js\n  x(\n",
        "    x()",
    ])("waits in incomplete, nested, or indented blocks: %s", (doc) => {
        expect(isEditingCodeBlock({ state: stateAt(doc, doc.length), hasFocus: true })).toBe(true);
    });

    it("allows validation after moving outside or leaving the editor, and pauses on reentry", () => {
        const doc = "```js\nx()\n```\n\nAfter";
        let state = stateAt(doc, 8);
        expect(isEditingCodeBlock({ state, hasFocus: true })).toBe(true);
        expect(isEditingCodeBlock({ state, hasFocus: false })).toBe(false);
        state = state.update({ selection: { anchor: doc.length } }).state;
        expect(isEditingCodeBlock({ state, hasFocus: true })).toBe(false);
        state = state.update({ selection: { anchor: 8 } }).state;
        expect(isEditingCodeBlock({ state, hasFocus: true })).toBe(true);
    });

    it("protects selections spanning code and secondary cursors in code", () => {
        const doc = "Before\n\n```js\nx()\n```\n\nAfter";
        for (const selection of [
            EditorSelection.create([EditorSelection.range(0, doc.length)]),
            EditorSelection.create([
                EditorSelection.cursor(0),
                EditorSelection.cursor(doc.indexOf("x()")),
            ]),
        ]) {
            const state = EditorState.create({
                doc,
                selection,
                extensions: [markdown(), EditorState.allowMultipleSelections.of(true)],
            });
            expect(isEditingCodeBlock({ state, hasFocus: true })).toBe(true);
        }
    });

    it("leaves prose and inline-code validation unchanged", () => {
        const doc = "Text with `code`";
        expect(
            isEditingCodeBlock({ state: stateAt(doc, doc.indexOf("code")), hasFocus: true }),
        ).toBe(false);
    });
});
