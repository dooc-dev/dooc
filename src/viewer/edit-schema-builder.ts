import { isolateHistory } from "@codemirror/commands";
import { type EditorState, StateEffect, StateField } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import {
    formatSchemaChoices,
    parseFieldSchema,
    parseSchemaParameter,
    renameSchemaField,
    type SchemaObject,
    schemaChoices,
    schemaConstraints,
    schemaFieldNamesLocked,
    schemaJsonParameters,
    schemaKeyword,
    schemaObject,
    schemaTypes,
    setSchemaType,
} from "../core/schema-fields.js";
import { t } from "./i18n.js";
import { mountSelectPickers } from "./language-picker.js";
import { showSubformatError } from "./subformats-ui.js";

const setMode = StateEffect.define<"json" | "build">();
const modeState = StateField.define<"json" | "build">({
    create: () => "build",
    update: (mode, transaction) =>
        transaction.effects.find((effect) => effect.is(setMode))?.value ?? mode,
});
type FieldDraft = { id: string; name: string; schema: SchemaObject };
const setDrafts = StateEffect.define<Map<string, FieldDraft>>();
const fieldDrafts = StateField.define<Map<string, FieldDraft>>({
    create: () => new Map(),
    update: (drafts, transaction) =>
        transaction.effects.find((effect) => effect.is(setDrafts))?.value ?? drafts,
});
export const hasSchemaBuilderDraft = (state?: EditorState): boolean =>
    !!state?.field(fieldDrafts, false)?.size;
const builders = new Set<SchemaBuilder>();
let draftId = 0;
const at = (root: SchemaObject, path: string[]): SchemaObject => {
    let value: unknown = root;
    for (const key of path)
        value = schemaObject(value) && Object.hasOwn(value, key) ? value[key] : undefined;
    if (!schemaObject(value)) throw new Error("The schema changed. Try again.");
    return value;
};
const button = (label: string, action: () => void): HTMLButtonElement => {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = t(label);
    element.addEventListener("click", action);
    return element;
};
const label = (name: string, input: HTMLElement): HTMLLabelElement => {
    const element = document.createElement("label");
    const caption = document.createElement("span");
    caption.textContent = t(name);
    if (input instanceof HTMLSelectElement) {
        element.className = "subformat-control schema-type-control";
        caption.className = "subformat-control-label";
    }
    element.append(caption, input);
    return element;
};

