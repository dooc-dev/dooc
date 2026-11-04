import { indentWithTab, isolateHistory } from "@codemirror/commands";
import { EditorState, type Extension, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";
import { normalizeLeafDirectives, TEXTFILE_LINE_RE } from "../core/taxonomy.js";
import { isRemoteTextfile, textfileName } from "../core/textfile.js";
import { editorCodeHighlight } from "./edit-code-highlight.js";
import { chooseConflict } from "./edit-conflict.js";
import { createFoldButton } from "./edit-fold.js";
import { editorSetup } from "./edit-setup.js";
import { t } from "./i18n.js";

export const textfileLines = (body: string): { line: number; file: string }[] => {
    const original = body.split("\n");
    return normalizeLeafDirectives(body)
        .source.split("\n")
        .flatMap((line, i) => {
            if (!/^ {0,3}::textfile\{/.test(line)) return [];
            const file = TEXTFILE_LINE_RE.exec(original[i] ?? "")?.[2]?.trim();
            return file ? [{ line: i + 1, file: file.replace(/^(\.\/)+/, "") }] : [];
        });
};

interface FileDraft {
    base?: string | null;
    state?: EditorState;
    busy: boolean;
    open: boolean;
    error: string;
    validation: "pending" | "checking" | "valid" | "error";
    listeners: Set<() => void>;
}

/** File drafts outlive widgets, folds and article switches; duplicate references share edits. */
export const createTextfileEditors = (
    theme: Extension,
    onRefresh: () => void,
    onDirty: () => void,
) => {
    const drafts = new Map<string, FileDraft>();
    const cleanup = new WeakMap<HTMLElement, () => void>();
    const dirty = (draft: FileDraft): boolean =>
        !!draft.state && draft.state.sliceDoc() !== (draft.base ?? "");
    const notify = (draft: FileDraft): void => {
        for (const listener of draft.listeners) listener();
        onDirty();
    };
    const request = async (file: string, input: object) => {
        const response = await fetch("/api/textfile", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ file, ...input }),
        });
        const result = (await response.json()) as {
            content: string | null;
            error?: string;
            findings?: { message: string; range: [number, number]; ruleId: string }[];
        };
        if (!response.ok)
            throw Object.assign(new Error(t(result.error ?? "Save failed")), {
                status: response.status,
            });
        return result;
    };
    const save = async (file: string, draft: FileDraft): Promise<void> => {
        if (isRemoteTextfile(file) || draft.busy || !draft.state) return;
        const content = draft.state.sliceDoc();
        draft.busy = true;
        draft.error = "";
        notify(draft);
        try {
            try {
                draft.base = (
                    await request(file, { action: "save", content, base: draft.base })
                ).content;
            } catch (error) {
                if ((error as { status?: number }).status !== 409) throw error;
                const external = (await request(file, { action: "read" })).content;
                const choice = await chooseConflict(file, content, external);
                if (!choice) throw error;
                draft.base = external;
                draft.busy = false;
                if (choice === "external") await load(file, draft);
                else await save(file, draft);
                return;
            }
            onRefresh();
        } catch (error) {
            draft.error = String(error);
        } finally {
            draft.busy = false;
            notify(draft);
        }
    };
    const validate = async (file: string, draft: FileDraft): Promise<void> => {
        if (isRemoteTextfile(file) || draft.busy || !draft.state) return;
        const doc = draft.state.doc;
        draft.busy = true;
        draft.validation = "checking";
        draft.error = "";
        notify(draft);
        try {
            const result = await request(file, {
                action: "validate",
                content: draft.state.sliceDoc(),
            });
            if (draft.state.doc !== doc) {
                draft.validation = "pending";
                draft.error = t(
                    "Edits made while validating were kept. Validate again when ready.",
                );
                return;
            }
            if (result.content != null && result.content !== draft.state.sliceDoc())
                draft.state = draft.state.update({
                    changes: { from: 0, to: doc.length, insert: result.content },
                    annotations: isolateHistory.of("full"),
                    userEvent: "input.format",
                }).state;
            draft.validation = result.findings?.length ? "error" : "valid";
            draft.error = (result.findings ?? []).map((finding) => finding.message).join("\n");
            onRefresh();
        } catch (error) {
            draft.validation = "error";
            draft.error = String(error);
        } finally {
            draft.busy = false;
            notify(draft);
        }
    };
    const load = async (file: string, draft: FileDraft): Promise<void> => {
        if (draft.busy) return;
        const previousDoc = draft.state?.doc;
        draft.busy = true;
        draft.error = "";
        notify(draft);
        try {
            const { content } = await request(file, { action: "read" });
            if (draft.state?.doc !== previousDoc) {
                draft.error = t("Edits made while reloading were kept. Reload again when ready.");
                return;
            }
            draft.base = content;
            draft.validation = "pending";
            const filename = textfileName(file);
            draft.state = EditorState.create({
                doc: content ?? "",
                extensions: [
                    EditorState.readOnly.of(isRemoteTextfile(file)),
                    EditorView.editable.of(!isRemoteTextfile(file)),
                    keymap.of([
                        {
                            key: "Mod-s",
                            preventDefault: true,
                            run: () => {
                                void save(file, draft);
                                return true;
                            },
                        },
                        {
                            key: "Shift-Alt-f",
                            preventDefault: true,
                            run: () => {
                                void validate(file, draft);
                                return true;
                            },
                        },
                        indentWithTab,
                    ]),
                    editorSetup,
                    theme,
                    editorCodeHighlight((filename.split(".").at(-1) || filename).toLowerCase()),
                    EditorState.lineSeparator.of(content?.includes("\r\n") ? "\r\n" : "\n"),
                    EditorView.contentAttributes.of({
                        "aria-label": `${t(isRemoteTextfile(file) ? "View remote text file" : "Edit text file")}: ${file}`,
                        spellcheck: "false",
                    }),
                    EditorView.updateListener.of((update) => {
                        draft.state = update.state;
                        if (!update.docChanged) return;
                        draft.error = "";
                        draft.validation = "pending";
                        notify(draft);
                        onRefresh();
                    }),
                ],
            });
            onRefresh();
        } catch (error) {
            draft.error = String(error);
        } finally {
            draft.busy = false;
            notify(draft);
        }
    };

    class FileWidget extends WidgetType {
        constructor(
            readonly file: string,
            readonly controls: boolean,
        ) {
            super();
        }
        override eq(other: FileWidget): boolean {
            return this.file === other.file && this.controls === other.controls;
        }
        toDOM(outer: EditorView): HTMLElement {
            const remote = isRemoteTextfile(this.file);
            let draft = drafts.get(this.file);
            if (!draft) {
                draft = {
                    busy: false,
                    open: false,
                    error: "",
                    validation: "pending",
                    listeners: new Set(),
                };
                drafts.set(this.file, draft);
            }
            const current = draft;
            const box = document.createElement(this.controls ? "span" : "div");
            box.className = this.controls ? "cm-textfile-controls" : "cm-textfile";
            box.dataset.file = this.file;
            const subscribe = (refresh: () => void, dispose?: () => void): HTMLElement => {
                current.listeners.add(refresh);
                document.addEventListener("docs:ui-language", refresh);
                cleanup.set(box, () => {
                    current.listeners.delete(refresh);
                    document.removeEventListener("docs:ui-language", refresh);
                    dispose?.();
                });
                refresh();
                return box;
            };
            if (this.controls) {
                box.setAttribute("role", "group");
                const expand = createFoldButton(!current.open);
                const actionButton = (action: "save" | "validate"): HTMLButtonElement => {
                    const button = document.createElement("button");
                    button.type = "button";
                    button.className = `pbtn cm-textfile-${action}`;
                    button.innerHTML = document.getElementById(action)?.innerHTML ?? "";
                    button.hidden = remote;
                    return button;
                };
                const format = actionButton("validate");
                const saveButton = actionButton("save");
                const reload = document.createElement("button");
                reload.type = "button";
                reload.className = "pbtn";
                reload.innerHTML =
                    '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 8a6 6 0 1 0 0 4M16 3v5h-5"/></svg>';
                box.append(expand, format, saveButton, reload);
                expand.addEventListener("click", () => {
                    current.open = !current.open;
                    notify(current);
                    if (current.open && !current.state) void load(this.file, current);
                });
                saveButton.addEventListener("click", () => void save(this.file, current));
                format.addEventListener("click", () => void validate(this.file, current));
                reload.addEventListener("click", () => {
                    if (!dirty(current) || window.confirm(t("Discard file edits and reload?")))
                        void load(this.file, current);
                });
                return subscribe(() => {
                    box.setAttribute(
                        "aria-label",
                        `${t(remote ? "View remote text file" : "Edit text file")}: ${this.file}`,
                    );
                    expand.setAttribute("aria-expanded", String(current.open));
                    const foldLabel = current.open ? "Collapse section" : "Expand section";
                    expand.dataset.i18nTitle = expand.dataset.i18nAriaLabel = foldLabel;
                    expand.title = t(foldLabel);
                    expand.setAttribute("aria-label", expand.title);
                    const saveState = current.error
                        ? "error"
                        : current.busy
                          ? "saving"
                          : dirty(current) || current.base === null
                            ? "pending"
                            : "saved";
                    saveButton.dataset.state = saveState;
                    saveButton.title =
                        current.error ||
                        t(
                            current.base === null
                                ? "Create file"
                                : {
                                      pending: "Unsaved changes",
                                      saving: "Saving",
                                      saved: "Saved",
                                      error: "Save failed",
                                  }[saveState],
                        );
                    saveButton.setAttribute(
                        "aria-label",
                        t(current.base === null ? "Create file" : "Save"),
                    );
                    saveButton.disabled =
                        current.busy ||
                        !current.state ||
                        (current.base !== null && !dirty(current));
                    format.dataset.state = current.validation;
                    format.title = t(
                        {
                            pending: "Validate and apply",
                            checking: "Validating",
                            valid: "Validation passed",
                            error: "Validation errors",
                        }[current.validation],
                    );
                    format.setAttribute("aria-label", t("Validate and apply"));
                    format.disabled = current.busy || !current.state;
                    format.setAttribute("aria-busy", String(current.validation === "checking"));
                    reload.title = t("Reload file");
                    reload.setAttribute("aria-label", reload.title);
                    reload.disabled = current.busy;
                });
            }
            const host = document.createElement("div");
            host.className = "cm-textfile-editor";
            const status = document.createElement("div");
            status.className = "cm-textfile-status";
            status.setAttribute("role", "status");
            box.append(host, status);
            let inner: EditorView | undefined;
            return subscribe(
                () => {
                    box.hidden = !current.open;
                    status.textContent =
                        current.error ||
                        t(
                            current.busy
                                ? "Working…"
                                : current.base === null
                                  ? remote
                                      ? "File not found"
                                      : "File not found — save to create it."
                                  : "",
                        );
                    status.hidden = !status.textContent;
                    status.classList.toggle("error", !!current.error);
                    if (current.open && current.state) {
                        if (!inner) inner = new EditorView({ state: current.state, parent: host });
                        else if (inner.state !== current.state) inner.setState(current.state);
                    }
                    outer.requestMeasure();
                },
                () => inner?.destroy(),
            );
        }
        override destroy(dom: HTMLElement): void {
            cleanup.get(dom)?.();
        }
        override ignoreEvent(): boolean {
            return true;
        }
    }
    const decorations = (state: EditorState): DecorationSet =>
        Decoration.set(
            textfileLines(state.doc.toString()).flatMap(({ line, file }) => {
                const position = state.doc.line(line).to;
                const controls = Decoration.widget({
                    widget: new FileWidget(file, true),
                    side: 1,
                }).range(position);
                return [
                    controls,
                    Decoration.widget({
                        widget: new FileWidget(file, false),
                        block: true,
                        side: 2,
                    }).range(position),
                ];
            }),
        );
    return {
        hasUnsavedChanges: () => [...drafts.values()].some((draft) => dirty(draft) || draft.busy),
        previewFiles: (): Record<string, string> =>
            Object.fromEntries(
                [...drafts].flatMap(([file, draft]) =>
                    draft.state && dirty(draft) && !isRemoteTextfile(file)
                        ? [[file, draft.state.sliceDoc()]]
                        : [],
                ),
            ),
        reloadChanged: async (files: string[]): Promise<void> => {
            for (const [file, draft] of drafts) {
                if (!files.includes(file) || !draft.state || draft.busy) continue;
                if (!dirty(draft)) {
                    await load(file, draft);
                    continue;
                }
                draft.busy = true;
                notify(draft);
                try {
                    const external = (await request(file, { action: "read" })).content;
                    if (external === draft.base) continue;
                    const choice = await chooseConflict(file, draft.state.sliceDoc(), external);
                    if (!choice) {
                        draft.error = t("File changed externally. Reload before saving.");
                        continue;
                    }
                    draft.base = external;
                    draft.busy = false;
                    if (choice === "external") await load(file, draft);
                    else await save(file, draft);
                } catch (error) {
                    draft.error = String(error);
                } finally {
                    draft.busy = false;
                    notify(draft);
                }
            }
        },
        extension: StateField.define<DecorationSet>({
            create: decorations,
            update: (value, transaction) =>
                transaction.docChanged ? decorations(transaction.state) : value,
            provide: (field) => EditorView.decorations.from(field),
        }),
    };
};
