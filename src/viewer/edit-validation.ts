import { ensureSyntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";

export const CODE_BLOCK_NODE_NAMES = new Set(["FencedCode", "CodeBlock"]);

export const isEditingCodeBlock = ({
    state,
    hasFocus,
}: Pick<EditorView, "state" | "hasFocus">): boolean => {
    if (!hasFocus) return false;
    const tree = ensureSyntaxTree(state, Math.max(...state.selection.ranges.map((r) => r.to)), 50);
    // Wait for parsing rather than formatting an editor region whose syntax is still unknown.
    if (!tree) return true;
    return state.selection.ranges.some((range) => {
        let inside = false;
        tree.iterate({
            from: range.from,
            to: range.to,
            enter(node) {
                if (CODE_BLOCK_NODE_NAMES.has(node.name)) {
                    inside = true;
                    return false;
                }
            },
        });
        return inside;
    });
};
