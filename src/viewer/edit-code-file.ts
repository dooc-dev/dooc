import { isolateHistory } from "@codemirror/commands";
import { StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { codeFileName } from "../core/code-file.js";
import { codeBlockAt, parseMdast } from "../core/markdown.js";
import { showDialog, showNotice } from "./edit-dialog.js";
import { t } from "./i18n.js";

export const codeFileButtons = (documentId: () => string) => {
    class FileButton extends WidgetType {
        constructor(readonly position: number) {
            super();
        }
        override eq(other: FileButton) {
            return this.position === other.position;
        }
        toDOM(view: EditorView) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "code-file-button";
            button.title = t("Create file");
            button.setAttribute("aria-label", button.title);
            button.innerHTML =
                '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 2h8l4 4v12H4zM12 2v5h4M7 12h6M10 9v6"/></svg>';
            button.onmousedown = (event) => event.preventDefault();
            button.onclick = async () => {
                const doc = view.state.doc;
                const id = documentId();
                const body = doc.toString();
                button.disabled = true;
                button.dataset.state = "loading";
                try {
                    const post = async (url: string, input: unknown) => {
                        const response = await fetch(url, {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify(input),
                        });
                        const data = await response.json();
                        if (!response.ok) throw new Error(data.error);
                        return data;
                    };
                    const snapshot = await post("/api/files", { action: "read" });
                    let file: string | undefined;
                    if (!snapshot.layout.defaultLayout) {
                        const field = document.createElement("textarea");
                        field.rows = 2;
                        field.value = codeFileName(body, this.position, id);
                        field.setAttribute("aria-label", t("File path"));
                        const answer = await showDialog(t("Create file"), field, [
                            { value: "", label: t("Cancel") },
                            { value: "create", label: t("Create") },
                        ]);
                        if (answer !== "create") return;
                        file = field.value;
                    }
                    if (view.state.doc !== doc || documentId() !== id)
                        throw new Error(t("Document changed. Retry from the current block."));
                    const result = await post("/api/code-file", {
                        body,
                        position: this.position,
                        documentId: id,
                        ...(file ? { file } : {}),
                    });
                    if (view.state.doc !== doc || documentId() !== id) {
                        await showNotice(
                            `${t("File created")}: ${result.file}\n${t("Document changed. Insert the file from Files.")}`,
                        );
                        return;
                    }
                    view.dispatch({
                        changes: result.change,
                        annotations: isolateHistory.of("full"),
                        selection: { anchor: result.change.from + result.change.insert.length },
                    });
                    view.focus();
                } catch (error) {
                    await showNotice(error instanceof Error ? error.message : String(error));
                } finally {
                    button.disabled = false;
                    delete button.dataset.state;
                }
            };
            return button;
        }
        override ignoreEvent() {
            return true;
        }
    }
    const decorations = (body: string) =>
        Decoration.set(
            parseMdast(body).children.flatMap((node) => {
                if (node.type !== "code" || node.position?.start.offset === undefined) return [];
                try {
                    const block = codeBlockAt(body, node.position.start.offset);
                    if (!block.topLevel) return [];
                    return [
                        Decoration.widget({ widget: new FileButton(block.start), side: 1 }).range(
                            body.indexOf("\n", block.start),
                        ),
                    ];
                } catch {
                    return [];
                }
            }),
            true,
        );
    return [
        StateField.define<DecorationSet>({
            create: (state) => decorations(state.doc.toString()),
            update: (value, tr) => (tr.docChanged ? decorations(tr.newDoc.toString()) : value),
            provide: (field) => EditorView.decorations.from(field),
        }),
        EditorView.baseTheme({
            ".code-file-button": {
                float: "right",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: "24px",
                height: "24px",
                padding: "2px",
                border: "1px solid var(--c-line)",
                borderRadius: "4px",
                background: "var(--c-bg)",
                color: "var(--c-fg)",
                cursor: "pointer",
            },
            ".code-file-button[data-state=loading] svg": { opacity: "0.4" },
        }),
    ];
};