const icon = (paths: string): string =>
    `<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const removeIcon = icon('<path d="m5 5 10 10M15 5 5 15"/>');
const parameterPairs = [
    ["minLength", "maxLength"],
    ["minimum", "maximum"],
    ["exclusiveMinimum", "exclusiveMaximum"],
    ["minItems", "maxItems"],
    ["minProperties", "maxProperties"],
];
let pickerId = 0;

class SchemaBuilder {
    private drafts: Map<string, FieldDraft>;
    private toolbar = document.createElement("button");
    private panel = document.createElement("div");
    private expanded = new Set<string>();
    private parameters = new Set<string>();
    private disposePickers?: () => void;
    private disposed = false;
    private host?: HTMLElement;
    constructor(readonly view: EditorView) {
        this.drafts = view.state.field(fieldDrafts);
        builders.add(this);
        this.toolbar.className = "pbtn schema-mode-switch";
        this.toolbar.type = "button";
        this.toolbar.setAttribute("aria-label", t("Build kit"));
        this.toolbar.addEventListener("click", () => {
            const invalid = this.panel.querySelector<HTMLInputElement>(":invalid");
            if (!this.panel.hidden && invalid) {
                invalid.reportValidity();
                return;
            }
            const mode = this.panel.hidden ? "build" : "json";
            if (mode === "json" && !this.prepare()) return;
            if (mode === "build") {
                try {
                    parseFieldSchema(this.view.state.doc.toString());
                } catch (error) {
                    showSubformatError(error);
                    return;
                }
            }
            this.view.dispatch({ effects: setMode.of(mode) });
            if (mode === "json") this.view.focus();
        });
        this.panel.className = "schema-builder";
        this.panel.setAttribute("aria-label", "Build kit");
        this.panel.addEventListener("keydown", (event) => {
            if (
                event.key === "Enter" &&
                !event.defaultPrevented &&
                event.target instanceof HTMLInputElement
            ) {
                event.preventDefault();
                event.target.blur();
            }
        });
        queueMicrotask(() => {
            if (this.disposed) return;
            this.host = view.dom.parentElement ?? undefined;
            this.host?.classList.add("schema-editor-host");
            const heading =
                view.dom.closest("#file-editor") && document.querySelector(".file-editor-heading");
            if (heading) heading.append(this.toolbar);
            else this.host?.prepend(this.toolbar);
            this.host?.insertBefore(this.panel, view.dom);
            this.render();
        });
    }
    update(update: ViewUpdate): void {
        this.drafts = update.state.field(fieldDrafts);
        if (update.docChanged && !update.transactions.some((tr) => tr.isUserEvent("input.schema")))
            this.render();
        else if (update.state.field(modeState) !== update.startState.field(modeState))
            this.render();
    }
    destroy(): void {
        builders.delete(this);
        this.disposed = true;
        this.disposePickers?.();
        this.toolbar.remove();
        this.panel.remove();
        this.host?.classList.remove("schema-editor-host");
        this.view.dom.hidden = false;
    }
    private change(action: (root: SchemaObject) => void, focus?: string): boolean {
        const invalid = this.panel.querySelector<HTMLInputElement>(":invalid");
        if (invalid) {
            invalid.reportValidity();
            return false;
        }
        const previousDrafts = this.drafts;
        this.drafts = structuredClone(this.drafts);
        try {
            const source = this.view.state.doc.toString();
            const root = parseFieldSchema(source);
            const before = JSON.stringify(root);
            action(root);
            const eol = source.includes("\r\n") ? "\r\n" : "\n";
            const content = `${JSON.stringify(root, null, 2)}\n`.replace(/\n/g, eol);
            parseFieldSchema(content);
            for (const draft of this.drafts.values())
                parseFieldSchema(JSON.stringify({ properties: { draft: draft.schema } }));
            this.view.dispatch({
                ...(JSON.stringify(root) !== before
                    ? { changes: { from: 0, to: this.view.state.doc.length, insert: content } }
                    : {}),
                effects: setDrafts.of(this.drafts),
                annotations: isolateHistory.of("full"),
                userEvent: "input.schema",
            });
            this.render(focus);
            return true;
        } catch (error) {
            this.drafts = previousDrafts;
            showSubformatError(error);
            return false;
        }
    }
    private at(root: SchemaObject, path: string[]): SchemaObject {
        if (path[0] !== "@draft") return at(root, path);
        const draft = [...this.drafts.values()].find((draft) => draft.id === path[1]);
        if (!draft) throw new Error("The schema changed. Try again.");
        return at(draft.schema, path.slice(2));
    }
    private movePath(from: string[], to: string[]): void {
        const prefix = JSON.stringify(from).slice(0, -1);
        const next = JSON.stringify(to).slice(0, -1);
        const move = (key: string) =>
            key.startsWith(prefix) ? next + key.slice(prefix.length) : key;
        this.drafts = new Map([...this.drafts].map(([key, draft]) => [move(key), draft]));
        this.expanded = new Set([...this.expanded].map(move));
        this.parameters = new Set([...this.parameters].map(move));
    }
    private discardDrafts(path: string[]): void {
        const prefixes = [JSON.stringify(path).slice(0, -1)];
        for (const [key, draft] of this.drafts) {
            if (!prefixes.some((prefix) => key.startsWith(prefix))) continue;
            this.drafts.delete(key);
            prefixes.push(JSON.stringify(["@draft", draft.id]).slice(0, -1));
        }
    }
    private setType(root: SchemaObject, path: string[], type: string): void {
        const schema = this.at(root, path);
        const prefix = JSON.stringify(path).slice(0, -1);
        if (schema.type !== type && [...this.drafts.keys()].some((key) => key.startsWith(prefix)))
            throw new Error("Finish or remove nested fields before changing the type.");
        setSchemaType(schema, type);
    }
    prepare(): boolean {
        if (this.panel.hidden && !this.drafts.size) return true;
        if (this.panel.hidden && this.drafts.size)
            this.view.dispatch({ effects: setMode.of("build") });
        try {
            const root = parseFieldSchema(this.view.state.doc.toString());
            for (const [key, draft] of this.drafts) {
                const parent = this.at(root, JSON.parse(key));
                const message = !draft.name.trim()
                    ? t("Enter a field name.")
                    : schemaObject(parent.properties) &&
                        Object.hasOwn(parent.properties, draft.name)
                      ? t("A field with this name already exists.")
                      : "";
                const input = this.panel.querySelector<HTMLInputElement>(
                    `[data-schema-focus="${CSS.escape(`${key}:add`)}"]`,
                );
                input?.setCustomValidity(message);
                if (message) input?.setAttribute("aria-invalid", "true");
            }
            const invalid = this.panel.querySelector<HTMLInputElement>(":invalid");
            if (invalid) {
                for (
                    let parent = invalid.parentElement;
                    parent && parent !== this.panel;
                    parent = parent.parentElement
                ) {
                    if (!parent.classList.contains("schema-field-details")) continue;
                    parent.hidden = false;
                    const field = parent.parentElement;
                    if (field?.dataset.schemaField) this.expanded.add(field.dataset.schemaField);
                    field?.querySelector(".schema-expand")?.setAttribute("aria-expanded", "true");
                }
                invalid.focus();
                invalid.reportValidity();
                return false;
            }
            if (!this.drafts.size) return true;
            return this.change((root) => {
                for (const [key, draft] of [...this.drafts].reverse())
                    this.addDraft(root, JSON.parse(key), draft);
            });
        } catch (error) {
            showSubformatError(error);
            return false;
        }
    }
    private addDraft(root: SchemaObject, path: string[], draft: FieldDraft): void {
        const object = this.at(root, path);
        object.type = "object";
        object.properties ??= {};
        if (!draft.name.trim() || Object.hasOwn(at(object, ["properties"]), draft.name))
            throw new Error("Enter a unique field name.");
        Object.defineProperty(at(object, ["properties"]), draft.name, {
            value: draft.schema,
            enumerable: true,
            writable: true,
            configurable: true,
        });
        this.movePath(["@draft", draft.id], [...path, "properties", draft.name]);
        this.drafts.delete(JSON.stringify(path));
    }
    private render(focus?: string): void {
        if (!this.host || this.disposed) return;
        const scroll = this.panel.scrollTop;
        const active =
            document.activeElement instanceof HTMLElement &&
            this.panel.contains(document.activeElement)
                ? document.activeElement.dataset.schemaFocus
                : undefined;
        let root: SchemaObject | undefined;
        try {
            root = parseFieldSchema(this.view.state.doc.toString());
        } catch {
            /* Incomplete JSON remains editable as text. */
        }
        const mode = root ? this.view.state.field(modeState) : "json";
        this.view.dom.hidden = mode === "build";
        this.panel.hidden = mode === "json";
        this.toolbar.dataset.schemaMode = mode;
        this.toolbar.setAttribute("aria-pressed", String(mode === "build"));
        this.toolbar.title = `${t("Schema editing mode")}: ${t(mode === "build" ? "Build kit" : "JSON text")} → ${t(mode === "build" ? "JSON text" : "Build kit")}`;
        this.toolbar.innerHTML = `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
            mode === "build"
                ? '<rect x="3" y="3" width="4" height="4" rx="1"/><rect x="3" y="12" width="4" height="4" rx="1"/><path d="M11 5h6M11 14h6"/>'
                : '<path d="M7 3H5v5l-2 2 2 2v5h2M13 3h2v5l2 2-2 2v5h-2"/>'
        }</svg>`;
        if (mode === "json" || !root) {
            this.view.requestMeasure();
            return;
        }
        this.disposePickers?.();
        this.panel.replaceChildren();
        const locked = schemaFieldNamesLocked(root);
        this.panel.inert = this.view.state.readOnly;
        const objectRoot = root.type === "object" || (root.type === undefined && !root.$ref);
        if (objectRoot) this.properties(root, [], this.panel, locked);
        const settings = document.createElement("details");
        settings.className = "schema-root-settings";
        const summary = document.createElement("summary");
        summary.textContent = t("Schema settings");
        settings.open = !objectRoot || this.expanded.has("[]");
        settings.addEventListener("toggle", () => {
            if (settings.open) this.expanded.add("[]");
            else this.expanded.delete("[]");
        });
        const menus = document.createElement("div");
        menus.className = "schema-field-name";
        menus.append(this.parameterMenu(root, [], t("Schema settings")));
        settings.append(summary, menus);
        settings.append(label("Type", this.typeSelect(root, [])));
        this.settings(root, [], settings, locked, !objectRoot);
        this.panel.append(settings);
        const selects = [...this.panel.querySelectorAll("select")];
        for (const select of selects) {
            select.id = `schema-type-${++pickerId}`;
            select.dataset.placeholder = t("Type");
        }
        this.disposePickers = mountSelectPickers(t, selects);
        for (const select of selects) {
            const input =
                select.parentElement?.querySelector<HTMLInputElement>(".language-select-input");
            if (input && select.dataset.schemaFocus)
                input.dataset.schemaFocus = select.dataset.schemaFocus;
        }
        this.panel.scrollTop = scroll;
        const key = focus ?? active;
        if (key)
            this.panel
                .querySelector<HTMLElement>(
                    `[data-schema-focus="${CSS.escape(key)}"]:not([hidden])`,
                )
                ?.focus({ preventScroll: true });
        this.view.requestMeasure();
    }
    private typeSelect(schema: SchemaObject, path: string[]): HTMLSelectElement {
        const select = document.createElement("select");
        select.setAttribute("aria-label", t("Type"));
        select.dataset.schemaFocus = `${JSON.stringify(path)}:type`;
        const simple =
            schema.type === undefined ||
            (typeof schema.type === "string" && schemaTypes.includes(schema.type));
        select.add(new Option(t("Any type"), ""));
        if (!simple)
            select.add(
                new Option(
                    Array.isArray(schema.type) ? schema.type.join(" | ") : "JSON",
                    "current",
                ),
            );
        for (const type of schemaTypes) select.add(new Option(type, type));
        select.value = simple ? String(schema.type ?? "") : "current";
        select.addEventListener("change", () => {
            const value = select.value;
            if (value === "current") return;
            this.expanded.add(JSON.stringify(path));
            if (!this.change((root) => this.setType(root, path, value), select.dataset.schemaFocus))
                select.value = simple ? String(schema.type ?? "") : "current";
        });
        return select;
    }
    private field(
        schema: unknown,
        path: string[],
        name: string,
        nameControl: HTMLElement,
        controls: HTMLElement[],
        locked: boolean,
    ): HTMLElement {
        const key = JSON.stringify(path);
        const field = document.createElement("section");
        field.className = "schema-field";
        field.dataset.schemaField = key;
        const row = document.createElement("div");
        row.className = "schema-field-row";
        const details = document.createElement("div");
        details.className = "schema-field-details";
        details.hidden = !this.expanded.has(key);
        const expand = button("", () => {
            details.hidden = !details.hidden;
            if (details.hidden) this.expanded.delete(key);
            else this.expanded.add(key);
            expand.setAttribute("aria-expanded", String(!details.hidden));
        });
        expand.className = "schema-expand";
        expand.setAttribute("aria-label", `${t("Field settings")}: ${name}`);
        expand.setAttribute("aria-expanded", String(!details.hidden));
        expand.innerHTML = icon('<path d="m5 7 5 5 5-5"/>');
        const actions = document.createElement("div");
        actions.className = "schema-field-actions";
        const heading = document.createElement("div");
        heading.className = "schema-field-name";
        heading.append(nameControl);
        if (controls[0]) heading.append(controls[0]);
        if (schemaObject(schema)) {
            heading.append(this.parameterMenu(schema, path, name));
            this.settings(schema, path, details, locked);
        } else {
            details.append(
                button("JSON text", () => this.view.dispatch({ effects: setMode.of("json") })),
            );
        }
        expand.disabled = !details.childElementCount;
        if (controls[1]) actions.append(controls[1]);
        actions.append(expand);
        row.append(
            heading,
            label("Type", this.typeSelect(schemaObject(schema) ? schema : {}, path)),
            actions,
        );
        field.append(row, details);
        return field;
    }
    private properties(
        parent: SchemaObject,
        path: string[],
        host: HTMLElement,
        locked: boolean,
    ): void {
        const properties = schemaObject(parent.properties) ? parent.properties : {};
        for (const [name, schema] of Object.entries(properties)) {
            const fieldPath = [...path, "properties", name];
            const key = JSON.stringify(fieldPath);
            const input = document.createElement("input");
            input.value = name;
            input.setAttribute("aria-label", t("Field name"));
            input.dataset.schemaFocus = `${key}:name`;
            input.readOnly = locked;
            if (locked) input.title = t("Rename linked fields in JSON text.");
            input.addEventListener("change", () => {
                const next = input.value;
                if (
                    !this.change(
                        (root) => {
                            renameSchemaField(this.at(root, path), name, next);
                            this.movePath(fieldPath, [...path, "properties", next]);
                        },
                        `${JSON.stringify([...path, "properties", next])}:name`,
                    )
                )
                    input.setCustomValidity(t("Enter a unique field name."));
            });
            input.addEventListener("input", () => input.setCustomValidity(""));
            const required = document.createElement("input");
            required.type = "checkbox";
            required.title = t("Required");
            required.setAttribute("aria-label", t("Required"));
            required.checked = Array.isArray(parent.required) && parent.required.includes(name);
            required.dataset.schemaFocus = `${key}:required`;
            required.addEventListener("change", () =>
                this.change((root) => {
                    const object = this.at(root, path);
                    const names = new Set(Array.isArray(object.required) ? object.required : []);
                    if (required.checked) names.add(name);
                    else names.delete(name);
                    if (names.size) object.required = [...names];
                    else delete object.required;
                }),
            );
            const requiredLabel = label("Required", required);
            requiredLabel.className = "schema-required";
            const remove = button("", () =>
                this.change(
                    (root) => {
                        const object = this.at(root, path);
                        delete at(object, ["properties"])[name];
                        this.discardDrafts(fieldPath);
                        if (Array.isArray(object.required)) {
                            const names = object.required.filter((value) => value !== name);
                            if (names.length) object.required = names;
                            else delete object.required;
                        }
                    },
                    `${JSON.stringify(path)}:add`,
                ),
            );
            remove.title = `${t("Remove field")}: ${name}`;
            remove.setAttribute("aria-label", remove.title);
            remove.innerHTML = removeIcon;
            remove.disabled = locked;
            host.append(
                this.field(
                    schema,
                    fieldPath,
                    name,
                    label("Field name", input),
                    [requiredLabel, remove],
                    locked,
                ),
            );
        }
        const add = document.createElement("div");
        add.className = "schema-add-field";
        const key = JSON.stringify(path);
        const draft = this.drafts.get(key) ?? {
            id: String(++draftId),
            name: "",
            schema: { type: "string" },
        };
        const draftPath = ["@draft", draft.id];
        const name = document.createElement("input");
        name.value = draft.name;
        name.setAttribute("aria-label", t("New field name"));
        name.placeholder = t("Field name");
        name.dataset.schemaFocus = `${JSON.stringify(path)}:add`;
        name.setAttribute("aria-required", String(this.drafts.has(key)));
        const type = document.createElement("select");
        type.setAttribute("aria-label", t("New field type"));
        type.add(new Option(t("Any type"), ""));
        for (const value of schemaTypes) type.add(new Option(value, value));
        type.value = String(draft.schema.type ?? "");
        type.dataset.schemaFocus = `${JSON.stringify(draftPath)}:type`;
        type.addEventListener("change", () => {
            const value = type.value;
            if (
                !this.change((root) => {
                    const next = this.drafts.get(key) ?? structuredClone(draft);
                    this.drafts.set(key, next);
                    this.setType(root, draftPath, value);
                }, type.dataset.schemaFocus)
            )
                type.value = String(draft.schema.type ?? "");
        });
        const create = () => {
            const value = name.value;
            if (!value.trim() || Object.hasOwn(properties, value)) {
                name.setCustomValidity(
                    t(
                        !value.trim()
                            ? "Enter a field name."
                            : "A field with this name already exists.",
                    ),
                );
                name.reportValidity();
                return;
            }
            this.change((root) => {
                const next = this.drafts.get(key) ?? structuredClone(draft);
                next.name = value;
                setSchemaType(next.schema, type.value);
                this.addDraft(root, path, next);
            }, name.dataset.schemaFocus);
        };
        name.addEventListener("input", () => {
            name.setCustomValidity("");
            name.removeAttribute("aria-invalid");
            name.setAttribute("aria-required", "true");
            this.drafts = new Map(this.drafts);
            this.drafts.set(key, { ...(this.drafts.get(key) ?? draft), name: name.value });
            this.view.dispatch({ effects: setDrafts.of(this.drafts) });
        });
        name.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                create();
            }
        });
        const addActions = document.createElement("div");
        addActions.className = "schema-add-actions";
        const createButton = button("Add field", create);
        createButton.dataset.schemaAdd = "";
        addActions.append(createButton);
        if (this.drafts.has(key)) {
            const cancel = button("Cancel", () => {
                this.drafts = new Map(this.drafts);
                this.discardDrafts(draftPath);
                this.drafts.delete(key);
                this.view.dispatch({ effects: setDrafts.of(this.drafts) });
                this.render(name.dataset.schemaFocus);
            });
            cancel.setAttribute("aria-label", t("Cancel"));
            addActions.append(cancel);
        }
        const heading = document.createElement("div");
        heading.className = "schema-field-name";
        heading.append(label("Field name", name));
        heading.append(
            this.parameterMenu(draft.schema, draftPath, t("New field name"), () => {
                if (this.drafts.has(key)) return;
                this.drafts = new Map(this.drafts);
                this.drafts.set(key, structuredClone(draft));
                this.view.dispatch({ effects: setDrafts.of(this.drafts) });
            }),
        );
        add.append(heading, label("Type", type), addActions);
        host.append(add);
        if (this.drafts.has(key)) {
            const details = document.createElement("div");
            details.className = "schema-field-details schema-draft-details";
            this.settings(draft.schema, draftPath, details, false);
            host.append(details);
        }
        if (!path.length) {
            const extra = document.createElement("input");
            extra.type = "checkbox";
            extra.checked = parent.additionalProperties !== false;
            extra.disabled = schemaObject(parent.additionalProperties);
            extra.addEventListener("change", () =>
                this.change((root) => {
                    root.additionalProperties = extra.checked;
                }),
            );
            const extraLabel = label("Allow extra fields", extra);
            extraLabel.className = "schema-extra-fields";
            host.append(extraLabel);
        }
    }
    private parameterKeys(schema: SchemaObject): string[] {
        return [
            ...(schemaConstraints[String(schema.type)] ?? []),
            ...(schema.type === "string" ? ["format"] : []),
            ...(schema.type === "object" && !schemaObject(schema.additionalProperties)
                ? ["additionalProperties"]
                : []),
            "enum",
            "const",
            "$ref",
            "$defs",
            "oneOf",
            "anyOf",
            "allOf",
            "not",
            "$id",
            "$anchor",
            "title",
            "description",
            "default",
            "examples",
            "readOnly",
            "writeOnly",
            "deprecated",
        ];
    }
    private parameterMenu(
        schema: SchemaObject,
        path: string[],
        name: string,
        prepare?: () => void,
    ): HTMLElement {
        const host = document.createElement("div");
        const popup = document.createElement("div");
        popup.className = "schema-parameter-menu language-picker";
        popup.popover = "auto";
        popup.setAttribute("role", "menu");
        popup.setAttribute("aria-label", t("Parameters"));
        const menu = document.createElement("div");
        menu.className = "language-options";
        const trigger = button("", () => {
            const invalid = this.panel.querySelector<HTMLInputElement>(":invalid");
            if (invalid) {
                invalid.reportValidity();
                return;
            }
            if (popup.matches(":popover-open")) {
                popup.hidePopover();
                return;
            }
            trigger.focus();
            popup.showPopover();
            const rect = trigger.getBoundingClientRect();
            popup.style.left = `${Math.max(8, Math.min(rect.right - popup.offsetWidth, innerWidth - popup.offsetWidth - 8))}px`;
            popup.style.top = `${rect.bottom + 4}px`;
            popup.style.maxHeight = `${Math.max(60, innerHeight - rect.bottom - 12)}px`;
            menu.querySelector<HTMLElement>("button")?.focus();
        });
        trigger.title = `${t("Parameters")}: ${name}`;
        trigger.setAttribute("aria-label", trigger.title);
        trigger.setAttribute("aria-haspopup", "menu");
        trigger.setAttribute("aria-expanded", "false");
        trigger.dataset.schemaMenu = "Parameters";
        trigger.innerHTML = icon('<path d="M10 4v12M4 10h12"/>');
        const visible = this.visibleParameters(schema, path);
        for (const key of this.parameterKeys(schema)) {
            const focus = `${JSON.stringify(path)}:${key}`;
            if (visible.includes(key)) continue;
            const item = button(key, () => {
                prepare?.();
                this.parameters.add(focus);
                this.expanded.add(JSON.stringify(path));
                popup.hidePopover();
                this.render(focus);
            });
            item.setAttribute("role", "menuitem");
            menu.append(item);
        }
        trigger.disabled = !menu.childElementCount;
        popup.addEventListener("toggle", () =>
            trigger.setAttribute("aria-expanded", String(popup.matches(":popover-open"))),
        );
        popup.addEventListener("keydown", (event) => {
            const items = [...menu.querySelectorAll<HTMLButtonElement>("button")];
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                items[
                    (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length
                ]?.focus();
            }
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                popup.hidePopover();
                trigger.focus();
            }
        });
        popup.append(menu);
        host.append(trigger, popup);
        return host;
    }
    private visibleParameters(schema: SchemaObject, path: string[]): string[] {
        return this.parameterKeys(schema).filter(
            (key) =>
                Object.hasOwn(schema, key) || this.parameters.has(`${JSON.stringify(path)}:${key}`),
        );
    }
    private range(row: HTMLElement): void {
        const [minimum, maximum] = row.querySelectorAll<HTMLInputElement>('input[type="number"]');
        if (!minimum || !maximum) return;
        const inputs = [minimum, maximum] as const;
        const values = inputs.map((input) => (input.value ? Number(input.value) : undefined));
        const low = values[0] ?? Math.min(0, (values[1] ?? 10) - 10);
        const high = values[1] ?? Math.max(10, low + 10);
        const padding = Math.max(1, (high - low) / 2);
        const min = Math.max(
            Number(inputs[0].min || -Number.MAX_SAFE_INTEGER),
            Math.floor(low - padding),
        );
        const max = Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(high + padding));
        const track = document.createElement("div");
        track.className = "schema-range-track";
        const selection = document.createElement("span");
        selection.setAttribute("aria-hidden", "true");
        selection.hidden = low > high;
        track.append(selection);
        row.classList.add("schema-range");
        row.setAttribute("role", "group");
        row.setAttribute(
            "aria-label",
            inputs.map((input) => input.dataset.schemaKeyword).join(" / "),
        );
        const paint = () => {
            for (const [index, input] of inputs.entries()) {
                const value = input.value ? Number(input.value) : index === 0 ? min : max;
                track.style.setProperty(
                    index === 0 ? "--range-min" : "--range-max",
                    String((value - min) / (max - min) || 0),
                );
            }
        };
        inputs.forEach((input, index) => {
            input.placeholder = index === 0 ? input.min || "−∞" : "∞";
            const slider = document.createElement("input");
            slider.type = "range";
            slider.min = String(min);
            slider.max = String(max);
            slider.step = input.step;
            slider.value = String(values[index] ?? (index === 0 ? min : max));
            slider.disabled = low > high || min >= max;
            slider.setAttribute("aria-label", input.dataset.schemaKeyword ?? "");
            slider.dataset.schemaFocus = `${input.dataset.schemaFocus}:range`;
            slider.addEventListener("input", () => {
                const other = inputs[index === 0 ? 1 : 0];
                if (other.value)
                    slider.value = String(
                        index === 0
                            ? Math.min(Number(slider.value), Number(other.value))
                            : Math.max(Number(slider.value), Number(other.value)),
                    );
                input.value = slider.value;
                input.dispatchEvent(new Event("input", { bubbles: true }));
                paint();
            });
            slider.addEventListener("change", () =>
                input.dispatchEvent(new Event("change", { bubbles: true })),
            );
            track.append(slider);
        });
        paint();
        row.append(track);
    }
    private settings(
        schema: SchemaObject,
        path: string[],
        host: HTMLElement,
        locked: boolean,
        children = true,
    ): void {
        const keys = this.visibleParameters(schema, path);
        if (keys.length) {
            const group = document.createElement("section");
            group.className = "schema-parameter-group";
            group.setAttribute("aria-label", t("Parameters"));
            const fields = document.createElement("div");
            fields.className = "schema-parameters";
            const rows = new Map<string, HTMLElement>();
            for (const key of keys) {
                const focus = `${JSON.stringify(path)}:${key}`;
                const rule = schemaKeyword(key);
                const json = schemaJsonParameters.includes(key);
                const input =
                    json || ["description", "enum"].includes(key)
                        ? document.createElement("textarea")
                        : document.createElement("input");
                const numeric = rule.type === "number" || rule.type === "integer";
                if (input instanceof HTMLInputElement) {
                    input.type =
                        rule.type === "boolean" || key === "additionalProperties"
                            ? "checkbox"
                            : numeric
                              ? "number"
                              : "text";
                    if (numeric) {
                        input.step = rule.type === "integer" ? "1" : "any";
                        if (typeof rule.minimum === "number") input.min = String(rule.minimum);
                    }
                    if (input.type === "checkbox") input.checked = schema[key] === true;
                } else input.rows = 2;
                input.value =
                    key === "enum" && Array.isArray(schema.enum)
                        ? formatSchemaChoices(schema.enum, schema.type)
                        : json
                          ? Object.hasOwn(schema, key)
                              ? JSON.stringify(schema[key], null, 2)
                              : ""
                          : schema[key] == null
                            ? ""
                            : String(schema[key]);
                if (input instanceof HTMLTextAreaElement)
                    input.rows = Math.min(12, Math.max(2, input.value.split("\n").length));
                input.dataset.schemaFocus = focus;
                input.dataset.schemaKeyword = key;
                if (key === "enum") {
                    input.title = t(
                        'One choice per line. Use "" for empty text, "a\\nb" for multiline text, and JSON for other types.',
                    );
                    input.placeholder = schema.type === "string" ? 'Todo\nDone\n""' : "1\n2";
                } else if (json)
                    input.placeholder = ["oneOf", "anyOf", "allOf"].includes(key)
                        ? '[{"type":"string"}, {"type":"number"}]'
                        : key === "$defs"
                          ? '{"name":{"type":"string"}}'
                          : '"value"';
                else if (key === "$ref") input.placeholder = "./common.schema.json#/$defs/name";
                input.addEventListener("input", () => input.setCustomValidity(""));
                input.addEventListener("change", () => {
                    if (
                        input.value &&
                        typeof rule.exclusiveMinimum === "number" &&
                        Number(input.value) <= rule.exclusiveMinimum
                    )
                        input.setCustomValidity(
                            t("Enter a value greater than {minimum}.", {
                                minimum: rule.exclusiveMinimum,
                            }),
                        );
                    if (!input.checkValidity()) {
                        input.reportValidity();
                        return;
                    }
                    const changed = this.change((root) => {
                        const target = this.at(root, path);
                        if (input instanceof HTMLInputElement && input.type === "checkbox")
                            target[key] = input.checked;
                        else if (!input.value) delete target[key];
                        else if (key === "enum")
                            target.enum = schemaChoices(input.value, schema.type);
                        else if (json)
                            target[key] = parseSchemaParameter(key, input.value, schema.type);
                        else target[key] = numeric ? Number(input.value) : input.value;
                    });
                    if (!changed) input.setCustomValidity(t("Check the parameter value."));
                });
                const parameter = document.createElement("div");
                parameter.className = "schema-parameter";
                const pair = parameterPairs.find((pair) => pair.includes(key));
                if (pair) parameter.dataset.schemaBound = pair[0] === key ? "min" : "max";
                const rowKey = pair?.[0] ?? key;
                let row = rows.get(rowKey);
                if (!row) {
                    row = document.createElement("div");
                    row.className = "schema-parameter-row";
                    rows.set(rowKey, row);
                    fields.append(row);
                }
                const remove = button("", () => {
                    const invalid = this.panel.querySelector<HTMLInputElement>(":invalid");
                    if (invalid && invalid !== input) {
                        invalid.reportValidity();
                        return;
                    }
                    input.value = "";
                    input.setCustomValidity("");
                    this.parameters.delete(focus);
                    if (Object.hasOwn(schema, key))
                        this.change((root) => {
                            delete this.at(root, path)[key];
                        });
                    else this.render();
                });
                remove.setAttribute("aria-label", `${t("Remove parameter")}: ${key}`);
                remove.hidden =
                    !!pair && !Object.hasOwn(schema, key) && !this.parameters.has(focus);
                remove.innerHTML = removeIcon;
                const control = label(key === "enum" ? "Choices (one per line)" : key, input);
                if (key === "enum") {
                    const hint = document.createElement("small");
                    hint.className = "schema-parameter-help";
                    hint.id = `schema-help-${++pickerId}`;
                    hint.textContent = input.title;
                    input.setAttribute("aria-describedby", hint.id);
                    control.append(hint);
                }
                parameter.append(control, remove);
                row.append(parameter);
            }
            for (const row of rows.values())
                if (row.querySelector("[data-schema-bound]")) this.range(row);
            group.append(fields);
            host.append(group);
        }
        if (
            children &&
            (schema.type === "object" || (schema.type === "array" && schemaObject(schema.items)))
        ) {
            const nested = document.createElement("div");
            nested.className = "schema-children";
            if (schema.type === "object") this.properties(schema, path, nested, locked);
            else {
                const name = document.createElement("span");
                name.className = "schema-item-name";
                name.textContent = t("Items");
                nested.append(
                    this.field(schema.items, [...path, "items"], "items", name, [], locked),
                );
            }
            host.append(nested);
        }
        const handled = [
            "type",
            "properties",
            "required",
            "items",
            "$schema",
            ...this.parameterKeys(schema),
        ];
        if (Object.keys(schema).some((key) => !handled.includes(key))) {
            const note = document.createElement("p");
            note.className = "schema-json-note";
            note.textContent = t("Additional rules are preserved in JSON text.");
            host.append(note);
        }
    }
}

export const prepareSchemaBuilder = (state: EditorState): boolean => {
    const builder = [...builders].find((builder) => builder.view.state === state);
    return builder ? builder.prepare() : !hasSchemaBuilderDraft(state);
};
export const schemaBuilder = [modeState, fieldDrafts, ViewPlugin.fromClass(SchemaBuilder)];
