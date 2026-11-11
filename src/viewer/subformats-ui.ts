import { defaultFilePath, localFile } from "../core/files.js";
import { escapeHtml } from "../core/html.js";
import { CHECK_ICON } from "../core/icons.js";
import {
    SUBFORMAT_SCHEMA_TEMPLATE,
    type Subformat,
    type SubformatCollection,
    type SubformatRecord,
    sortSubformatRecords,
    subformatChange,
    subformatSourcePath,
} from "../core/subformats.js";
import { confirmDialog, showDialog } from "./edit-dialog.js";
import { t } from "./i18n.js";

interface State {
    collections: SubformatCollection[];
    views: Map<string, Required<NonNullable<Subformat["layouts"]>>>;
    expanded: Set<string>;
    openSource?: (file: string, line: number) => void;
    dialogOpen: boolean;
    dragging?: string;
    stopDrag?: () => void;
    busy: boolean;
    selected?: string;
    openSetting?: string;
}
const states = new WeakMap<HTMLElement, State>();
const cardPositions = (board: HTMLElement): Map<HTMLElement, DOMRect> =>
    new Map(
        [...board.querySelectorAll<HTMLElement>("[data-record-file]")].map((card) => [
            card,
            card.getBoundingClientRect(),
        ]),
    );
const settleCards = (positions: Map<HTMLElement, DOMRect>): Promise<unknown[]> => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return Promise.resolve([]);
    const animations: Promise<unknown>[] = [];
    for (const [card, before] of positions) {
        if (!card.isConnected) continue;
        const after = card.getBoundingClientRect();
        const x = before.left - after.left;
        const y = before.top - after.top;
        if (Math.abs(x) < 1 && Math.abs(y) < 1) continue;
        animations.push(
            card
                .animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: "none" }], {
                    duration: 180,
                    easing: "cubic-bezier(0.16, 1, 0.3, 1)",
                })
                .finished.catch(() => {}),
        );
    }
    return Promise.all(animations);
};
let registrationForm: HTMLFormElement | undefined;
let recordForm: HTMLFormElement | undefined;
export const hasSubformatDraft = (): boolean =>
    registrationForm?.dataset.dirty === "true" || recordForm?.dataset.dirty === "true";

export const showSubformatError = (error: unknown): void => {
    document.querySelector(".subformat-toast")?.remove();
    const toast = document.createElement("div");
    toast.className = "subformat-toast";
    toast.setAttribute("role", "alert");
    toast.textContent = error instanceof Error ? error.message : String(error);
    document.body.append(toast);
    setTimeout(() => toast.remove(), 6000);
};

export const mountSubformatPageActions = (): void => {
    document.addEventListener("docs:subformat-page-action", async (event) => {
        const { id, action } = (event as CustomEvent<{ id: string; action: string }>).detail;
        const link = document.querySelector<HTMLAnchorElement>(
            `[data-doc-id="${CSS.escape(id)}"] > .nav-row > a`,
        );
        if (!link) return;
        const title = link.textContent?.trim() ?? "";
        let nextTitle = title;
        if (action === "delete") {
            if (
                !(await confirmDialog(
                    t("Remove this page from the sidebar? The records will be kept."),
                    t("Remove page"),
                ))
            )
                return;
        } else if (action === "rename") {
            const label = document.createElement("label");
            label.textContent = t("title");
            const input = document.createElement("input");
            input.className = "subformat-page-name";
            input.value = title;
            input.required = true;
            label.append(input);
            const result = showDialog(t("Rename page"), label, [
                { value: "", label: t("Cancel") },
                { value: "save", label: t("Save") },
            ]);
            input.focus();
            input.select();
            if ((await result) !== "save") return;
            nextTitle = input.value.trim();
        } else return;
        try {
            const response = await fetch("/api/subformat-page", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ id, action, title: nextTitle }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error ?? t("Save failed"));
            if (action === "delete" && location.pathname === link.pathname) {
                const next = [
                    ...document.querySelectorAll<HTMLAnchorElement>("#nav-docs .nav-row > a"),
                ].find((item) => item !== link);
                const navigate = (
                    window as unknown as { __docsNavigate?: (path: string) => Promise<void> }
                ).__docsNavigate;
                if (navigate) await navigate(next?.pathname ?? "/");
                else location.href = next?.href ?? "/";
            }
            document.dispatchEvent(new Event("docs:files-changed"));
        } catch (error) {
            showSubformatError(error);
        }
    });
};

const countHtml = (records: SubformatRecord[]): string => {
    const counts = ["added", "modified"].map((change) => ({
        change,
        count: records.filter((record) => record.change === change).length,
        label: t(change === "added" ? "Added" : "Modified"),
    }));
    const uniform = counts.find(({ count }) => count > 0 && count === records.length);
    const badge = ({ change, count, label }: (typeof counts)[number]) =>
        `<span data-record-change="${change}" aria-label="${escapeHtml(`${label}: ${count}`)}" title="${escapeHtml(label)}">${count}</span>`;
    return uniform
        ? badge(uniform)
        : `<span>${records.length}</span>${counts
              .filter(({ count }) => count > 0)
              .map(badge)
              .join("")}`;
};

