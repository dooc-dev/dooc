import { EditorView } from "@codemirror/view";
import { editorSetup } from "../../packages/frontend/src/edit-setup.ts";

// Bundle with esbuild and run testLineWrapping() on a fresh edit page.
window.testLineWrapping = async () => {
    const assert = (condition, message) => {
        if (!condition) throw new Error(message);
    };
    const checkbox = document.querySelector("#opt-line-wrap");
    const editors = [...document.querySelectorAll(".cm-editor")]
        .filter((element) => element.getClientRects().length)
        .map((element) => {
            const editor = EditorView.findFromDOM(element);
            return { editor, state: editor.state };
        });
    const saveState = document.querySelector("#save").dataset.state;
    const key = "docs-edit:line-wrap";
    const stored = localStorage.getItem(key);
    assert(editors.length > 0, "At least one text editor is visible");
    assert(
        checkbox.checked && editors.every(({ editor }) => editor.lineWrapping),
        "All text editors wrap by default",
    );
    try {
        for (const enabled of [false, true]) {
            checkbox.click();
            await new Promise(requestAnimationFrame);
            assert(checkbox.checked === enabled, "The checkbox reflects wrapping");
            for (const { editor, state } of editors) {
                assert(editor.lineWrapping === enabled, "Wrapping changes in every text editor");
                assert(
                    editor.state === state,
                    "Toggling preserves contents, selection and history",
                );
            }
            assert(
                localStorage.getItem(key) === (enabled ? "1" : "0"),
                "The wrapping preference is saved",
            );
            assert(
                document.querySelector("#save").dataset.state === saveState,
                "Toggling does not mark the document as modified",
            );
            const host = document.body.appendChild(document.createElement("div"));
            const opened = new EditorView({
                parent: host,
                doc: "New editor",
                extensions: editorSetup,
            });
            try {
                await new Promise(requestAnimationFrame);
                assert(opened.lineWrapping === enabled, "New editors use the current preference");
            } finally {
                opened.destroy();
                host.remove();
            }
        }
        return {
            assertions:
                "all editors, default on, toggle off/on, preference, state, newly opened editors",
        };
    } finally {
        if (!checkbox.checked) checkbox.click();
        if (stored === null) localStorage.removeItem(key);
        else localStorage.setItem(key, stored);
    }
};
