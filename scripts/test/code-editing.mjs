import { EditorView, ViewPlugin } from "@codemirror/view";
import { gitBaseState } from "../../packages/frontend/src/edit-git-diff.ts";
import { createTextfileEditors } from "../../packages/frontend/src/edit-textfile.ts";

// Bundle with esbuild and run testCodeEditing() in a browser on a local HTTP origin.
window.testCodeEditing = async () => {
    const assert = (condition, message) => {
        if (!condition) throw new Error(message);
    };
    const wait = async (test) => {
        for (let i = 0; i < 200; i++) {
            if (test()) return;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(`Timed out: ${test.toString()}`);
    };
    const originalFetch = window.fetch;
    let content = "const value = 1;\n";
    let gitBase = content;
    let saves = 0;
    let mounts = 0;
    window.fetch = async (_url, options) => {
        const input = JSON.parse(options.body);
        if (input.action === "save") {
            assert(input.base === content, "Saving must compare against the loaded file");
            content = input.content;
            saves++;
        }
        return Response.json({ content, gitBase });
    };
    const parent = document.createElement("div");
    document.body.append(parent);
    const outer = new EditorView({ parent });
    const editors = createTextfileEditors(
        ViewPlugin.define(() => {
            mounts++;
            return {};
        }),
        () => {},
        () => {},
    );
    const file = "example.ts";
    const dispose = editors.mount(file, parent, outer);
    try {
        await wait(() => parent.querySelector(".cm-textfile-editor .cm-content"));
        const inner = EditorView.findFromDOM(
            parent.querySelector(".cm-textfile-editor .cm-content"),
        );
        const line = inner.contentDOM.firstChild;
        inner.dispatch({ changes: { from: inner.state.doc.length, insert: "// Edited\n" } });
        await editors.flush();
        assert(saves === 1 && content.endsWith("// Edited\n"), "Edits must still be saved");
        const saved = inner.state;
        await editors.reloadChanged([file]);
        await editors.reloadChanged([".git/HEAD"]);
        assert(inner.state === saved, "Unchanged reloads must preserve the editor state");
        assert(mounts === 1, "Saving must not restart syntax highlighting plugins");
        assert(inner.contentDOM.firstChild === line, "Unchanged code must keep its DOM");
        gitBase = content;
        await editors.reloadChanged([".git/HEAD"]);
        assert(inner.state.field(gitBaseState) === gitBase, "New Git bases must still update");
        content = "const external = 2;\n";
        await editors.reloadChanged([file]);
        assert(inner.state.sliceDoc() === content, "External file edits must still load");
        return {
            assertions:
                "save, unchanged reload, plugin and DOM preservation, Git base, external edits",
        };
    } finally {
        dispose();
        outer.destroy();
        parent.remove();
        window.fetch = originalFetch;
    }
};
