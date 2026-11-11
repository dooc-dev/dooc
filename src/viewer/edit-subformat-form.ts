import { isolateHistory } from "@codemirror/commands";
import { type EditorState, StateEffect, StateField } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { JSONSchema } from "vscode-json-languageservice";
import { type SchemaObject, schemaObject } from "../core/schema-fields.js";
import { type SchemaContext, schemaResolver } from "../core/schema-refs.js";
import { parseSubformatRecord, setSubformatValue } from "../core/subformat-record.js";
import type { Subformat } from "../core/subformats.js";
import { mountDatePickers, parseDateValue } from "./date-picker.js";
import { t } from "./i18n.js";
import { mountSelectPickers } from "./language-picker.js";
import { showSubformatError } from "./subformats-ui.js";

const setMode = StateEffect.define<boolean>();
const formMode = StateField.define<boolean>({
    create: () => true,
    update: (mode, transaction) =>
        transaction.effects.find((effect) => effect.is(setMode))?.value ?? mode,
});
const setInput = StateEffect.define<{ path: string; draft?: { value: string; error: string } }>();
const formInputs = StateField.define<ReadonlyMap<string, { value: string; error: string }>>({
    create: () => new Map(),
    update: (inputs, transaction) => {
        for (const effect of transaction.effects) {
            if (!effect.is(setInput)) continue;
            const next = new Map(inputs);
            if (effect.value.draft) next.set(effect.value.path, effect.value.draft);
            else next.delete(effect.value.path);
            inputs = next;
        }
        return inputs;
    },
});
export const hasSubformatFormDraft = (state?: EditorState): boolean =>
    !!state?.field(formInputs, false)?.size;
let fieldId = 0;

