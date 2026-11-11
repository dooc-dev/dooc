import {
    autocompletion,
    closeBrackets,
    closeBracketsKeymap,
    completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, historyKeymap, redo, undo } from "@codemirror/commands";
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
    EditorView,
    highlightActiveLine,
    highlightActiveLineGutter,
    highlightSpecialChars,
    keymap,
    lineNumbers,
    rectangularSelection,
    ViewPlugin,
} from "@codemirror/view";
import { foldPlaceholder } from "./edit-fold.js";
import { editorHistory } from "./edit-history.js";

// CodeMirror's basic setup, with inline folding controls instead of a fold gutter.
export const editorSetup: Extension = [
    ViewPlugin.define((view) => {
        const measure = () => view.requestMeasure();
        document.addEventListener("docs:font-change", measure);
        document.addEventListener("docs:line-wrap", measure);
        return {
            destroy: () => {
                document.removeEventListener("docs:font-change", measure);
                document.removeEventListener("docs:line-wrap", measure);
            },
        };
    }),
    EditorView.lineWrapping,
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    editorHistory,
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
        // Keep Ctrl shortcuts available on macOS alongside the native Cmd bindings.
        { key: "Ctrl-z", run: undo, preventDefault: true },
        { key: "Ctrl-y", run: redo, preventDefault: true },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        ...lintKeymap,
    ]),
];