export const filterSubformats = (
    root: HTMLElement,
    words: string[],
    openSource?: (file: string, line: number) => void,
): boolean => {
    const template = root.querySelector<HTMLTemplateElement>("[data-subformats]");
    const board = root.querySelector<HTMLElement>("[data-subformat-board]");
    if (!template || !board) return false;
    let state = states.get(root);
    if (!state) {
        state = {
            collections: JSON.parse(template.content.textContent ?? "[]"),
            views: new Map(),
            expanded: new Set(),
            openSource,
            dialogOpen: false,
            busy: false,
        };
        states.set(root, state);
    }
    const select = root.querySelector<HTMLSelectElement>("[data-resource-filter]");
    if (
        select?.hasAttribute("data-subformat-filter") &&
        state.openSource &&
        document.body.classList.contains("edit")
    ) {
        if (![...select.options].some((option) => option.value === "+"))
            select.add(new Option(t("Add subformat…"), "+"));
        if (select.value === "+") {
            select.value = state.selected ?? state.collections[0]?.ext ?? "";
            addSubformat(root, state, select);
        }
    }
    const collection = state.collections.find(
        (item) => item.ext === (root.dataset.subformatPage ?? select?.value),
    );
    if (select) {
        for (const option of select.options) {
            const format = state.collections.find((item) => item.ext === option.value);
            const change = format && subformatChange(format);
            if (change) {
                option.dataset.subformatChange = change;
                option.setAttribute(
                    "aria-label",
                    `${option.text} · ${t(change === "added" ? "Added" : "Modified")}`,
                );
            } else {
                delete option.dataset.subformatChange;
                option.removeAttribute("aria-label");
            }
        }
        const change = collection && subformatChange(collection);
        if (change) select.dataset.subformatChange = change;
        else delete select.dataset.subformatChange;
        syncSubformatPicker(root, select, state);
    }
    board.hidden = !collection;
    const items = root.querySelector<HTMLElement>(".resource-items");
    if (items) items.hidden = !!collection;
    if (!collection) {
        state.stopDrag?.();
        root.querySelector(".subformat-controls")?.remove();
        return false;
    }
    board.setAttribute("aria-label", collection.ext);
    state.selected = collection.ext;
    render(root, board, state, collection, words);
    return true;
};

const syncSubformatPicker = (root: HTMLElement, select: HTMLSelectElement, state: State): void => {
    const trigger = root.querySelector<HTMLButtonElement>("[data-subformat-trigger]");
    const popup = root.querySelector<HTMLElement>("[data-subformat-options]");
    if (!trigger || !popup) return;
    trigger.textContent = select.selectedOptions[0]?.text || t("Subformats");
    trigger.disabled = ![...select.options].some((option) => option.value);
    if (select.dataset.subformatChange)
        trigger.dataset.subformatChange = select.dataset.subformatChange;
    else delete trigger.dataset.subformatChange;
    popup.replaceChildren();
    for (const option of select.options) {
        if (!option.value) continue;
        const button = document.createElement("button");
        button.type = "button";
        button.tabIndex = -1;
        button.textContent = option.text;
        button.setAttribute("role", option.value === "+" ? "menuitem" : "menuitemradio");
        if (option.value === "+") button.dataset.subformatAdd = "";
        else button.setAttribute("aria-checked", String(option.selected));
        if (option.dataset.subformatChange) {
            button.dataset.subformatChange = option.dataset.subformatChange;
            button.setAttribute("aria-label", option.getAttribute("aria-label") ?? option.text);
        }
        button.addEventListener("click", () => {
            popup.hidePopover();
            select.value = option.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            if (option.value !== "+") trigger.focus();
        });
        const row = document.createElement("div");
        row.className = "subformat-picker-option";
        row.setAttribute("role", "none");
        row.append(button);
        const collection = state.collections.find((item) => item.ext === option.value);
        if (collection && state.openSource && document.body.classList.contains("edit")) {
            for (const action of ["edit", "delete"] as const) {
                const control = document.createElement("button");
                control.type = "button";
                control.tabIndex = -1;
                control.dataset.subformatAction = action;
                control.textContent = t(action === "edit" ? "Edit" : "Delete");
                control.setAttribute("role", "menuitem");
                control.setAttribute("aria-label", `${control.textContent}: ${collection.ext}`);
                control.disabled = state.busy;
                control.addEventListener("click", () => {
                    if (state.busy) return;
                    popup.hidePopover();
                    trigger.focus();
                    if (action === "edit") state.openSource?.(collection.schema, 1);
                    else void deleteSubformat(root, state, select, collection);
                });
                row.append(control);
            }
        }
        popup.append(row);
    }
    mountSubformatMenu(trigger, popup);
};

