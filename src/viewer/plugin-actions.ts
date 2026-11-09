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
interface Editor {
    id: string;
    original: Record<string, string>;
    version?: string;
    form: HTMLFormElement;
    close: () => void;
    notice: HTMLElement;
    auto: boolean;
    composing: boolean;
    failed: boolean;
    conflicted: boolean;
    timer?: ReturnType<typeof setTimeout>;
}
const fieldValue = (field?: PluginActionField) =>
    field?.value ?? (field?.type === "multiselect" ? "[]" : "");

export const mountPluginActions = (
    section: HTMLElement,
    api: (
        action: string,
        payload?: Record<string, unknown>,
    ) => Promise<{ actions?: PluginAction[]; result?: PluginActionResult }>,
    refreshView: (ready: () => boolean, force?: boolean) => Promise<void>,
    current: () => boolean,
): (() => void) => {
    let actions: PluginAction[] = [],
        busy = false,
        editing = false,
        needsBind = false,
        disposed = false;
    let monitoring: Promise<void> | undefined;
    const active = () => !disposed && current();
    const editors = new Map<string, Editor>();
    const pending = new Set<string>();
    const attempts = new Map<string, { fingerprint: string; requestId: string }>();
    const toolbar = section.querySelector<HTMLElement>(".plugin-toolbar");
    const status = section.querySelector<HTMLElement>("[data-plugin-status]");
    const content = section.querySelector<HTMLElement>("[data-plugin-result]");
    if (!toolbar || !status || !content) throw new Error(t("Plugin request failed"));
    const edit = toolbar.querySelector<HTMLButtonElement>('[data-plugin-action="edit"]');
    if (!edit) throw new Error(t("Plugin request failed"));
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
    const dirty = (editor: Editor) =>
        Object.entries(readValues(editor.form)).some(
            ([name, value]) => value !== editor.original[name],
        );
    const hasDraft = () =>
        [...editors.values()].some((editor) => dirty(editor) || editor.composing);
    const find = (id: string) => actions.find((action) => action.id === id);
    const syncControls = () => {
        section.dataset.editing = String(editing);
        edit.setAttribute("aria-pressed", String(editing));
        edit.disabled = busy || (!editing && !actions.length);
        for (const display of content.querySelectorAll<HTMLElement>("[data-plugin-edit-trigger]")) {
            display.tabIndex = editing ? 0 : -1;
            if (editing) display.setAttribute("role", "button");
            else display.removeAttribute("role");
        }
        for (const control of content.querySelectorAll<HTMLButtonElement>(
            "[data-block-action] button,button[data-block-action],.plugin-submit",
        ))
            control.disabled =
                !editing ||
                busy ||
                !find(
                    control.closest<HTMLElement>("[data-block-action]")?.dataset.blockAction ?? "",
                );
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
        if (attempts.size || hasDraft()) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);

    const load = async () => {
        const data = await api("actions");
        if (!active()) return;
        const next = validatePluginActions(data.actions ?? []);
        needsBind ||= JSON.stringify(next) !== JSON.stringify(actions);
        actions = next;
        for (const [key, editor] of editors) {
            if (attempts.has(key)) continue;
            const action = find(editor.id);
            if (
                action &&
                Object.entries(editor.original).every(
                    ([name, value]) =>
                        value === fieldValue(action.fields.find((f) => f.name === name)),
                )
            )
                editor.version = action.version;
        }
        syncControls();
    };
    const canRender = () =>
        active() &&
        !hasDraft() &&
        ![...editors.values()].some((editor) => editor.form.contains(document.activeElement));
    const watch = () => {
        if (busy || monitoring || !active() || document.hidden) return;
        monitoring = (async () => {
            const expanded = [
                ...content.querySelectorAll<HTMLDetailsElement>(".plugin-block-section"),
            ].map((detail) => detail.open);
            const scroll = content.scrollTop;
            try {
                await load();
                if (!active()) return;
                let rendered = false;
                await refreshView(() => {
                    if (!canRender()) return false;
                    for (const editor of editors.values()) editor.close();
                    rendered = true;
                    return true;
                }, needsBind);
                if (!active()) return;
                if (rendered) {
                    bind();
                    [
                        ...content.querySelectorAll<HTMLDetailsElement>(".plugin-block-section"),
                    ].forEach((detail, i) => {
                        if (expanded[i] !== undefined) detail.open = expanded[i];
                    });
                    content.scrollTop = scroll;
                }
                if (!hasDraft() && !attempts.size) notice("");
            } catch (error) {
                if (active())
                    notice(
                        error instanceof Error ? error.message : t("Plugin request failed"),
                        true,
                    );
            } finally {
                monitoring = undefined;
                if (active()) {
                    syncControls();
                    void flush();
                }
            }
        })();
        return monitoring;
    };

    const execute = async (
        action: PluginAction,
        values: Record<string, string>,
        key: string,
        editor?: Editor,
    ): Promise<void> => {
        if (monitoring) await monitoring;
        if (busy || !editing || !active()) return;
        busy = true;
        syncControls();
        let saved = false;
        try {
            if (
                (action.destructive || action.confirm) &&
                !(await confirmDialog(action.target, action.label, action.destructive))
            )
                return;
            if (!active()) return;
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
            section.setAttribute("aria-busy", "true");
            const response = await api("act", { operation, requestId });
            if (!active()) return;
            saved = true;
            attempts.delete(key);
            if (editor?.auto) {
                Object.assign(editor.original, values);
                editor.notice.textContent = "";
                if (!dirty(editor) && !editor.form.contains(document.activeElement)) editor.close();
            } else editor?.close();
            notice("");
            if (response.result?.deleted) {
                for (const open of editors.values()) open.close();
                content.replaceChildren(node("p", response.result.message));
                section.querySelector("[data-plugin-collapsed]")?.replaceChildren();
                actions = [];
                editing = false;
                stopWatching();
                return;
            }
            await load();
        } catch (error) {
            if (!active()) return;
            const message = error instanceof Error ? error.message : t("Plugin request failed");
            if (!saved && editor) {
                editor.failed = true;
                editor.notice.textContent = message;
                pending.delete(key);
            }
            if (
                !saved &&
                editor &&
                error instanceof Error &&
                "status" in error &&
                error.status === 409
            ) {
                editor.conflicted = true;
                editor.notice.textContent = t(
                    "Changed elsewhere. Your input is kept; edit again to apply it.",
                );
                try {
                    await load();
                } catch {
                    /* Keep the draft if the connection is unavailable. */
                }
            }
            if (
                !saved &&
                error instanceof Error &&
                "status" in error &&
                [400, 401, 403, 404, 409, 422, 429].includes(Number(error.status))
            )
                attempts.delete(key);
            notice(message, true);
        } finally {
            busy = false;
            if (active()) {
                section.removeAttribute("aria-busy");
                syncControls();
                void flush();
                if (saved && canRender()) void watch();
            }
        }
    };
    const flush = async () => {
        if (busy || monitoring || !active() || !editing) return;
        for (const key of pending) {
            if (busy || monitoring) return;
            pending.delete(key);
            const editor = editors.get(key);
            const action = editor && find(editor.id);
            if (
                !editor ||
                !action ||
                editor.composing ||
                editor.failed ||
                !dirty(editor) ||
                !editor.form.reportValidity()
            )
                continue;
            let values = readValues(editor.form);
            if (action.partial)
                values = Object.fromEntries(
                    Object.entries(values).filter(
                        ([name, value]) => value !== editor.original[name],
                    ),
                );
            await execute(action, values, key, editor);
            if (!active()) return;
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
            input.rows = 3;
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
    ) => {
        if (!editing || editors.has(key)) return;
        const form = node("form", "", "plugin-editor");
        form.dataset.pluginForm = key;
        const original = Object.fromEntries(fields.map((field) => [field.name, fieldValue(field)]));
        for (const field of fields) form.append(inputFor(field, original[field.name] ?? ""));
        const feedback = node("p", "", "plugin-editor-notice");
        feedback.setAttribute("role", "status");
        const editor: Editor = {
            id: action.id,
            original,
            version: action.version,
            form,
            notice: feedback,
            auto: !!display,
            composing: false,
            failed: false,
            conflicted: false,
            close: () => {
                clearTimeout(editor.timer);
                pending.delete(key);
                form.remove();
                editors.delete(key);
                if (display) display.hidden = false;
            },
        };
        editors.set(key, editor);
        form.append(feedback);
        if (display) display.hidden = true;
        else {
            const submit = node("button", action.label, "plugin-block-button plugin-submit");
            submit.type = "submit";
            form.append(submit);
        }
        target.append(form);
        const schedule = (delay: number) => {
            clearTimeout(editor.timer);
            if (!editor.auto || editor.composing) return;
            editor.timer = setTimeout(() => {
                pending.add(key);
                void flush();
            }, delay);
        };
        form.addEventListener("input", () => {
            if (editor.conflicted) {
                const latest = find(editor.id);
                if (latest) {
                    editor.original = Object.fromEntries(
                        Object.keys(editor.original).map((name) => [
                            name,
                            fieldValue(latest.fields.find((field) => field.name === name)),
                        ]),
                    );
                    editor.version = latest.version;
                    editor.conflicted = false;
                }
            }
            editor.failed = false;
            schedule(600);
        });
        form.addEventListener("change", () => {
            if (!editor.failed) schedule(0);
        });
        form.addEventListener("focusout", () => {
            setTimeout(() => {
                if (!active() || form.contains(document.activeElement) || editor.composing) return;
                if (!dirty(editor) && !busy) {
                    editor.close();
                    void watch();
                } else if (editor.auto && !editor.failed) {
                    clearTimeout(editor.timer);
                    pending.add(key);
                    void flush();
                }
            }, 0);
        });
        form.addEventListener("compositionstart", () => {
            editor.composing = true;
            clearTimeout(editor.timer);
            pending.delete(key);
        });
        form.addEventListener("compositionend", () => {
            editor.composing = false;
            editor.failed = false;
            schedule(600);
        });
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            if (editor.composing || !form.reportValidity()) return;
            if (editor.auto) {
                pending.add(key);
                void flush();
            } else void execute(find(action.id) ?? action, readValues(form), key, editor);
        });
        form.addEventListener("keydown", (event) => {
            if (event.isComposing) return;
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                form.requestSubmit();
            }
        });
        form.querySelector<HTMLElement>("input,textarea,select")?.focus({ preventScroll: true });
    };

    const bind = () => {
        needsBind = false;
        section.dataset.actionsReady = "true";
        const bound = new Set<string>();
        for (const element of content.querySelectorAll<HTMLElement>("[data-block-edit]")) {
            const binding = JSON.parse(element.dataset.blockEdit ?? "{}") as PluginEdit;
            const action = find(binding.action);
            if (!action) continue;
            const fields = binding.field
                ? action.fields.filter((field) => field.name === binding.field)
                : action.fields;
            if (!fields.length || (binding.field && !action.partial && action.fields.length !== 1))
                continue;
            bound.add(action.id);
            const key = `${action.id}@${binding.field ?? "*"}`;
            const display = node("div");
            display.dataset.pluginEditTrigger = "";
            display.setAttribute("aria-label", `${t("Edit")} ${fields[0]?.label}`);
            display.append(...element.childNodes);
            element.append(display);
            const open = () =>
                openEditor(
                    find(action.id) ?? action,
                    fields.map(
                        (field) =>
                            find(action.id)?.fields.find((f) => f.name === field.name) ?? field,
                    ),
                    element,
                    key,
                    display,
                );
            display.addEventListener("dblclick", (event) => {
                if (!(event.target as Element).closest("a,button")) open();
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
        }
        const targets = [...content.querySelectorAll<HTMLElement>("[data-block-action]")];
        for (const target of targets) bound.add(target.dataset.blockAction ?? "");
        const extra = node("div", "", "plugin-block-actions plugin-extra-actions");
        for (const action of actions) {
            if (bound.has(action.id)) continue;
            const target = node("span");
            target.dataset.blockAction = action.id;
            extra.append(target);
            targets.push(target);
        }
        if (extra.childElementCount) content.append(extra);
        for (const target of targets) {
            const action = find(target.dataset.blockAction ?? "");
            if (!action) {
                if (target instanceof HTMLButtonElement) target.disabled = true;
                continue;
            }
            const click = async () => {
                if (monitoring) await monitoring;
                if (!active() || !editing || busy) return;
                const latest = find(action.id);
                if (!latest) return;
                if (target.dataset.blockValues)
                    void execute(latest, JSON.parse(target.dataset.blockValues), action.id);
                else if (latest.fields.length) openEditor(latest, latest.fields, target, action.id);
                else void execute(latest, {}, action.id);
            };
            if (target instanceof HTMLButtonElement) target.addEventListener("click", click);
            else {
                const control = button(action.label, click);
                if (action.destructive) control.classList.add("plugin-danger");
                if (action.destructive && target.closest(".plugin-message-actions")) {
                    control.title = action.label;
                    control.setAttribute("aria-label", action.label);
                    control.innerHTML =
                        '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 5h12M8 5V3h4v2M6 5l1 12h6l1-12M9 8v6m2-6v6"/></svg>';
                }
                target.append(control);
            }
        }
        syncControls();
    };
    const toggle = async () => {
        if (monitoring) await monitoring;
        if (busy || !active()) return;
        if (editing) {
            for (const [key, editor] of editors)
                if (editor.auto) {
                    clearTimeout(editor.timer);
                    pending.add(key);
                }
            await flush();
            if (!active() || hasDraft()) return;
            for (const editor of editors.values()) editor.close();
        }
        editing = !editing;
        syncControls();
        if (!editing) void watch();
    };
    const copy = async (event: MouseEvent) => {
        const control =
            event.target instanceof Element
                ? event.target.closest<HTMLButtonElement>("[data-block-copy]")
                : null;
        if (!control) return;
        try {
            await navigator.clipboard.writeText(control.dataset.blockCopy ?? "");
            control.title = t("Copied");
        } catch {
            control.title = t("Copy failed");
        }
    };
    const focus = () => {
        if (!document.hidden) void watch();
    };
    const interval = setInterval(() => void watch(), 5000);
    const stopWatching = () => {
        clearInterval(interval);
        window.removeEventListener("focus", focus);
        document.removeEventListener("visibilitychange", focus);
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    section.addEventListener("click", copy);
    edit.addEventListener("click", toggle);
    const initialize = async () => {
        busy = true;
        try {
            await load();
            if (active()) bind();
        } catch (error) {
            if (active())
                notice(error instanceof Error ? error.message : t("Plugin request failed"), true);
        } finally {
            busy = false;
            if (active()) syncControls();
        }
    };
    void initialize();
    return () => {
        disposed = true;
        stopWatching();
        for (const editor of editors.values()) editor.close();
        delete section.dataset.actionsReady;
        delete section.dataset.editing;
        edit.disabled = true;
        edit.setAttribute("aria-pressed", "false");
        edit.removeEventListener("click", toggle);
        window.removeEventListener("beforeunload", beforeUnload);
        section.removeEventListener("click", copy);
    };
};
