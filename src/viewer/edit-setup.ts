import {
    autocompletion,
    closeBrackets,
    closeBracketsKeymap,
    completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
    bracketMatching,
    codeFolding,
    defaultHighlightStyle,
    foldKeymap,
    indentOnInput,
    syntaxHighlighting,
} from "@codemirror/language";
import { lintKeymap } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import {
    crosshairCursor,
    drawSelection,
    dropCursor,
    highlightActiveLine,
    highlightActiveLineGutter,
    highlightSpecialChars,
    keymap,
    lineNumbers,
    rectangularSelection,
} from "@codemirror/view";
import { foldPlaceholder } from "./edit-fold.js";

// CodeMirror's basic setup, with inline folding controls instead of a fold gutter.
export const editorSetup: Extension = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history({ minDepth: 10_000 }),
    codeFolding({ placeholderDOM: foldPlaceholder }),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        ...lintKeymap,
    ]),
];
