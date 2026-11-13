import { type EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import type { PreviewSettings } from "../../engine/src/core/previewers.js";
import { isRemoteTextfile } from "../../engine/src/core/textfile.js";
import { type FilePreview, fileReferences } from "./file-references.js";
import { t } from "./i18n.js";

const labels = {
    pending: "Preview has not been updated",
    loading: "Updating preview",
    valid: "Preview is up to date",
    error: "Preview could not be updated",
};
const icons = {
    pending: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2"/>',
    loading: '<path d="M17 10a7 7 0 1 1-7-7"/>',
    valid: '<path d="m4 10 4 4 8-8"/>',
    error: '<circle cx="10" cy="10" r="7"/><path d="M10 5v6m0 3h.01"/>',
};

class FilePreviewWidget extends WidgetType {
    constructor(
        readonly file: string,
        readonly preview: FilePreview,
        readonly label: string,
    ) {
        super();
    }
    override eq(other: FilePreviewWidget): boolean {
        return (
            this.file === other.file &&
            this.preview.state === other.preview.state &&
            this.label === other.label
        );
    }
    toDOM(): HTMLElement {
        const element = document.createElement("span");
        element.className = "cm-file-preview";
        element.dataset.file = this.file;
        element.dataset.state = this.preview.state;
        element.title = this.label;
        element.setAttribute("role", "status");
        element.setAttribute("aria-label", this.label);
        element.setAttribute("aria-busy", String(this.preview.state === "loading"));
        element.innerHTML = `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[this.preview.state]}</svg>`;
        return element;
    }
    override ignoreEvent(): boolean {
        return true;
    }
}

export const setFilePreviews = StateEffect.define<Record<string, FilePreview>>();
export const setPreviewSettings = StateEffect.define<PreviewSettings | undefined>();
export const previewSettingsState = StateField.define<PreviewSettings | undefined>({
    create: () => undefined,
    update: (value, transaction) => {
        const change = transaction.effects.find((effect) => effect.is(setPreviewSettings));
        return change ? change.value : value;
    },
});

const decorations = (state: EditorState, previews: Record<string, FilePreview>): DecorationSet =>
    Decoration.set(
        fileReferences(state.doc.toString(), state.field(previewSettingsState, false))
            .filter(
                ({ kind, file }) =>
                    isRemoteTextfile(file) || (kind !== "textfile" && kind !== "term"),
            )
            .map(({ line, file }) => {
                const preview = Object.hasOwn(previews, file)
                    ? (previews[file] as FilePreview)
                    : { state: "pending" as const };
                const label = `${file}: ${t(labels[preview.state])}${preview.message ? `\n${t(preview.message)}` : ""}`;
                return Decoration.widget({
                    widget: new FilePreviewWidget(file, preview, label),
                    side: 1,
                }).range(state.doc.line(line).to);
            }),
    );

export const filePreviewState = StateField.define<{
    previews: Record<string, FilePreview>;
    decorations: DecorationSet;
}>({
    create: (state) => ({ previews: {}, decorations: decorations(state, {}) }),
    update: (value, transaction) => {
        const change = transaction.effects.find((effect) => effect.is(setFilePreviews));
        if (
            !transaction.docChanged &&
            !change &&
            !transaction.effects.some((effect) => effect.is(setPreviewSettings))
        )
            return value;
        const previews = change?.value ?? value.previews;
        return { previews, decorations: decorations(transaction.state, previews) };
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});
