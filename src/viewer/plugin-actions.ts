import {
    type PluginAction,
    type PluginActionField,
    type PluginActionRequest,
    type PluginActionResult,
    validatePluginActions,
} from "../plugins/actions.js";
import type { PluginEdit } from "../plugins/blocks.js";
import { confirmDialog } from "./edit-dialog.js";
import { t } from "./i18n.js";

const node = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text = "",
    cls = "",
): HTMLElementTagNameMap[K] => {
    const element = document.createElement(tag);
    element.textContent = text;
    element.className = cls;
    return element;
};
const button = (label: string, click: () => void, cls = "plugin-block-button") => {
    const element = node("button", label, cls);
    element.type = "button";
    element.addEventListener("click", click);
    return element;
};
interface Draft {
    id: string;
    fields: string[];
    values: Record<string, string>;
    original: Record<string, string>;
    version?: string;
}
interface Editor extends Draft {
    form: HTMLFormElement;
    close: () => void;
    notice: HTMLElement;
}

export const mountPluginActions = (
    section: HTMLElement,
    api: (
        action: string,
        payload?: Record<string, unknown>,
    ) => Promise<{ actions?: PluginAction[]; result?: PluginActionResult }>,
    refreshView: () => Promise<void>,
    current: () => boolean,
): (() => void) => {
    let actions: PluginAction[] = [],
        busy = false,
        blocked = false,
        disposed = false;
    const active = () => !disposed && current();
    const editors = new Map<string, Editor>();
    const openers = new Map<string, (draft?: Draft) => void>();
    const attempts = new Map<string, { fingerprint: string; requestId: string }>();
    const toolbar = section.querySelector<HTMLElement>(".plugin-toolbar")!;
    const status = section.querySelector<HTMLElement>("[data-plugin-status]")!;
    const notice = (message: string, error = false) => {
        status.textContent = message;
        section.dataset.operationError = String(error);
    };
    const readValues = (form: HTMLFormElement): Record<string, string> => {
        const values: Record<string, string> = {};
        for (const control of form.querySelectorAll<
            HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
        >("input[name],select[name],textarea[name]"))
            values[control.name] =
                control instanceof HTMLSelectElement && control.multiple
                    ? JSON.stringify([...control.selectedOptions].map((option) => option.value))
                    : control.value;
        return values;
    };
    const drafts = () =>
        new Map(
            [...editors].map(([key, editor]) => [
                key,
                { ...editor, values: readValues(editor.form) },
            ]),
        );
    const find = (id: string) => actions.find((action) => action.id === id);
    const beforeUnload = (event: BeforeUnloadEvent) => {
        if (
            [...editors.values()].some((editor) =>
                Object.entries(readValues(editor.form)).some(
                    ([name, value]) => value !== editor.original[name],
                ),
            )
        ) {
            event.preventDefault();
        }
    };
    window.addEventListener("beforeunload", beforeUnload);

    const load = async () => {
        const data = await api("actions");
        if (!active()) return;
        actions = validatePluginActions(data.actions ?? []);
        blocked = false;
        for (const editor of editors.values()) {
            const action = find(editor.id);
            if (
                action &&
                editor.fields.every(
                    (name) =>
                        editor.original[name] ===
                        (action.fields.find((f) => f.name === name)?.value ?? ""),
                )
            )
                editor.version = action.version;
        }
    };
    const refresh = async (saved = new Map<string, Draft>()) => {
        const expanded = [
            ...section.querySelectorAll<HTMLDetailsElement>(".plugin-block-section"),
        ].map((detail) => detail.open);
        const content = section.querySelector<HTMLElement>("[data-plugin-result]")!;
        const scroll = content.scrollTop;
        await load();
        if (!active()) return;
        for (const draft of saved.values()) {
            const action = find(draft.id);
            if (
                !action ||
                draft.fields.some((name) => !action.fields.some((field) => field.name === name))
            ) {
                blocked = true;
                throw new Error(
                    t("An open draft is no longer editable. Copy or cancel it before reloading."),
                );
            }
            if (
                draft.fields.every(
                    (name) =>
                        draft.original[name] ===
                        (action.fields.find((field) => field.name === name)?.value ?? ""),
                )
            )
                draft.version = action.version;
        }
        await refreshView();
        if (!active()) return;
        editors.clear();
        bind(saved);
        [...section.querySelectorAll<HTMLDetailsElement>(".plugin-block-section")].forEach(
            (detail, i) => {
                if (expanded[i] !== undefined) detail.open = expanded[i];
            },
        );
        content.scrollTop = scroll;
    };

    const execute = async (
        action: PluginAction,
        values: Record<string, string>,
        key: string,
        editor?: Editor,
    ): Promise<void> => {
        if (busy || !active()) return;
        if (blocked) {
            notice(t("Reload actions before saving again."), true);
            return;
        }
        if (
            (action.destructive || action.confirm) &&
            !(await confirmDialog(action.target, action.label, action.destructive))
        )
            return;
        if (busy || !active()) return;
        const operation: PluginActionRequest = {
            id: action.id,
            values,
            version: editor ? editor.version : action.version,
            ...(action.destructive || action.confirm ? { confirmed: true } : {}),
        };
        const fingerprint = JSON.stringify(operation);
        const attempt = attempts.get(key);
        const requestId =
            attempt?.fingerprint === fingerprint ? attempt.requestId : crypto.randomUUID();
        attempts.set(key, { fingerprint, requestId });
        busy = true;
        section.setAttribute("aria-busy", "true");
        const controls = [
            ...section.querySelectorAll<
                HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
            >(
                ".plugin-editor button,.plugin-editor input,.plugin-editor select,.plugin-editor textarea,[data-plugin-edit-trigger],[data-block-action] button,button[data-block-action]",
            ),
        ].filter((control) => !control.disabled);
        for (const control of controls) control.disabled = true;
        if (editor) editor.notice.textContent = t("Saving…");
        let saved = false;
        try {
            const response = await api("act", { operation, requestId });
            if (!active()) return;
            saved = true;
            attempts.delete(key);
            const message = response.result?.message ?? t("Saved");
            if (response.result?.deleted) {
                for (const open of editors.values()) open.close();
                section.querySelector("[data-plugin-result]")?.replaceChildren(node("p", message));
                section.querySelector("[data-plugin-collapsed]")?.replaceChildren();
                actions = [];
                menu.hidden = true;
                notice(message);
                return;
            }
            const keep = drafts();
            keep.delete(key);
            editor?.close();
            await refresh(keep);
            if (active()) notice(message);
        } catch (error) {
            if (!active()) return;
            const message = error instanceof Error ? error.message : t("Plugin request failed");
            if (saved) {
                blocked = true;
                notice(
                    `${t("Saved, but refresh failed. Reload actions before saving again.")} ${message}`,
                    true,
                );
            } else {
                if (
                    error instanceof Error &&
                    "status" in error &&
                    [400, 401, 403, 404, 409, 422, 429].includes(Number(error.status))
                )
                    attempts.delete(key);
                if (editor) editor.notice.textContent = message;
                notice(message, true);
            }
        } finally {
            busy = false;
            if (active()) {
                section.removeAttribute("aria-busy");
                for (const control of controls) control.disabled = false;
            }
        }
    };

    const inputFor = (field: PluginActionField, value: string) => {
        const label = node("label", field.label);
        let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        if (field.type === "select" || field.type === "multiselect") {
            const select = node("select");
            select.multiple = field.type === "multiselect";
            const selected = select.multiple ? (JSON.parse(value || "[]") as string[]) : [value];
            for (const option of field.options ?? []) {
                const element = node("option", option.label);
                element.value = option.value;
                element.selected = selected.includes(option.value);
                select.append(element);
            }
            input = select;
        } else if (field.type === "textarea") {
            input = node("textarea");
            input.rows = 4;
            input.value = value;
            input.maxLength = field.maxLength ?? 4000;
        } else {
            input = node("input");
            input.type = field.type;
            input.value = value;
            input.maxLength = field.maxLength ?? 4000;
            if (field.min !== undefined) input.min = String(field.min);
            if (field.max !== undefined) input.max = String(field.max);
            if (field.type === "number") input.step = "any";
        }
        input.name = field.name;
        input.required = !!field.required;
        label.append(input);
        return label;
    };

    const openEditor = (
        action: PluginAction,
        fields: PluginActionField[],
        target: HTMLElement,
        key: string,
        display?: HTMLElement,
        draft?: Draft,
    ) => {
        if (editors.has(key) || (busy && !draft)) return;
        const form = node("form", "", "plugin-editor");
        form.dataset.pluginForm = key;
        const original = Object.fromEntries(
            fields.map((field) => [
                field.name,
                field.value ?? (field.type === "multiselect" ? "[]" : ""),
            ]),
        );
        for (const field of fields)
            form.append(inputFor(field, draft?.values[field.name] ?? original[field.name] ?? ""));
        const feedback = node("p", "", "plugin-editor-notice");
        feedback.setAttribute("role", "status");
        const controls = node("div", "", "plugin-editor-controls");
        const save = node("button", t("Save"), "plugin-block-button plugin-submit");
        save.type = "submit";
        const trigger = document.activeElement;
        const close = () => {
            form.remove();
            editors.delete(key);
            if (display) display.hidden = false;
            if (trigger instanceof HTMLElement && trigger.isConnected)
                trigger.focus({ preventScroll: true });
        };
        controls.append(
            button(t("Cancel"), () => {
                if (!busy) close();
            }),
            save,
        );
        form.append(feedback, controls);
        const editor: Editor = {
            id: action.id,
            fields: fields.map((f) => f.name),
            values: {},
            original: draft?.original ?? original,
            version: draft ? draft.version : action.version,
            form,
            close,
            notice: feedback,
        };
        editors.set(key, editor);
        if (display) display.hidden = true;
        target.append(form);
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            if (busy || !form.reportValidity()) return;
            let values = readValues(form);
            if (action.partial)
                values = Object.fromEntries(
                    Object.entries(values).filter(
                        ([name, value]) => value !== editor.original[name],
                    ),
                );
            if (action.partial && !Object.keys(values).length) {
                close();
                return;
            }
            void execute(find(action.id) ?? action, values, key, editor);
        });
        form.addEventListener("keydown", (event) => {
            if (event.isComposing) {
                if (event.key === "Enter") event.preventDefault();
                return;
            }
            if (event.key === "Escape" && !busy) {
                event.preventDefault();
                event.stopPropagation();
                close();
            }
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                form.requestSubmit();
            }
        });
        if (!draft)
            form.querySelector<HTMLElement>("input,textarea,select")?.focus({
                preventScroll: true,
            });
    };

    const menu = node("details", "", "plugin-action-menu");
    const summary = node("summary", "⋯", "plugin-action");
    summary.title = t("Actions");
    summary.setAttribute("aria-label", t("Actions"));
    const menuBody = node("div");
    menu.append(summary, menuBody);
    toolbar.append(menu);
    const reload = button(
        t("Reload"),
        () => {
            if (busy) return;
            busy = true;
            void refresh(drafts())
                .then(() => {
                    if (active()) notice(t("Updated"));
                })
                .catch((error) => {
                    if (active()) notice(String(error.message), true);
                })
                .finally(() => {
                    busy = false;
                });
        },
        "plugin-action plugin-reload",
    );
    reload.innerHTML =
        '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M16 7a6.5 6.5 0 1 0 .3 5M16 2v5h-5"/></svg>';
    reload.title = t("Reload");
    reload.setAttribute("aria-label", t("Reload"));
    toolbar.insertBefore(reload, menu);

    const bind = (saved = new Map<string, Draft>()) => {
        openers.clear();
        section.dataset.actionsReady = "true";
        menuBody.replaceChildren();
        for (const element of section.querySelectorAll<HTMLElement>("[data-block-edit]")) {
            const binding = JSON.parse(element.dataset.blockEdit!) as PluginEdit;
            const action = find(binding.action);
            if (!action) continue;
            const fields = binding.field
                ? action.fields.filter((field) => field.name === binding.field)
                : action.fields;
            if (!fields.length || (binding.field && !action.partial && action.fields.length !== 1))
                continue;
            const key = `${binding.action}@${binding.field ?? "*"}`;
            const display = node("div", "", "plugin-edit-display");
            display.append(...element.childNodes);
            element.append(display);
            display.tabIndex = 0;
            display.setAttribute("role", "button");
            display.setAttribute("aria-label", `${t("Edit")} ${fields[0]?.label}`);
            display.dataset.pluginEditTrigger = "";
            const open = (draft?: Draft) =>
                openEditor(
                    find(action.id) ?? action,
                    fields.map(
                        (field) =>
                            find(action.id)?.fields.find((f) => f.name === field.name) ?? field,
                    ),
                    element,
                    key,
                    display,
                    draft,
                );
            display.addEventListener("click", (event) => {
                if (
                    !(event.target as Element).closest("a,button") &&
                    window.getSelection()?.isCollapsed !== false
                )
                    open();
            });
            display.addEventListener("keydown", (event) => {
                if (
                    event.target === display &&
                    !event.isComposing &&
                    ["Enter", "F2"].includes(event.key)
                ) {
                    event.preventDefault();
                    open();
                }
            });
            openers.set(key, open);
        }
        for (const target of section.querySelectorAll<HTMLElement>("[data-block-action]")) {
            const id = target.dataset.blockAction!,
                action = find(id);
            if (!action) {
                if (target instanceof HTMLButtonElement) target.disabled = true;
                continue;
            }
            const key = id;
            const open = (draft?: Draft) =>
                openEditor(
                    find(id) ?? action,
                    (find(id) ?? action).fields,
                    target instanceof HTMLButtonElement ? target.parentElement! : target,
                    key,
                    undefined,
                    draft,
                );
            const click = () => {
                if (target.dataset.blockValues)
                    void execute(find(id) ?? action, JSON.parse(target.dataset.blockValues), key);
                else if (action.fields.length) open();
                else void execute(find(id) ?? action, {}, key);
            };
            if (target instanceof HTMLButtonElement) target.addEventListener("click", click);
            else {
                const control = button(action.label, click);
                if (target.closest(".plugin-message-actions")) {
                    control.title = action.label;
                    control.setAttribute("aria-label", action.label);
                    control.innerHTML = action.destructive
                        ? '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 5h12M8 5V3h4v2M6 5l1 12h6l1-12M9 8v6m2-6v6"/></svg>'
                        : '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 4 3 9l5 5M3 9h7a6 6 0 0 1 6 6"/></svg>';
                }
                target.append(control);
            }
            openers.set(key, open);
        }
        for (const action of actions) {
            const holder = node("div");
            const key = `menu:${action.id}`;
            const open = (draft?: Draft) => {
                menu.open = true;
                openEditor(
                    find(action.id) ?? action,
                    (find(action.id) ?? action).fields,
                    holder,
                    key,
                    undefined,
                    draft,
                );
            };
            const control = button(action.label, () =>
                action.fields.length ? open() : void execute(find(action.id) ?? action, {}, key),
            );
            if (action.destructive) control.classList.add("plugin-danger");
            holder.append(control);
            menuBody.append(holder);
            openers.set(key, open);
        }
        menu.hidden = actions.length === 0;
        for (const [key, draft] of saved) {
            const open = openers.get(key);
            if (open) open(draft);
            else {
                const action = find(draft.id);
                if (action) {
                    menu.open = true;
                    openEditor(
                        action,
                        action.fields.filter((field) => draft.fields.includes(field.name)),
                        menuBody,
                        key,
                        undefined,
                        draft,
                    );
                }
            }
        }
    };

    const copy = (event: MouseEvent) => {
        const control =
            event.target instanceof Element
                ? event.target.closest<HTMLButtonElement>("[data-block-copy]")
                : null;
        if (!control) return;
        void navigator.clipboard.writeText(control.dataset.blockCopy ?? "").then(
            () => {
                control.title = t("Copied");
            },
            () => {
                control.title = t("Copy failed");
            },
        );
    };
    section.addEventListener("click", copy);
    void load()
        .then(() => {
            if (active()) bind();
        })
        .catch((error) => {
            if (active()) notice(`${t("Actions could not be loaded.")} ${error.message}`, true);
        });
    return () => {
        disposed = true;
        delete section.dataset.actionsReady;
        window.removeEventListener("beforeunload", beforeUnload);
        section.removeEventListener("click", copy);
        menu.remove();
        reload.remove();
    };
};