const deleteSubformat = async (
    root: HTMLElement,
    state: State,
    select: HTMLSelectElement,
    collection: SubformatCollection,
): Promise<void> => {
    state.busy = true;
    try {
        if (
            !(await confirmDialog(
                t(
                    "Delete subformat {ext} and its sidebar page? Records and schema files will be kept.",
                    {
                        ext: collection.ext,
                    },
                ),
                t("Delete"),
                true,
            ))
        )
            return;
        const { ext, format, schema, layouts } = collection;
        const response = await fetch("/api/subformat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "delete", ext, base: { ext, format, schema, layouts } }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(t(result.error ?? "Save failed"));
        state.collections = state.collections.filter((item) => item !== collection);
        state.views.delete(ext);
        for (const option of [...select.options]) {
            if (option.value === ext) option.remove();
        }
        if (!state.collections.some((item) => item.ext === select.value))
            select.value = state.collections[0]?.ext ?? "";
        document.dispatchEvent(
            new CustomEvent("docs:subformat-saved", { detail: { file: "dooc.yaml" } }),
        );
        document.dispatchEvent(new Event("docs:files-changed"));
    } catch (error) {
        showSubformatError(error);
    } finally {
        state.busy = false;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        root.querySelector<HTMLElement>("[data-subformat-trigger]")?.focus();
    }
};

const mountSubformatMenu = (
    trigger: HTMLButtonElement,
    popup: HTMLElement,
    onToggle?: (open: boolean) => void,
): void => {
    if (trigger.dataset.mounted) return;
    trigger.dataset.mounted = "true";
    trigger.addEventListener("click", () => {
        if (popup.matches(":popover-open")) {
            popup.hidePopover();
            return;
        }
        popup.showPopover();
        const rect = trigger.getBoundingClientRect();
        const below = innerHeight - rect.bottom;
        const above = below < 240 && rect.top > below;
        Object.assign(popup.style, {
            left: `${Math.max(8, Math.min(rect.left, innerWidth - popup.offsetWidth - 8))}px`,
            maxHeight: `${Math.max(80, Math.min(360, (above ? rect.top : below) - 12))}px`,
            top: above ? "auto" : `${rect.bottom + 4}px`,
            bottom: above ? `${innerHeight - rect.top + 4}px` : "auto",
        });
        trigger.setAttribute("aria-expanded", "true");
        (
            popup.querySelector<HTMLElement>('[aria-checked="true"]') ??
            popup.querySelector("button")
        )?.focus();
    });
    popup.addEventListener("beforetoggle", (event) => {
        const open = (event as ToggleEvent).newState === "open";
        trigger.setAttribute("aria-expanded", String(open));
        if (popup.isConnected) onToggle?.(open);
    });
    popup.addEventListener("keydown", (event) => {
        const options = [...popup.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const index = options.indexOf(document.activeElement as HTMLButtonElement);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const next =
                event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? options.length - 1
                      : (index + (event.key === "ArrowDown" ? 1 : options.length - 1)) %
                        options.length;
            options[next]?.focus();
        }
        if (event.key === "Escape") trigger.focus();
    });
};

const addSubformat = (root: HTMLElement, state: State, select: HTMLSelectElement): void => {
    if (registrationForm) {
        document.dispatchEvent(new CustomEvent("docs:subformat-add", { detail: registrationForm }));
        return;
    }
    const form = document.createElement("form");
    registrationForm = form;
    form.className = "subformat-create-form";
    form.dataset.subformatRegister = "";
    form.setAttribute("aria-label", t("Add subformat"));
    form.innerHTML = `<fieldset class="subformat-register-fields"><input name="ext" required placeholder="ext." aria-label="${t("Extension")}" autocomplete="off" spellcheck="false"><label class="subformat-control"><span class="subformat-control-label">format</span><select id="subformat-format" name="format" data-placeholder="format" aria-label="${t("Storage format")}"><option value="json">json</option><option value="yaml">yaml</option><option value="toml">toml</option></select></label><input name="schema" placeholder="path" aria-label="${t("Schema file (optional)")}" autocomplete="off" spellcheck="false"></fieldset><fieldset><textarea name="content" hidden></textarea><div data-subformat-schema-editor></div><div class="subformat-create-actions"><button type="button" data-format>${t("Validate and apply")}</button><button type="button" data-cancel>${t("Cancel")}</button><button type="submit">${t("Add subformat")}</button></div></fieldset>`;
    (form.elements.namedItem("content") as HTMLTextAreaElement).value = SUBFORMAT_SCHEMA_TEMPLATE;
    const extension = form.elements.namedItem("ext") as HTMLInputElement;
    const path = form.elements.namedItem("schema") as HTMLInputElement;
    extension.addEventListener("input", () => {
        if (extension.value.trim()) path.placeholder = `${extension.value.trim()}.schema.json`;
        else path.placeholder = "path";
    });
    form.addEventListener("input", () => {
        form.dataset.dirty = "true";
    });
    const dismiss = () => {
        registrationForm = undefined;
        document.dispatchEvent(new CustomEvent("docs:subformat-editor-close", { detail: form }));
        form.remove();
    };
    const close = () => {
        if (state.busy) return;
        dismiss();
        (root.querySelector<HTMLElement>("[data-subformat-trigger]") ?? select).focus();
    };
    form.querySelector("[data-cancel]")?.addEventListener("click", close);
    const keydown = (event: KeyboardEvent) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            event.stopPropagation();
            close();
        }
    };
    form.addEventListener("keydown", keydown);
    form.querySelector(".subformat-register-fields")?.addEventListener("keydown", (event) =>
        keydown(event as KeyboardEvent),
    );
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (state.busy) return;
        state.busy = true;
        const fieldsets = [...form.elements].filter(
            (element): element is HTMLFieldSetElement => element instanceof HTMLFieldSetElement,
        );
        const value = (name: string) =>
            (form.elements.namedItem(name) as HTMLInputElement).value.trim();
        for (const fields of fieldsets) fields.disabled = true;
        const schemaEditor = form.querySelector<HTMLElement>("[data-subformat-schema-editor]");
        if (schemaEditor) schemaEditor.inert = true;
        document.querySelector(".subformat-toast")?.remove();
        try {
            const response = await fetch("/api/subformat", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    action: "register",
                    ext: value("ext"),
                    format: value("format"),
                    schema: value("schema"),
                    content: (form.elements.namedItem("content") as HTMLTextAreaElement).value,
                }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(t(result.error ?? "Save failed"));
            const collection = result.collection as SubformatCollection;
            state.collections.push(collection);
            select.add(new Option(collection.ext, collection.ext), select.options.length - 1);
            select.value = collection.ext;
            dismiss();
            state.busy = false;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            state.openSource?.(collection.schema, 1);
        } catch (error) {
            showSubformatError(error);
        } finally {
            state.busy = false;
            for (const fields of fieldsets) fields.disabled = false;
            if (schemaEditor) schemaEditor.inert = false;
        }
    });
    document.dispatchEvent(new CustomEvent("docs:subformat-add", { detail: form }));
    (form.elements.namedItem("ext") as HTMLInputElement).focus();
};

