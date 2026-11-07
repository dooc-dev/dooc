import { indentWithTab, isolateHistory } from "@codemirror/commands";
import { EditorState, type Extension, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";
import { CHECK_ICON } from "../core/icons.js";
import type { PreviewSettings } from "../core/previewers.js";
import { isRemoteTextfile, textfileName } from "../core/textfile.js";
import { editorCodeHighlight } from "./edit-code-highlight.js";
import { chooseConflict } from "./edit-conflict.js";
import { previewSettingsState, setPreviewSettings } from "./edit-file-preview.js";
import { createFoldButton } from "./edit-fold.js";
import { gitBaseState, gitDiffState, gitDiffTheme, setGitBase } from "./edit-git-diff.js";
import { editorSetup } from "./edit-setup.js";
import { type FilePreview, fileReferences } from "./file-references.js";
import { t } from "./i18n.js";

export const textfileLines = (
    body: string,
    settings?: PreviewSettings,
): { line: number; file: string }[] =>
    fileReferences(body, settings)
        .filter((ref) => ref.kind === "textfile" || ref.kind === "term")
        .map(({ line, file }) => ({ line, file }));

interface FileDraft {
    base?: string | null;
    state?: EditorState;
    operation?: "read" | "save" | "validate" | "conflict";
    timer?: ReturnType<typeof setTimeout>;
    changedExternally?: boolean;
    open: boolean;
    error: string;
    errorAction?: "read" | "save";
    validation: "pending" | "checking" | "valid" | "error";
    validationMessage: string;
    listeners: Set<() => void>;
}

export const fileValidationState = (
    validation: FileDraft["validation"],
    preview?: FilePreview,
): FileDraft["validation"] =>
    validation === "error" || preview?.state === "error"
        ? "error"
        : validation === "checking" || preview?.state === "loading"
          ? "checking"
          : preview?.state === "pending"
            ? "pending"
            : validation;

/** File drafts outlive widgets, folds and article switches; duplicate references share edits. */
export const createTextfileEditors = (
    theme: Extension,
    onRefresh: (file: string) => void,
    onDirty: () => void,
) => {
    const drafts = new Map<string, FileDraft>();
    let previews: Record<string, FilePreview> = {};
    const cleanup = new WeakMap<HTMLElement, () => void>();
    const dirty = (draft: FileDraft): boolean =>
        !!draft.state && draft.state.sliceDoc() !== (draft.base ?? "");
    const notify = (draft: FileDraft): void => {
        for (const listener of draft.listeners) listener();
        onDirty();
    };
    const scheduleSave = (file: string, draft: FileDraft): void => {
        clearTimeout(draft.timer);
        draft.timer = undefined;
        if (isRemoteTextfile(file) || !dirty(draft) || draft.error) return;
        draft.timer = setTimeout(() => {
            draft.timer = undefined;
            void save(file, draft);
        }, 600);
    };
    const finish = (file: string, draft: FileDraft): void => {
        draft.operation = undefined;
        notify(draft);
        if (draft.changedExternally && !draft.error) {
            draft.changedExternally = false;
            void syncExternal(file, draft);
        } else scheduleSave(file, draft);
    };
    const request = async (file: string, input: object) => {
        const response = await fetch("/api/textfile", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ file, ...input }),
        });
        const result = (await response.json()) as {
            content: string | null;
            gitBase?: string | null;
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
        if (isRemoteTextfile(file) || draft.operation || !draft.state || !dirty(draft)) return;
        clearTimeout(draft.timer);
        const content = draft.state.sliceDoc();
        draft.operation = "save";
        draft.error = "";
        draft.errorAction = "save";
        let useExternal = false;
        notify(draft);
        try {
            try {
                draft.base = (
                    await request(file, { action: "save", content, base: draft.base })
                ).content;
            } catch (error) {
                if ((error as { status?: number }).status !== 409) throw error;
                const external = (await request(file, { action: "read" })).content;
                const compared = draft.state.doc;
                if (external === draft.state.sliceDoc()) {
                    draft.base = external;
                    return;
                }
                draft.operation = "conflict";
                notify(draft);
                const choice = await chooseConflict(file, draft.state.sliceDoc(), external);
                if (!choice || draft.state.doc !== compared) {
                    draft.error = t(
                        "Conflict unresolved. Auto-save is paused; your edits are kept.",
                    );
                    return;
                }
                if (choice === "external") {
                    useExternal = true;
                    return;
                }
                draft.base = external;
                return;
            }
            onRefresh(file);
        } catch (error) {
            draft.error = String(error);
        } finally {
            if (useExternal) {
                draft.operation = undefined;
                draft.changedExternally = false;
                await load(file, draft);
            } else finish(file, draft);
        }
    };
    const validate = async (file: string, draft: FileDraft): Promise<void> => {
        if (isRemoteTextfile(file) || draft.operation || !draft.state) return;
        const doc = draft.state.doc;
        draft.operation = "validate";
        draft.validation = "checking";
        draft.validationMessage = "";
        notify(draft);
        try {
            const result = await request(file, {
                action: "validate",
                content: draft.state.sliceDoc(),
            });
            if (draft.state.doc !== doc) {
                draft.validation = "pending";
                draft.validationMessage = t(
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
            draft.validationMessage = (result.findings ?? [])
                .map((finding) => finding.message)
                .join("\n");
            onRefresh(file);
        } catch (error) {
            draft.validation = "error";
            draft.validationMessage = String(error);
        } finally {
            finish(file, draft);
        }
    };
    const load = async (file: string, draft: FileDraft): Promise<void> => {
        if (draft.operation) return;
        const previousDoc = draft.state?.doc;
        draft.operation = "read";
        draft.error = "";
        draft.errorAction = "read";
        notify(draft);
        try {
            const { content, gitBase } = await request(file, { action: "read" });
            if (draft.state?.doc !== previousDoc) {
                // The queued save compares against the old base and resolves any disk conflict.
                return;
            }
            if (draft.state && content === draft.base) {
                draft.state = draft.state.update({ effects: setGitBase.of(gitBase ?? null) }).state;
                return;
            }
            draft.base = content;
            draft.validation = "pending";
            draft.validationMessage = "";
            if (draft.state) {
                draft.state = draft.state.update({
                    changes: { from: 0, to: draft.state.doc.length, insert: content ?? "" },
                    effects: setGitBase.of(gitBase ?? null),
                    annotations: isolateHistory.of("full"),
                }).state;
                onRefresh(file);
                return;
            }
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
                    gitBaseState.init(() => gitBase ?? null),
                    gitDiffState,
                    gitDiffTheme,
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
                        draft.validation = "pending";
                        draft.validationMessage = "";
                        notify(draft);
                        onRefresh(file);
                        scheduleSave(file, draft);
                    }),
                ],
            });
            onRefresh(file);
        } catch (error) {
            draft.error = String(error);
        } finally {
            finish(file, draft);
        }
    };
    const syncExternal = async (file: string, draft: FileDraft): Promise<void> => {
        if (draft.operation) {
            draft.changedExternally = true;
            return;
        }
        if (draft.error) return;
        if (dirty(draft)) await save(file, draft);
        else await load(file, draft);
    };

    class FileWidget extends WidgetType {
        constructor(
            readonly file: string,
            readonly controls: boolean,
            readonly line?: number,
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
                    open: false,
                    error: "",
                    validation: "pending",
                    validationMessage: "",
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
                const format = document.createElement("button");
                format.type = "button";
                format.className = "pbtn cm-textfile-validate";
                const validateIcon = document.getElementById("validate")?.innerHTML ?? "";
                format.hidden = remote;
                const saveStatus = document.createElement("span");
                saveStatus.className = "cm-textfile-save-status";
                saveStatus.setAttribute("role", "status");
                const retry = document.createElement("button");
                retry.type = "button";
                retry.className = "pbtn cm-textfile-retry";
                box.append(expand, format, saveStatus, retry);
                if (remote) {
                    const reload = document.createElement("button");
                    reload.type = "button";
                    reload.className = "pbtn";
                    reload.title = reload.ariaLabel = t("Reload file");
                    reload.innerHTML =
                        '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 8a6 6 0 1 0 0 4M16 3v5h-5"/></svg>';
                    reload.onclick = () => void load(this.file, current);
                    box.append(reload);
                }
                expand.addEventListener("click", () => {
                    current.open = !current.open;
                    notify(current);
                    if (current.open && !current.state) void load(this.file, current);
                });
                format.addEventListener("click", async () => {
                    if (!current.state) await load(this.file, current);
                    await validate(this.file, current);
                });
                retry.addEventListener("click", () => {
                    current.error = "";
                    current.changedExternally = false;
                    if (dirty(current)) void save(this.file, current);
                    else void load(this.file, current);
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
                    saveStatus.dataset.state = current.error ? "error" : "pending";
                    saveStatus.textContent = current.error
                        ? t(current.errorAction === "save" ? "Auto-save paused" : "Reload failed")
                        : current.operation === "save"
                          ? t("Saving")
                          : dirty(current)
                            ? t("Waiting for auto-save")
                            : "";
                    saveStatus.hidden = !saveStatus.textContent;
                    saveStatus.title = current.error || saveStatus.textContent;
                    retry.textContent = t("Retry");
                    retry.hidden = !current.error;
                    retry.disabled = !!current.operation;
                    const preview = previews[this.file];
                    const validation = fileValidationState(current.validation, preview);
                    format.dataset.state = validation;
                    format.innerHTML = validation === "valid" ? CHECK_ICON : validateIcon;
                    format.title = [
                        t(
                            {
                                pending: "Validate and apply",
                                checking: "Validating",
                                valid: "Validation passed",
                                error: "Validation errors",
                            }[validation],
                        ),
                        current.validationMessage,
                        preview?.state === "error" ? preview.message : "",
                    ]
                        .filter(Boolean)
                        .join("\n");
                    format.setAttribute("aria-label", format.title);
                    format.disabled = !!current.operation;
                    format.setAttribute("aria-busy", String(validation === "checking"));
                });
            }
            const host = document.createElement("div");
            host.className = "cm-textfile-editor";
            const status = document.createElement("div");
            status.className = "cm-textfile-status";
            status.setAttribute("role", "status");
            box.append(host, status);
            let inner: EditorView | undefined;
            let reveal = this.line;
            return subscribe(
                () => {
                    box.hidden = !current.open;
                    status.textContent =
                        current.error ||
                        current.validationMessage ||
                        t(
                            current.operation === "read"
                                ? "Working…"
                                : current.base === null
                                  ? remote
                                      ? "File not found"
                                      : "File not found — editing will create it automatically."
                                  : "",
                        );
                    status.hidden = !status.textContent;
                    status.classList.toggle(
                        "error",
                        !!current.error || current.validation === "error",
                    );
                    if (current.open && current.state) {
                        if (!inner) inner = new EditorView({ state: current.state, parent: host });
                        else if (inner.state !== current.state) inner.setState(current.state);
                        if (reveal !== undefined) {
                            const line = Math.max(1, Math.min(inner.state.doc.lines, reveal));
                            reveal = undefined;
                            inner.dispatch({
                                selection: { anchor: inner.state.doc.line(line).from },
                                scrollIntoView: true,
                            });
                            inner.focus();
                        }
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
            textfileLines(state.doc.toString(), state.field(previewSettingsState, false)).flatMap(
                ({ line, file }) => {
                    const position = state.doc.line(line).to;
                    const controls = Decoration.widget({
                        widget: new FileWidget(file, true),
                        side: 2,
                    }).range(position);
                    return [
                        controls,
                        Decoration.widget({
                            widget: new FileWidget(file, false),
                            block: true,
                            side: 3,
                        }).range(position),
                    ];
                },
            ),
        );
    return {
        mount: (
            file: string,
            parent: HTMLElement,
            outer: EditorView,
            line?: number,
        ): (() => void) => {
            const controls = new FileWidget(file, true);
            const buttons = controls.toDOM(outer);
            const draft = drafts.get(file) as FileDraft;
            draft.open = true;
            buttons.querySelector<HTMLElement>(".cm-inline-fold")?.setAttribute("hidden", "");
            const editor = new FileWidget(file, false, line);
            const content = editor.toDOM(outer);
            parent.append(buttons, content);
            notify(draft);
            if (!draft.state) void load(file, draft);
            return () => {
                controls.destroy(buttons);
                editor.destroy(content);
            };
        },
        content: (file: string): string | undefined => drafts.get(file)?.state?.sliceDoc(),
        hasUnsavedChanges: () =>
            [...drafts.values()].some(
                (draft) =>
                    dirty(draft) || draft.operation === "save" || draft.operation === "conflict",
            ),
        setPreviews: (next: Record<string, FilePreview>): void => {
            previews = next;
            for (const draft of drafts.values()) for (const listener of draft.listeners) listener();
        },
        flush: async (): Promise<void> => {
            for (const [file, draft] of drafts) {
                if (isRemoteTextfile(file)) continue;
                while (draft.operation || (dirty(draft) && !draft.error)) {
                    if (draft.operation)
                        await new Promise<void>((resolve) => {
                            const done = () => {
                                if (draft.operation) return;
                                draft.listeners.delete(done);
                                resolve();
                            };
                            draft.listeners.add(done);
                        });
                    if (!draft.error) await save(file, draft);
                }
            }
        },
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
                if (draft.state && (files.includes(file) || files.includes(".git/HEAD")))
                    await syncExternal(file, draft);
            }
        },
        extension: StateField.define<DecorationSet>({
            create: decorations,
            update: (value, transaction) =>
                transaction.docChanged ||
                transaction.effects.some((effect) => effect.is(setPreviewSettings))
                    ? decorations(transaction.state)
                    : value,
            provide: (field) => EditorView.decorations.from(field),
        }),
    };
};
