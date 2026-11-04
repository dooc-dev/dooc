import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { expect, it } from "vitest";
import { editorCodeBlocks } from "./edit-code-highlight.js";

it("collects fenced languages without coloring prose or losing empty lines", () => {
    const doc = "# Heading\n\n```rust\nfn main() {\n\n\n}\n```\n\nAfter\n\n~~~unknown\na\n~~~";
    const state = EditorState.create({ doc, extensions: markdown() });
    const blocks = editorCodeBlocks(state);
    expect(blocks.map(({ language, source }) => ({ language, source }))).toEqual([
        { language: "rust", source: "fn main() {\n\n\n}" },
        { language: "unknown", source: "a" },
    ]);
    for (const block of blocks)
        expect(block.chunks.map(({ from, to }) => doc.slice(from, to)).join("")).toBe(block.source);
});

it("keeps original offsets through quoted and list-nested code, and handles a full file", () => {
    const doc = "> ```js\n> let x = 1;\n>\n> x();\n> ```\n\n- ```rust\n  fn main() {}\n  ```";
    const blocks = editorCodeBlocks(EditorState.create({ doc, extensions: markdown() }));
    expect(blocks.map((block) => block.source)).toEqual(["let x = 1;\n\nx();", "fn main() {}"]);
    expect(blocks[0]?.chunks[0]?.from).toBe(doc.indexOf("let"));
    const file = EditorState.create({ doc: "// 🦀\n\nfn main() {}\n" });
    expect(editorCodeBlocks(file, "rs")).toEqual([
        { language: "rs", source: file.doc.toString(), chunks: [{ from: 0, to: file.doc.length }] },
    ]);
});