export const restoreSubformatViews = (previous: Element, next: Element): void => {
    const before = previous.querySelector<HTMLElement>("[data-resource-results]");
    const after = next.querySelector<HTMLElement>("[data-resource-results]");
    const from = before && states.get(before);
    const to = after && states.get(after);
    if (from && to) {
        to.views = from.views;
        to.expanded = from.expanded;
        to.openSetting = from.openSetting;
        if (after?.hasAttribute("data-subformat-page"))
            filterSubformats(after, [], from.openSource);
        const columns = after?.querySelector(".subformat-columns");
        if (columns)
            columns.scrollLeft = before?.querySelector(".subformat-columns")?.scrollLeft ?? 0;
    }
};

const fieldHtml = (title: string, value: unknown): string =>
    `<div><dt>${escapeHtml(title)}</dt><dd>${escapeHtml(typeof value === "object" ? JSON.stringify(value, null, 2) : String(value))}</dd></div>`;

const render = (
    root: HTMLElement,
    board: HTMLElement,
    state: State,
    collection: SubformatCollection,
    words: string[],
): void => {
    state.stopDrag?.();
    const scrollLeft = board.querySelector(".subformat-columns")?.scrollLeft ?? 0;
    const enums = collection.fields.filter((field) => field.enum?.length);
    const view = state.views.get(collection.ext) ?? {
        card_title: collection.layouts?.card_title ?? "",
        group_by: collection.layouts?.group_by ?? enums[0]?.name ?? "",
        sort_by: collection.layouts?.sort_by ?? "",
        sort_order: collection.layouts?.sort_order ?? "asc",
    };
    state.views.set(collection.ext, view);
    if (!enums.some((field) => field.name === view.group_by)) view.group_by = "";
    const grouping = enums.find((field) => field.name === view.group_by);
    const sortable = collection.fields.filter((field) => field.enum || field.format || field.type);
    if (!sortable.some((field) => field.name === view.sort_by)) view.sort_by = "";
    const sorting = sortable.find((field) => field.name === view.sort_by);
    const titleField = view.card_title;
    const descending = view.sort_order === "desc";
    const records = sortSubformatRecords(
        collection.records.filter((record) => {
            const text = `${record.file} ${record.content}`.normalize("NFKC").toLowerCase();
            return words.every((word) => text.includes(word));
        }),
        sorting,
        descending,
    );
    const empty = root.querySelector<HTMLElement>("[data-resource-empty]");
    if (empty) empty.hidden = records.length > 0;
    const controls =
        root.querySelector<HTMLElement>(".subformat-controls") ?? document.createElement("div");
    controls.className = "subformat-controls";
    root.querySelector(".resource-toolbar")?.append(controls);
    const openSetting = state.openSetting;
    controls.replaceChildren();
    const settings: {
        key: keyof NonNullable<Subformat["layouts"]>;
        fields: { name: string; title: string }[];
    }[] = [
        { key: "card_title", fields: [{ name: "", title: t("File name") }, ...collection.fields] },
        ...(enums.length
            ? [
                  {
                      key: "group_by" as const,
                      fields: [{ name: "", title: t("No grouping") }, ...enums],
                  },
              ]
            : []),
        { key: "sort_by", fields: [{ name: "", title: t("File name") }, ...sortable] },
        {
            key: "sort_order",
            fields: [
                { name: "asc", title: t(sorting?.format ? "Oldest first" : "Ascending") },
                { name: "desc", title: t(sorting?.format ? "Newest first" : "Descending") },
            ],
        },
    ];
    for (const { key, fields } of settings) {
        const control = document.createElement("div");
        control.className = "subformat-control";
        const label = key.replaceAll("_", " ");
        const id = `subformat-${collection.ext}-${key}`;
        const current = fields.find((field) => field.name === view[key])?.title ?? t("File name");
        control.innerHTML = `<span class="subformat-control-label" id="${id}-label">${label}</span><button type="button" data-subformat-setting="${key}" aria-labelledby="${id}-label ${id}-value" aria-haspopup="menu" aria-expanded="false" aria-controls="${id}-menu"${state.busy ? " disabled" : ""}><span id="${id}-value">${escapeHtml(current)}</span><svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m5 7 5 5 5-5"/></svg></button><div class="subformat-picker-menu subformat-setting-menu" id="${id}-menu" popover="auto" role="menu" aria-label="${label}"></div>`;
        controls.append(control);
        const trigger = control.querySelector("button") as HTMLButtonElement;
        const popup = control.querySelector("[popover]") as HTMLElement;
        const defaultValue =
            collection.layouts?.[key] ??
            (key === "sort_order" ? "asc" : key === "group_by" ? (enums[0]?.name ?? "") : "");
        for (const field of fields) {
            const row = document.createElement("div");
            row.className = "subformat-setting-option";
            row.setAttribute("role", "none");
            const choose = document.createElement("button");
            choose.type = "button";
            choose.tabIndex = -1;
            choose.textContent = field.title;
            choose.dataset.settingValue = field.name;
            choose.setAttribute("role", "menuitemradio");
            choose.setAttribute("aria-checked", String(field.name === view[key]));
            choose.addEventListener("click", () => {
                if (state.busy) return;
                if (key === "sort_order") view.sort_order = field.name as "asc" | "desc";
                else view[key] = field.name;
                popup.hidePopover();
                render(root, board, state, collection, words);
                controls.querySelector<HTMLElement>(`[data-subformat-setting="${key}"]`)?.focus();
            });
            row.append(choose);
            const editable = document.body.classList.contains("edit");
            const marker = document.createElement(editable ? "button" : "span");
            marker.className = "subformat-default";
            marker.dataset.defaultValue = field.name;
            marker.dataset.isDefault = String(field.name === defaultValue);
            marker.dataset.layoutChanged = String(
                field.name === defaultValue &&
                    collection.baseLayouts !== undefined &&
                    collection.layouts?.[key] !== collection.baseLayouts[key],
            );
            marker.innerHTML = CHECK_ICON;
            marker.title = t(field.name === defaultValue ? "Default" : "Set as default");
            marker.setAttribute("aria-label", `${marker.title}: ${label} · ${field.title}`);
            if (marker instanceof HTMLButtonElement) {
                marker.type = "button";
                marker.tabIndex = -1;
                marker.setAttribute("role", "menuitem");
                marker.disabled = state.busy || collection.layouts?.[key] === field.name;
                marker.addEventListener("click", async () => {
                    if (state.busy) return;
                    state.busy = true;
                    marker.disabled = true;
                    trigger.disabled = true;
                    try {
                        const response = await fetch("/api/subformat", {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({
                                action: "layouts",
                                ext: collection.ext,
                                key,
                                value: field.name,
                                base: collection.layouts?.[key] ?? null,
                            }),
                        });
                        const result = await response.json();
                        if (!response.ok) throw new Error(t(result.error ?? "Save failed"));
                        collection.layouts = { ...collection.layouts, [key]: field.name };
                        document.dispatchEvent(
                            new CustomEvent("docs:subformat-saved", {
                                detail: { file: "dooc.yaml" },
                            }),
                        );
                    } catch (error) {
                        showSubformatError(error);
                    } finally {
                        state.busy = false;
                        filterSubformats(root, words);
                    }
                });
            }
            row.append(marker);
            popup.append(row);
        }
        mountSubformatMenu(trigger, popup, (open) => {
            if (open) state.openSetting = key;
            else if (state.openSetting === key) state.openSetting = undefined;
        });
        if (openSetting === key && trigger.isConnected) trigger.click();
    }
    if (state.openSource && document.body.classList.contains("edit")) {
        const create = document.createElement("button");
        create.type = "button";
        create.dataset.subformatCreate = "";
        create.textContent = t("Create");
        create.disabled = state.busy;
        controls.append(create);
        create.addEventListener("click", () => {
            if (recordForm) {
                document.dispatchEvent(
                    new CustomEvent("docs:subformat-create", { detail: recordForm }),
                );
                return;
            }
            const form = document.createElement("form");
            recordForm = form;
            form.className = "subformat-create-form";
            form.dataset.subformatRecord = collection.format;
            form.setAttribute("aria-label", t("Create"));
            form.innerHTML = `<fieldset class="subformat-register-fields"><input name="file" required aria-label="${t("File path")}" autocomplete="off" spellcheck="false"></fieldset><fieldset><textarea name="content" hidden></textarea><div data-subformat-schema-editor></div><div class="subformat-create-actions"><button type="button" data-cancel>${t("Cancel")}</button><button type="submit">${t("Create")}</button></div></fieldset>`;
            const file = form.elements.namedItem("file") as HTMLInputElement;
            const content = form.elements.namedItem("content") as HTMLTextAreaElement;
            const directory = collection.defaultFolder
                ? `${collection.defaultFolder}/`
                : ((collection.records[0]?.file ?? defaultFilePath(`new.${collection.ext}`)).match(
                      /^.*\//,
                  )?.[0] ?? "");
            let name = "new";
            for (
                let index = 2;
                collection.records.some(
                    (record) => record.file === `${directory}${name}.${collection.ext}`,
                );
                index++
            )
                name = `new-${index}`;
            file.value = `${directory}${name}.${collection.ext}`;
            content.value = collection.template ?? (collection.format === "json" ? "{}\n" : "");
            form.addEventListener("input", () => {
                form.dataset.dirty = "true";
            });
            const dismiss = () => {
                recordForm = undefined;
                document.dispatchEvent(
                    new CustomEvent("docs:subformat-editor-close", { detail: form }),
                );
                form.remove();
            };
            const close = () => {
                if (state.busy) return;
                dismiss();
                root.querySelector<HTMLElement>("[data-subformat-create]")?.focus();
            };
            form.querySelector("[data-cancel]")?.addEventListener("click", close);
            const keydown = (event: KeyboardEvent) => {
                if (event.key === "Escape" && !event.defaultPrevented) {
                    event.preventDefault();
                    event.stopPropagation();
                    close();
                }
            };
            form.addEventListener("keydown", keydown);
            form.querySelector(".subformat-register-fields")?.addEventListener("keydown", (event) =>
                keydown(event as KeyboardEvent),
            );
            form.addEventListener("submit", async (event) => {
                event.preventDefault();
                if (state.busy) return;
                const path = file.value.trim();
                document.querySelector(".subformat-toast")?.remove();
                if (!localFile(path) || !path.endsWith(`.${collection.ext}`)) {
                    showSubformatError(new Error(`${t("File path")}: *.${collection.ext}`));
                    file.focus();
                    return;
                }
                state.busy = true;
                create.disabled = true;
                const fields = [...form.elements].filter(
                    (element): element is HTMLFieldSetElement =>
                        element instanceof HTMLFieldSetElement,
                );
                for (const field of fields) field.disabled = true;
                const editor = form.querySelector<HTMLElement>("[data-subformat-schema-editor]");
                if (editor) editor.inert = true;
                try {
                    const response = await fetch("/api/subformat", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({
                            action: "create",
                            file: path,
                            content: content.value,
                        }),
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(t(result.error ?? "Save failed"));
                    collection.records.push({
                        file: path,
                        content: result.content,
                        data: result.data,
                        change: "added",
                        references: [],
                    });
                    document.dispatchEvent(
                        new CustomEvent("docs:subformat-saved", { detail: { file: path } }),
                    );
                    state.busy = false;
                    dismiss();
                    filterSubformats(root, words);
                    state.openSource?.(path, 1);
                } catch (error) {
                    showSubformatError(error);
                } finally {
                    state.busy = false;
                    for (const field of fields) field.disabled = false;
                    if (editor) editor.inert = false;
                    create.disabled = false;
                }
            });
            document.dispatchEvent(new CustomEvent("docs:subformat-create", { detail: form }));
            file.focus();
            file.select();
        });
    }
    board.setAttribute("aria-busy", String(state.busy));
    board.innerHTML = '<div class="subformat-columns"></div>';
    const columns = board.querySelector(".subformat-columns") as HTMLElement;
    const writable =
        !!state.openSource && document.body.classList.contains("edit") && !grouping?.readOnly;
    const dropAreas = new Map<unknown, HTMLElement>();
    const move = async (record: SubformatRecord, value: unknown): Promise<void> => {
        if (state.busy || !grouping || !writable || record.data[grouping.name] === value) return;
        const card = board.querySelector<HTMLElement>(
            `[data-record-file="${CSS.escape(record.file)}"]`,
        );
        const target = dropAreas.get(value);
        if (!card || !target) return;
        const positions = cardPositions(board);
        const preview = board.querySelector<HTMLElement>(".subformat-drag-preview");
        if (preview && !preview.hidden) positions.set(card, preview.getBoundingClientRect());
        state.busy = true;
        document.querySelector(".subformat-toast")?.remove();
        state.stopDrag?.();
        board.setAttribute("aria-busy", "true");
        for (const control of root.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(
            ".subformat-controls button, .subformat-card select",
        ))
            control.disabled = true;
        const moved = { ...record, data: { ...record.data, [grouping.name]: value } };
        const ordered = sortSubformatRecords(
            records
                .map((item) => (item === record ? moved : item))
                .filter((item) => item.data[grouping.name] === value),
            sorting,
            descending,
        );
        const next = ordered[ordered.indexOf(moved) + 1];
        target.insertBefore(
            card,
            next ? target.querySelector(`[data-record-file="${CSS.escape(next.file)}"]`) : null,
        );
        const settling = settleCards(positions);
        try {
            const response = await fetch("/api/subformat", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    file: record.file,
                    base: record.content,
                    field: grouping.name,
                    value,
                }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(t(result.error ?? "Save failed"));
            record.content = result.content;
            record.data = result.data;
            record.change = record.change === "added" ? "added" : "modified";
            document.dispatchEvent(
                new CustomEvent("docs:subformat-saved", { detail: { file: record.file } }),
            );
        } catch (error) {
            showSubformatError(error);
        } finally {
            await settling;
            const before = new Map(
                [...cardPositions(board)].map(([card, rect]) => [card.dataset.recordFile, rect]),
            );
            state.busy = false;
            const query =
                root.querySelector<HTMLInputElement>("[data-resource-search]")?.value ?? "";
            filterSubformats(
                root,
                query.normalize("NFKC").toLowerCase().trim().split(/\s+/).filter(Boolean),
            );
            void settleCards(
                new Map(
                    [...cardPositions(board)].map(([card, rect]) => [
                        card,
                        before.get(card.dataset.recordFile) ?? rect,
                    ]),
                ),
            );
            if (document.activeElement === document.body) {
                const card = board.querySelector(`[data-record-file="${CSS.escape(record.file)}"]`);
                (
                    card?.querySelector<HTMLElement>(
                        ".subformat-card-details:not([hidden]) select",
                    ) ?? card?.querySelector<HTMLElement>(".subformat-card-open")
                )?.focus({ preventScroll: true });
            }
        }
    };
    const groups = grouping ? [...(grouping.enum ?? []), undefined] : [undefined];
    for (const value of groups) {
        const matches = grouping
            ? records.filter((record) => record.data[grouping.name] === value)
            : records;
        if (grouping && value === undefined && !matches.length) continue;
        const column = document.createElement("section");
        column.className = "subformat-column";
        const label = grouping
            ? value === undefined
                ? t("Unassigned")
                : String(value)
            : t("Records");
        column.setAttribute("aria-label", label);
        column.innerHTML = `<h2>${escapeHtml(label)} <span class="subformat-count">${countHtml(matches)}</span></h2>`;
        const cards = document.createElement("div");
        cards.className = "subformat-cards";
        column.append(cards);
        dropAreas.set(value, cards);
        if (writable && value !== undefined) {
            cards.addEventListener("dragover", (event) => {
                const record = collection.records.find((item) => item.file === state.dragging);
                if (state.busy || !grouping || !record) return;
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
                cards.classList.toggle("is-drop-target", record.data[grouping.name] !== value);
            });
            cards.addEventListener("drop", (event) => {
                event.preventDefault();
                cards.classList.remove("is-drop-target");
                const record = collection.records.find((record) => record.file === state.dragging);
                if (record) void move(record, value);
            });
        }
        for (const record of matches) {
            const card = document.createElement("article");
            card.className = "subformat-card";
            card.dataset.recordFile = record.file;
            if (record.change) card.dataset.recordChange = record.change;
            const titleValue =
                titleField && Object.hasOwn(record.data, titleField)
                    ? record.data[titleField]
                    : undefined;
            const title =
                titleValue == null
                    ? (record.file.split("/").at(-1) ?? record.file)
                    : typeof titleValue === "object"
                      ? JSON.stringify(titleValue)
                      : String(titleValue);
            const fields = collection.fields.filter(
                (field) =>
                    field !== grouping &&
                    field.name !== titleField &&
                    Object.hasOwn(record.data, field.name),
            );
            const summary = fields
                .filter((field) => typeof record.data[field.name] !== "object")
                .sort((a, b) => Number(!!b.format) - Number(!!a.format))
                .slice(0, 3);
            const summaryHtml = `<dl class="subformat-card-meta">${summary.map((field) => fieldHtml(field.title, record.data[field.name])).join("")}</dl>`;
            const expanded = state.expanded.has(record.file);
            const detailsId = `subformat-details-${encodeURIComponent(record.file)}`;
            const references = record.references ?? [];
            const referencesId = `subformat-references-${encodeURIComponent(record.file)}`;
            const links = references
                .map(
                    ({ file, line }) =>
                        `<li><a href="/_files/file/${encodeURIComponent(file)}#L${line}" data-resource-source="${escapeHtml(file)}" data-resource-line="${line}" draggable="false"><span>${escapeHtml(file)}</span><span>L${line}</span></a></li>`,
                )
                .join("");
            const sourcePath = subformatSourcePath(record.file, document.body.dataset.sourceBase);
            card.innerHTML = `<div class="subformat-card-tools"><span class="subformat-card-file">${escapeHtml(record.file.split("/").at(-1) ?? record.file)}</span><button type="button" class="subformat-card-toggle" aria-expanded="${expanded}" aria-controls="${detailsId}" aria-label="${t(expanded ? "Collapse card" : "Expand card")}"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 7 5 5 5-5"/></svg></button><button type="button" class="subformat-card-references" popovertarget="${referencesId}" aria-label="${escapeHtml(`${t("references")}: ${references.length}`)}"${references.length ? "" : " disabled"}><svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4 2h8l4 4v12H4zM12 2v4h4M7 10h6M7 13h6"/></svg>${references.length}</button><button type="button" class="subformat-card-copy" aria-label="${t("Copy path")}"><svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="m8 12 4-4m-5 2L5 12a3 3 0 0 0 4 4l2-2m-2-8 2-2a3 3 0 0 1 4 4l-2 2"/></svg>${CHECK_ICON}</button></div><div id="${referencesId}" class="subformat-reference-list" popover="auto" aria-label="${t("references")}"><ul>${links}</ul></div><h3><button type="button" class="subformat-card-open"${state.openSource ? "" : ' aria-haspopup="dialog"'}>${escapeHtml(title)}</button></h3>${summaryHtml}<div class="subformat-card-details" id="${detailsId}"${expanded ? "" : " hidden"}><dl>${fields.map((field) => fieldHtml(field.title, record.data[field.name])).join("")}</dl></div>`;
            const copy = card.querySelector(".subformat-card-copy") as HTMLButtonElement;
            copy.addEventListener("click", async () => {
                try {
                    await navigator.clipboard.writeText(sourcePath);
                    copy.dataset.copied = "true";
                    setTimeout(() => delete copy.dataset.copied, 1500);
                } catch {
                    showSubformatError(new Error(t("Copy failed")));
                }
            });
            const referenceList = card.querySelector<HTMLElement>(
                ".subformat-reference-list",
            ) as HTMLElement;
            const referenceButton = card.querySelector<HTMLButtonElement>(
                ".subformat-card-references",
            ) as HTMLButtonElement;
            if (root.hasAttribute("data-subformat-page")) referenceButton.hidden = true;
            referenceList.addEventListener("toggle", () => {
                if (!referenceList.matches(":popover-open")) return;
                const rect = referenceButton.getBoundingClientRect();
                const below = innerHeight - rect.bottom;
                const above = below < 240 && rect.top > below;
                Object.assign(referenceList.style, {
                    left: `${Math.max(8, Math.min(rect.right - referenceList.offsetWidth, innerWidth - referenceList.offsetWidth - 8))}px`,
                    maxHeight: `${Math.max(80, Math.min(320, (above ? rect.top : below) - 12))}px`,
                    top: above ? "auto" : `${rect.bottom + 4}px`,
                    bottom: above ? `${innerHeight - rect.top + 4}px` : "auto",
                });
            });
            referenceList.addEventListener("click", (event) => {
                if ((event.target as Element).closest("a")) referenceList.hidePopover();
            });
            const details = card.querySelector<HTMLElement>(
                ".subformat-card-details",
            ) as HTMLElement;
            const meta = card.querySelector<HTMLElement>(".subformat-card-meta") as HTMLElement;
            meta.hidden = expanded;
            const toggle = card.querySelector<HTMLButtonElement>(
                ".subformat-card-toggle",
            ) as HTMLButtonElement;
            toggle.addEventListener("click", () => {
                const expanded = details.hidden;
                details.hidden = !expanded;
                meta.hidden = expanded;
                if (expanded) state.expanded.add(record.file);
                else state.expanded.delete(record.file);
                toggle.setAttribute("aria-expanded", String(expanded));
                toggle.setAttribute("aria-label", t(expanded ? "Collapse card" : "Expand card"));
            });
            const showDetails = async (): Promise<void> => {
                if (state.dialogOpen) return;
                state.dialogOpen = true;
                const content = document.createElement("div");
                content.className = "subformat-detail";
                content.innerHTML = `<p class="subformat-detail-path">${escapeHtml(record.file)}</p><dl>${Object.entries(
                    record.data,
                )
                    .map(([name, value]) =>
                        fieldHtml(
                            collection.fields.find((field) => field.name === name)?.title ?? name,
                            value,
                        ),
                    )
                    .join("")}</dl>`;
                try {
                    await showDialog(title, content, [{ value: "", label: t("Close") }]);
                } finally {
                    state.dialogOpen = false;
                }
            };
            let ignoreClickUntil = 0;
            const actionTarget = (target: EventTarget | null): boolean =>
                target instanceof Element &&
                (!target.closest("a, button, input, select, textarea") ||
                    !!target.closest(".subformat-card-open"));
            card.addEventListener(
                "click",
                (event) => {
                    if (state.dragging || Date.now() < ignoreClickUntil) {
                        event.preventDefault();
                        event.stopImmediatePropagation();
                        return;
                    }
                    if (
                        (event.target as Element).closest(".subformat-reference-list") ||
                        !actionTarget(event.target)
                    )
                        return;
                    if (event.detail === 0)
                        card.querySelector<HTMLButtonElement>(".subformat-card-open")?.focus({
                            preventScroll: true,
                        });
                    if (state.openSource) state.openSource(record.file, 1);
                    else void showDetails();
                },
                true,
            );
            card.draggable = !!grouping && writable && !state.busy;
            card.addEventListener("dragstart", (event) => {
                if (
                    !card.draggable ||
                    state.busy ||
                    !event.dataTransfer ||
                    (event.target as Element).closest(".subformat-reference-list")
                ) {
                    event.preventDefault();
                    return;
                }
                state.dragging = record.file;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("application/x-dooc-record", record.file);
                const rect = card.getBoundingClientRect();
                const preview = card.cloneNode(true) as HTMLElement;
                preview.classList.add("subformat-drag-preview");
                preview.hidden = true;
                preview.setAttribute("aria-hidden", "true");
                preview.inert = true;
                delete preview.dataset.recordFile;
                for (const element of preview.querySelectorAll("[id]"))
                    element.removeAttribute("id");
                Object.assign(preview.style, {
                    left: `${rect.left}px`,
                    top: `${rect.top}px`,
                    width: `${rect.width}px`,
                    height: `${rect.height}px`,
                    borderColor: getComputedStyle(card).borderColor,
                });
                // Render the full card in the page to avoid the browser's translucent drag image.
                const blank = document.createElement("canvas");
                blank.width = blank.height = 1;
                event.dataTransfer.setDragImage(blank, 0, 0);
                cards.append(preview);
                let x = 0;
                let y = 0;
                let frame = 0;
                const paint = () => {
                    frame = 0;
                    card.classList.add("is-dragging");
                    preview.hidden = false;
                    preview.style.transform = `translate(${x}px, ${y}px)`;
                };
                const follow = (next: DragEvent) => {
                    x = next.clientX - event.clientX;
                    y = next.clientY - event.clientY;
                    if (!frame) frame = requestAnimationFrame(paint);
                    const over = (next.target as Element).closest?.(".subformat-cards");
                    for (const target of columns.querySelectorAll(".is-drop-target"))
                        if (target !== over) target.classList.remove("is-drop-target");
                };
                const stop = () => {
                    cancelAnimationFrame(frame);
                    const from = preview.hidden ? undefined : preview.getBoundingClientRect();
                    preview.remove();
                    state.dragging = undefined;
                    state.stopDrag = undefined;
                    ignoreClickUntil = Date.now() + 250;
                    card.classList.remove("is-dragging");
                    for (const target of columns.querySelectorAll(".is-drop-target"))
                        target.classList.remove("is-drop-target");
                    document.removeEventListener("dragover", follow, true);
                    document.removeEventListener("drop", stop);
                    document.removeEventListener("dragend", stop, true);
                    card.removeEventListener("dragend", stop);
                    if (!state.busy && from) void settleCards(new Map([[card, from]]));
                };
                state.stopDrag = stop;
                document.addEventListener("dragover", follow, true);
                // Keep the active record until the destination handles the drop.
                document.addEventListener("drop", stop);
                document.addEventListener("dragend", stop, true);
                card.addEventListener("dragend", stop);
                frame = requestAnimationFrame(paint);
            });
            if (grouping && writable) {
                const label = document.createElement("label");
                label.textContent = grouping.title;
                const select = document.createElement("select");
                select.disabled = !writable || state.busy;
                if (!Object.hasOwn(record.data, grouping.name))
                    select.add(new Option(t("Unassigned"), "", true, true));
                grouping.enum?.forEach((item, index) => {
                    select.add(
                        new Option(
                            String(item),
                            String(index),
                            false,
                            record.data[grouping.name] === item,
                        ),
                    );
                });
                select.addEventListener("change", () => {
                    if (select.value !== "")
                        void move(record, grouping.enum?.[Number(select.value)]);
                });
                label.append(select);
                details.append(label);
            }
            cards.append(card);
        }
        columns.append(column);
    }
    columns.scrollLeft = scrollLeft;
};