export const subformatForm = (
    schema: JSONSchema,
    format: Subformat["format"],
    context?: SchemaContext,
) => {
    const resolve = schemaResolver(schema as SchemaObject, context);
    return [
        formMode.init((state) => {
            try {
                parseSubformatRecord(state.doc.toString(), format);
                return true;
            } catch {
                return false;
            }
        }),
        formInputs,
        ViewPlugin.fromClass(
            class {
                private toggle = document.createElement("button");
                private panel = document.createElement("div");
                private host?: HTMLElement;
                private disposed = false;
                private disposePickers?: () => void;
                constructor(private view: EditorView) {
                    this.toggle.type = "button";
                    this.toggle.className = "pbtn schema-mode-switch";
                    this.toggle.addEventListener("click", () => {
                        const invalid = this.panel.querySelector<HTMLInputElement>(":invalid");
                        if (!this.panel.hidden && invalid) {
                            invalid.reportValidity();
                            return;
                        }
                        if (this.panel.hidden) {
                            try {
                                parseSubformatRecord(view.state.doc.toString(), format);
                            } catch (error) {
                                showSubformatError(error);
                                return;
                            }
                        }
                        view.dispatch({ effects: setMode.of(this.panel.hidden) });
                        if (this.panel.hidden) view.focus();
                    });
                    this.panel.className = "schema-builder subformat-value-form";
                    this.panel.setAttribute("role", "group");
                    queueMicrotask(() => {
                        if (this.disposed) return;
                        this.host = view.dom.parentElement ?? undefined;
                        this.host?.classList.add("schema-editor-host");
                        const heading =
                            view.dom.closest("#file-editor") &&
                            document.querySelector(".file-editor-heading");
                        if (heading) heading.append(this.toggle);
                        else this.host?.prepend(this.toggle);
                        this.host?.insertBefore(this.panel, view.dom);
                        this.render();
                    });
                }
                update(update: ViewUpdate): void {
                    if (
                        (update.docChanged &&
                            !update.transactions.some((tr) => tr.isUserEvent("input.form"))) ||
                        update.state.field(formMode) !== update.startState.field(formMode)
                    )
                        this.render();
                }
                destroy(): void {
                    this.disposed = true;
                    this.disposePickers?.();
                    this.toggle.remove();
                    this.panel.remove();
                    this.host?.classList.remove("schema-editor-host");
                    this.view.dom.hidden = false;
                }
                private render(): void {
                    if (!this.host || this.disposed) return;
                    let data: Record<string, unknown> | undefined;
                    try {
                        data = parseSubformatRecord(this.view.state.doc.toString(), format);
                    } catch {
                        // Incomplete source remains editable in its storage format.
                    }
                    const form = !!data && this.view.state.field(formMode);
                    this.view.dom.hidden = form;
                    this.panel.hidden = !form;
                    this.toggle.dataset.recordMode = form ? "form" : format;
                    this.toggle.setAttribute("aria-pressed", String(form));
                    const text = t("{format} text", { format: format.toUpperCase() });
                    const name = t("Form");
                    this.panel.setAttribute("aria-label", name);
                    this.toggle.title = `${t("Value editing mode")}: ${form ? name : text} → ${form ? text : name}`;
                    this.toggle.setAttribute("aria-label", this.toggle.title);
                    this.toggle.innerHTML = `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
                        form
                            ? '<rect x="3" y="3" width="4" height="4" rx="1"/><rect x="3" y="12" width="4" height="4" rx="1"/><path d="M11 5h6M11 14h6"/>'
                            : '<path d="M7 3H5v5l-2 2 2 2v5h2M13 3h2v5l2 2-2 2v5h-2"/>'
                    }</svg>`;
                    this.disposePickers?.();
                    this.disposePickers = undefined;
                    if (form && data) {
                        const scroll = this.panel.scrollTop;
                        this.panel.replaceChildren();
                        this.panel.inert = this.view.state.readOnly;
                        this.fields(resolve(schema), data, [], this.panel);
                        const disposeSelects = mountSelectPickers(t, [
                            ...this.panel.querySelectorAll("select"),
                        ]);
                        const disposeDates = mountDatePickers(
                            this.panel.querySelectorAll<HTMLInputElement>("[data-record-date]"),
                        );
                        this.disposePickers = () => {
                            disposeSelects();
                            disposeDates();
                        };
                        this.panel.scrollTop = scroll;
                    }
                    this.view.requestMeasure();
                }
                private fields(
                    rule: SchemaObject,
                    data: Record<string, unknown>,
                    path: string[],
                    host: HTMLElement,
                    readOnly = false,
                ): void {
                    const properties = schemaObject(rule.properties) ? rule.properties : {};
                    for (const key of new Set([...Object.keys(properties), ...Object.keys(data)])) {
                        const definition = Object.hasOwn(properties, key)
                            ? properties[key]
                            : rule.additionalProperties;
                        const field = resolve(definition);
                        const value = Object.hasOwn(data, key) ? data[key] : undefined;
                        const fieldPath = [...path, key];
                        const name = typeof field.title === "string" ? field.title : key;
                        const required =
                            Array.isArray(rule.required) && rule.required.includes(key);
                        const locked =
                            readOnly ||
                            rule.readOnly === true ||
                            field.readOnly === true ||
                            Object.hasOwn(field, "const");
                        if (
                            schemaObject(value) &&
                            schemaObject(field.properties) &&
                            !Array.isArray(field.enum)
                        ) {
                            const group = document.createElement("fieldset");
                            const legend = document.createElement("legend");
                            legend.textContent = name + (required ? " *" : "");
                            group.append(legend);
                            this.fields(field, value, fieldPath, group, locked);
                            host.append(group);
                            continue;
                        }
                        const label = document.createElement("label");
                        const caption = document.createElement("span");
                        caption.textContent = name + (required ? " *" : "");
                        label.append(caption);
                        const choices = Array.isArray(field.enum)
                            ? field.enum
                            : field.type === "boolean"
                              ? [true, false]
                              : undefined;
                        const numeric = field.type === "number" || field.type === "integer";
                        const string =
                            field.type === "string" &&
                            (value === undefined || typeof value === "string");
                        const date = !choices && string && field.format === "date";
                        // shortcut: arrays and composed values use JSON fields; add specialized controls when needed.
                        const json = !choices && !numeric && !string;
                        const input = choices
                            ? document.createElement("select")
                            : document.createElement(
                                  json || (string && String(value ?? "").includes("\n"))
                                      ? "textarea"
                                      : "input",
                              );
                        input.id = `record-field-${++fieldId}`;
                        input.dataset.recordPath = JSON.stringify(fieldPath);
                        input.disabled = locked;
                        input.setAttribute("aria-label", name);
                        input.setAttribute("aria-required", String(required));
                        if (input instanceof HTMLSelectElement && choices) {
                            const empty = new Option("", "");
                            empty.disabled = true;
                            input.add(empty);
                            choices.forEach((choice, index) => {
                                input.add(
                                    new Option(
                                        typeof choice === "string"
                                            ? choice
                                            : JSON.stringify(choice),
                                        String(index),
                                    ),
                                );
                            });
                            const selected = choices.findIndex(
                                (choice) => JSON.stringify(choice) === JSON.stringify(value),
                            );
                            if (value !== undefined && selected < 0)
                                input.add(new Option(JSON.stringify(value), "unknown"));
                            input.value =
                                selected >= 0
                                    ? String(selected)
                                    : value === undefined
                                      ? ""
                                      : "unknown";
                        } else {
                            input.value =
                                value === undefined
                                    ? ""
                                    : json
                                      ? JSON.stringify(value, null, 2)
                                      : String(value);
                            if (input instanceof HTMLTextAreaElement) input.rows = json ? 4 : 2;
                            else if (input instanceof HTMLInputElement) {
                                if (numeric) input.inputMode = "decimal";
                                if (date) input.dataset.recordDate = "";
                            }
                        }
                        if (json) caption.append(" (JSON)");
                        const pending = this.view.state
                            .field(formInputs)
                            .get(JSON.stringify(fieldPath));
                        if (pending) {
                            input.value = pending.value;
                            input.setCustomValidity(pending.error);
                        }
                        if (date) input.setAttribute("aria-invalid", String(!!pending?.error));
                        input.addEventListener(choices ? "change" : "input", () => {
                            if (input.disabled || this.view.state.readOnly) return;
                            input.setCustomValidity("");
                            if (date) input.setAttribute("aria-invalid", "false");
                            try {
                                let next: unknown = input.value;
                                if (date && input.value && !parseDateValue(input.value))
                                    throw new Error(t("Enter a valid date (YYYY-MM-DD)."));
                                if (choices) {
                                    if (!input.value || input.value === "unknown") return;
                                    next = choices[Number(input.value)];
                                } else if (numeric) {
                                    next = JSON.parse(input.value);
                                    if (
                                        typeof next !== "number" ||
                                        !Number.isFinite(next) ||
                                        (field.type === "integer" && !Number.isSafeInteger(next))
                                    )
                                        throw new Error(t("Enter a valid number."));
                                } else if (json) next = JSON.parse(input.value);
                                const source = this.view.state.doc.toString();
                                const content = setSubformatValue(source, format, fieldPath, next);
                                this.view.dispatch({
                                    ...(content !== source
                                        ? {
                                              changes: {
                                                  from: 0,
                                                  to: source.length,
                                                  insert: content,
                                              },
                                          }
                                        : {}),
                                    effects: setInput.of({ path: JSON.stringify(fieldPath) }),
                                    annotations: isolateHistory.of("full"),
                                    userEvent: "input.form",
                                });
                            } catch (error) {
                                const message =
                                    error instanceof Error ? error.message : String(error);
                                input.setCustomValidity(message);
                                this.view.dispatch({
                                    effects: setInput.of({
                                        path: JSON.stringify(fieldPath),
                                        draft: { value: input.value, error: message },
                                    }),
                                });
                                if (date) input.setAttribute("aria-invalid", "true");
                                else input.reportValidity();
                            }
                        });
                        label.append(input);
                        if (typeof field.description === "string") {
                            const description = document.createElement("small");
                            description.id = `${input.id}-description`;
                            description.textContent = field.description;
                            input.setAttribute("aria-describedby", description.id);
                            label.append(description);
                        }
                        host.append(label);
                    }
                }
            },
        ),
    ];
};
