import { isNode, parseDocument } from "yaml";
import { migrateDocumentIcon } from "../../engine/src/core/content-metadata.js";
import { escapeHtml } from "../../engine/src/core/escape-html.js";
import {
    isFormat,
    migrateCollections,
    REFERENCE_LIBRARIES,
} from "../../engine/src/core/formats.js";
import { pageWorkspace } from "../../workspace/src/client.js";
import { clientPath } from "../../workspace/src/client-path.js";
import {
    workspaceConnection,
    workspaceFetch,
    workspaceId,
} from "../../workspace/src/connection.js";
import { createTextfileEditors } from "./edit-textfile.js";
import { t } from "./i18n.js";
import { updateManifestSetting } from "./manifest-editor.js";

const hosts = new Set<HTMLElement>();
let sequence = 0;
export const hasManifestDraft = (scope?: HTMLElement): boolean =>
    [...hosts].some((host) => (!scope || scope.contains(host)) && host.dataset.dirty === "true");

export const mountManifest = (
    host: HTMLElement | null,
    workspace = workspaceId(),
    sharedFiles?: ReturnType<typeof createTextfileEditors>,
): (() => void) | undefined => {
    if (!host || host.dataset.mounted) return;
    host.dataset.mounted = "true";
    hosts.add(host);
    const file = host.dataset.file ?? "dooc.yaml";
    const readOnly = !!workspaceConnection(workspace)?.readOnly;
    const client = pageWorkspace(workspace);
    const files =
        sharedFiles ??
        createTextfileEditors(
            [],
            () => document.dispatchEvent(new Event("docs:files-changed")),
            () => {},
            workspace,
            () => localStorage.getItem("docs-edit:autosave") !== "0",
        );
    let raw = "";
    let busy = true;
    let disposed = false;
    let sourceView = false;
    let valid = true;
    const id = `manifest-${++sequence}`;
    const text = (key: string) => escapeHtml(t(key));
    host.innerHTML = `<header class="manifest-toolbar"><h1>${escapeHtml(file)}</h1></header>
<p class="manifest-error err" role="alert" hidden></p>
${sharedFiles ? "" : `<div class="resource-tabs manifest-tabs" role="tablist" aria-label="${text("Manifest editor")}"><button type="button" role="tab" id="${id}-settings-tab" aria-controls="${id}-settings" aria-selected="true">${text("Settings")}</button><button type="button" role="tab" id="${id}-yaml-tab" aria-controls="${id}-yaml" aria-selected="false" tabindex="-1">YAML</button></div>`}
<form id="${id}-settings"${sharedFiles ? ` aria-label="${text("Settings")}"` : ` role="tabpanel" aria-labelledby="${id}-settings-tab"`}><fieldset class="manifest-fields manifest-grid"></fieldset></form>
<div id="${id}-yaml" class="manifest-source" role="tabpanel" aria-labelledby="${id}-yaml-tab" hidden></div>`;
    const error = host.querySelector('[role="alert"]') as HTMLElement;
    const form = host.querySelector("form") as HTMLFormElement;
    const fields = host.querySelector("fieldset") as HTMLFieldSetElement;
    const source = host.querySelector(".manifest-source") as HTMLElement;
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const suggestions = document.createElement("div");
    suggestions.className = "language-picker manifest-completions";
    suggestions.popover = "manual";
    const options = document.createElement("div");
    options.className = "language-options";
    options.id = `${id}-paths`;
    options.setAttribute("role", "listbox");
    suggestions.append(options);
    host.append(suggestions);
    let completionInput: HTMLInputElement | undefined;
    let completionAnchor: DOMRect | undefined;
    let completionRevision = 0;
    let activeOption = -1;
    const closeCompletion = () => {
        completionRevision++;
        completionInput?.setAttribute("aria-expanded", "false");
        completionInput?.removeAttribute("aria-activedescendant");
        completionInput = undefined;
        completionAnchor = undefined;
        activeOption = -1;
        if (suggestions.matches(":popover-open")) suggestions.hidePopover();
    };
    const positionCompletion = (): boolean => {
        if (!completionInput) return false;
        const rect = completionInput.getBoundingClientRect();
        if (!completionInput.checkVisibility() || rect.bottom < 0 || rect.top > innerHeight) {
            closeCompletion();
            return false;
        }
        const below = innerHeight - rect.bottom;
        const above = below < 252 && rect.top > below;
        const width = Math.min(rect.width, innerWidth - 16);
        completionAnchor = rect;
        Object.assign(suggestions.style, {
            width: `${width}px`,
            left: `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`,
            maxHeight: `${Math.max(0, Math.min(240, (above ? rect.top : below) - 12))}px`,
            top: above ? "auto" : `${rect.bottom + 4}px`,
            bottom: above ? `${innerHeight - rect.top + 4}px` : "auto",
        });
        return true;
    };
    const highlightCompletion = (index: number) => {
        const items = [...options.querySelectorAll("button")];
        if (!items.length || !completionInput) return;
        activeOption = (index + items.length) % items.length;
        items.forEach((item, i) => {
            item.dataset.active = String(i === activeOption);
            item.setAttribute("aria-selected", String(i === activeOption));
        });
        const item = items[activeOption];
        if (!item) return;
        completionInput.setAttribute("aria-activedescendant", item.id);
        item.scrollIntoView({ block: "nearest" });
    };
    const chooseCompletion = (item: HTMLButtonElement) => {
        const input = completionInput;
        if (!input || busy || readOnly || input.matches(":disabled")) return;
        const value = input.dataset.folder
            ? (item.textContent ?? "").replace(/\/$/, "")
            : (item.textContent ?? "");
        closeCompletion();
        input.value = value;
        input.setSelectionRange(value.length, value.length);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        if (input.dataset.folder || !value.endsWith("/")) closeCompletion();
    };
    options.addEventListener("pointerdown", (event) => event.preventDefault());
    options.addEventListener("click", (event) => {
        const item = (event.target as Element).closest<HTMLButtonElement>("button");
        if (item) chooseCompletion(item);
    });
    const dismissCompletion = (event: Event) => {
        if (event.type === "scroll") {
            const rect = completionInput?.getBoundingClientRect();
            if (
                !completionAnchor ||
                (rect?.top === completionAnchor.top && rect?.left === completionAnchor.left)
            )
                return;
        }
        if (
            event.target instanceof Node &&
            event.target !== completionInput &&
            !suggestions.contains(event.target)
        )
            closeCompletion();
    };
    const repositionCompletion = () => {
        if (suggestions.matches(":popover-open")) positionCompletion();
    };
    const completionResize = new ResizeObserver(repositionCompletion);
    completionResize.observe(host);
    document.addEventListener("pointerdown", dismissCompletion);
    document.addEventListener("scroll", dismissCompletion, true);
    window.addEventListener("resize", repositionCompletion);
    const showError = (message = "") => {
        error.textContent = message;
        error.hidden = !message;
    };
    const state = () => {
        const snapshot = files.snapshot(file);
        busy = snapshot.content === undefined;
        host.dataset.dirty = String(snapshot.dirty);
        fields.disabled = busy || readOnly || !valid;
        if (fields.disabled) closeCompletion();
        host.setAttribute("aria-busy", String(busy));
        if (snapshot.error) showError(snapshot.error);
        document.dispatchEvent(new Event("docs:manifest-draft"));
    };
    const change = (path: string[], value: unknown) => {
        try {
            raw = updateManifestSetting(raw, path, value);
            showError();
            files.update(file, raw);
        } catch (cause) {
            showError(cause instanceof Error ? cause.message : String(cause));
        }
    };
    const lookup = async (input: HTMLInputElement): Promise<boolean> => {
        closeCompletion();
        if (disposed || busy || readOnly || input !== document.activeElement) return false;
        completionInput = input;
        const request = completionRevision;
        try {
            const paths = await client.request<string[]>("files", {
                action: "complete",
                prefix: input.value,
            });
            if (disposed || request !== completionRevision || !input.isConnected) return false;
            const candidates = paths.filter(
                (path) => path !== input.value && (!input.dataset.folder || path.endsWith("/")),
            );
            if (!candidates.length) {
                closeCompletion();
                return false;
            }
            options.setAttribute("aria-label", input.name);
            options.replaceChildren(
                ...candidates.map((path, index) => {
                    const item = document.createElement("button");
                    item.type = "button";
                    item.tabIndex = -1;
                    item.id = `${id}-path-${index}`;
                    item.textContent = item.title = path;
                    item.setAttribute("role", "option");
                    item.setAttribute("aria-selected", "false");
                    return item;
                }),
            );
            if (!positionCompletion()) return false;
            suggestions.showPopover();
            options.scrollTop = 0;
            input.setAttribute("aria-expanded", "true");
            return true;
        } catch {
            // Paths remain editable while the workspace is disconnected.
            return false;
        }
    };
    const complete = (input: HTMLInputElement) => {
        input.classList.add("manifest-path-input");
        input.autocomplete = "off";
        input.spellcheck = false;
        input.setAttribute("role", "combobox");
        input.setAttribute("aria-autocomplete", "list");
        input.setAttribute("aria-controls", options.id);
        input.setAttribute("aria-expanded", "false");
        input.addEventListener("input", () => void lookup(input));
        input.addEventListener("focus", () => void lookup(input));
        input.addEventListener("click", () => {
            if (completionInput !== input) void lookup(input);
        });
        input.addEventListener("blur", () => {
            if (completionInput === input) closeCompletion();
        });
        input.addEventListener("keydown", (event) => {
            if (event.isComposing) return;
            const open = completionInput === input && suggestions.matches(":popover-open");
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const next = event.key === "ArrowDown" ? 1 : -1;
                if (open)
                    highlightCompletion(activeOption < 0 && next < 0 ? -1 : activeOption + next);
                else
                    void lookup(input).then((shown) => {
                        if (shown) highlightCompletion(next > 0 ? 0 : -1);
                    });
            } else if (open && event.key === "Enter" && activeOption >= 0) {
                event.preventDefault();
                chooseCompletion(options.children[activeOption] as HTMLButtonElement);
            } else if (completionInput === input && event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeCompletion();
            } else if (event.key === "Tab") closeCompletion();
        });
    };
    const settings = (): boolean => {
        closeCompletion();
        const yaml = parseDocument(raw);
        if (yaml.errors.length) {
            showError(yaml.errors.map((item) => item.message).join("\n"));
            return false;
        }
        if (!yaml.has("document")) {
            showError(t("Edit this legacy manifest in YAML."));
            return false;
        }
        try {
            migrateDocumentIcon(yaml);
            migrateCollections(yaml);
        } catch (cause) {
            showError(cause instanceof Error ? cause.message : String(cause));
            return false;
        }
        const valueAt = (path: string[]): unknown => {
            const value = yaml.getIn(path);
            return isNode(value) ? value.toJSON() : value;
        };
        const listAt = (path: string[]): string[] => {
            const value = valueAt(path);
            return Array.isArray(value)
                ? value.filter((item): item is string => typeof item === "string")
                : [];
        };
        const expanded = new Map(
            [...fields.querySelectorAll<HTMLDetailsElement>("details")].map((group) => [
                group.dataset.path,
                group.open,
            ]),
        );
        fields.replaceChildren();
        const group = (parent: HTMLElement, path: string[], open = false) => {
            const details = document.createElement("details");
            details.className = "manifest-group";
            details.dataset.path = path.join(".");
            details.open = expanded.get(details.dataset.path) ?? open;
            details.innerHTML = `<summary>${escapeHtml(path.at(-1) ?? "")}</summary><div class="manifest-grid"></div>`;
            parent.append(details);
            return details.querySelector(".manifest-grid") as HTMLElement;
        };
        const field = (
            parent: HTMLElement,
            path: string[],
            options: {
                fallback?: string;
                path?: boolean;
                list?: boolean;
                boolean?: boolean;
                choices?: [string, string][];
            } = {},
        ) => {
            const label = document.createElement("label");
            label.className = "manifest-field";
            const caption = document.createElement("span");
            caption.className = "subformat-control-label";
            caption.textContent = path.at(-1) ?? "";
            const input = document.createElement(options.choices ? "select" : "input");
            input.name = path.join(".");
            if (input instanceof HTMLSelectElement)
                for (const [value, title] of options.choices ?? [])
                    input.add(new Option(t(title), value));
            const value = valueAt(path);
            input.value =
                value === undefined || value === null
                    ? (options.fallback ?? "")
                    : Array.isArray(value)
                      ? value.join(", ")
                      : String(value);
            if (path.at(-1) === "themes" && Array.isArray(value) && value.length === 2)
                input.value = "light, dark";
            label.append(caption, input);
            parent.append(label);
            if (options.path && input instanceof HTMLInputElement) complete(input);
            input.addEventListener(input instanceof HTMLSelectElement ? "change" : "input", () => {
                const value = input.value.trim();
                change(
                    path,
                    !value
                        ? undefined
                        : options.list
                          ? value.split(/[,\s]+/).filter(Boolean)
                          : options.boolean || path.at(-1) === "default_layout"
                            ? value === "true"
                            : value,
                );
            });
            return input;
        };
        const paths = (parent: HTMLElement, path: string[], folder = false) => {
            const section = document.createElement("fieldset");
            section.classList.add("manifest-paths");
            const legend = document.createElement("legend");
            legend.textContent = path.at(-1) ?? "";
            const rows = document.createElement("div");
            const button = (title: string, icon: string) => {
                const button = document.createElement("button");
                button.type = "button";
                button.title = t(title);
                button.setAttribute("aria-label", t(title));
                button.innerHTML = `<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="${icon}"/></svg>`;
                return button;
            };
            const add = button(folder ? "Add folder" : "Add file", "M10 4v12M4 10h12");
            const update = () =>
                change(
                    path,
                    [...rows.querySelectorAll("input")]
                        .map((input) => input.value.trim())
                        .filter(Boolean),
                );
            const row = (value = "") => {
                const row = document.createElement("div");
                row.className = "manifest-path-row";
                const input = document.createElement("input");
                input.value = value;
                input.name = path.join(".");
                if (folder) input.dataset.folder = "true";
                input.setAttribute("aria-label", path.join("."));
                const remove = button("Remove path", "m5 5 10 10M15 5 5 15");
                remove.setAttribute(
                    "aria-label",
                    `${t("Remove path")}: ${value || path.join(".")}`,
                );
                row.append(input, remove);
                rows.append(row);
                complete(input);
                input.addEventListener("input", update);
                remove.onclick = () => {
                    row.remove();
                    update();
                    add.focus();
                };
                return input;
            };
            section.append(legend, rows, add);
            parent.append(section);
            const values = listAt(path);
            for (const value of values) row(value);
            if (!values.length) row();
            add.onclick = () => row().focus();
        };
        const general = group(fields, ["document"], true);
        field(general, ["document", "title"]);
        if (
            !yaml.getIn(["document", "library"]) &&
            !yaml.getIn(["document", "format"]) &&
            !yaml.getIn(["document", "subformat"])
        )
            field(general, ["document", "url"], { path: true });
        const icon = group(general, ["document", "icon"]);
        const sharedIcon = valueAt(["document", "icon"]);
        for (const theme of ["light", "dark"])
            field(icon, ["document", "icon", theme], {
                path: true,
                fallback: typeof sharedIcon === "string" ? sharedIcon : undefined,
            });
        const system = group(fields, ["system"], true);
        const library = group(system, ["system", "library"]);
        const views = valueAt(["system", "library"]) ?? REFERENCE_LIBRARIES;
        for (const view of REFERENCE_LIBRARIES) {
            const label = document.createElement("label");
            label.className = "manifest-reference";
            const input = document.createElement("input");
            input.type = "checkbox";
            input.name = "system.library";
            input.value = view;
            input.checked = Array.isArray(views) && views.includes(view);
            label.append(input, view);
            library.append(label);
            input.onchange = () =>
                change(
                    ["system", "library"],
                    [...library.querySelectorAll<HTMLInputElement>("input:checked")].map(
                        (input) => input.value,
                    ),
                );
        }
        const formats = group(system, ["system", "format"], true);
        for (const format of Object.keys((valueAt(["system", "format"]) as object) ?? {})) {
            const path = ["system", "format", format];
            const section = group(formats, path, true);
            field(section, [...path, "codeblock"], {
                boolean: true,
                fallback: "true",
                choices: [
                    ["true", "true"],
                    ["false", "false"],
                ],
            });
            paths(section, [...path, "folders"], true);
            paths(section, [...path, "files"]);
            const remove = document.createElement("button");
            remove.type = "button";
            remove.title = remove.ariaLabel = `${t("Remove format")}: ${format}`;
            remove.className = "manifest-remove-format";
            remove.innerHTML =
                '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 5h12M8 5V3h4v2M6 5l1 12h6l1-12M9 8v6M11 8v6"/></svg>';
            section.parentElement?.querySelector("summary")?.append(remove);
            remove.onclick = (event) => {
                event.preventDefault();
                change(path, undefined);
                settings();
                fields.querySelector<HTMLInputElement>('[name="format"]')?.focus();
            };
        }
        const add = document.createElement("div");
        add.className = "manifest-path-row";
        add.innerHTML = `<label class="manifest-field"><span class="subformat-control-label">format</span><input name="format" aria-label="format" autocomplete="off" spellcheck="false" list="${id}-formats"></label><button type="button" title="${text("Add format")}" aria-label="${text("Add format")}"><svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg></button><datalist id="${id}-formats"></datalist>`;
        formats.append(add);
        const extension = add.querySelector("input") as HTMLInputElement;
        const addFormat = () => {
            const format = extension.value.trim().replace(/^\./, "").toLowerCase();
            if (!isFormat(format) || yaml.hasIn(["system", "format", format])) {
                extension.setCustomValidity(t("Enter a new file extension"));
                extension.reportValidity();
                return;
            }
            change(["system", "format", format], { codeblock: true });
            settings();
            fields
                .querySelector<HTMLInputElement>(
                    `[name="system.format.${CSS.escape(format)}.folders"]`,
                )
                ?.focus();
        };
        extension.oninput = () => extension.setCustomValidity("");
        extension.onkeydown = (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                addFormat();
            }
        };
        add.querySelector("button")?.addEventListener("click", addFormat);
        void workspaceFetch("/api/formats?all=true", undefined, workspace)
            .then(async (response) => {
                if (!response.ok || !add.isConnected) return;
                const names: string[] = await response.json();
                add.querySelector("datalist")?.replaceChildren(
                    ...names.map((name) => new Option(name)),
                );
            })
            .catch(() => {});
        field(system, ["system", "default_lang"], { fallback: "eng" });
        field(system, ["system", "languages"], { list: true });
        field(system, ["system", "themes"], {
            list: true,
            choices: [
                ["", "Automatic"],
                ["light, dark", "Light and dark"],
                ["light", "Light"],
                ["dark", "Dark"],
            ],
        });
        field(system, ["system", "licence"], { path: true });
        const files = group(system, ["system", "files"]);
        field(files, ["system", "files", "default_layout"], {
            fallback: "true",
            choices: [
                ["true", "Enabled"],
                ["false", "Disabled"],
            ],
        });
        paths(system, ["system", "skills"]);
        field(fields, ["default_subformat_folder"], { path: true });
        const subformats = document.createElement("a");
        subformats.className = "manifest-schema-link";
        subformats.href = clientPath("/_subformats");
        subformats.textContent = "json_subformats";
        fields.append(subformats);
        return true;
    };
    const switchView = (yaml: boolean) => {
        closeCompletion();
        if (!yaml) {
            valid = settings();
            if (!valid) return;
        }
        sourceView = yaml;
        form.hidden = yaml;
        source.hidden = !yaml;
        tabs.forEach((tab, index) => {
            tab.setAttribute("aria-selected", String(index === Number(yaml)));
            tab.tabIndex = index === Number(yaml) ? 0 : -1;
        });
        state();
    };
    const save = () => files.save(file);
    tabs.forEach((tab, index) => {
        tab.onclick = () => switchView(!!index);
        tab.onkeydown = (event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index;
            switchView(!!next);
            tabs[Number(sourceView)]?.focus();
        };
    });
    form.onsubmit = (event) => {
        event.preventDefault();
        void save();
    };
    host.onkeydown = (event) => {
        if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
        event.preventDefault();
        event.stopPropagation();
        void save();
    };
    const disposeSource = sharedFiles ? undefined : files.mount(file, source);
    const unsubscribe = files.subscribe(file, () => {
        const content = files.content(file);
        if (content !== undefined && (busy || content !== raw)) {
            raw = content;
            showError();
            valid = settings();
            if (!sharedFiles && !valid) switchView(true);
        }
        state();
    });
    return () => {
        disposed = true;
        closeCompletion();
        completionResize.disconnect();
        document.removeEventListener("pointerdown", dismissCompletion);
        document.removeEventListener("scroll", dismissCompletion, true);
        window.removeEventListener("resize", repositionCompletion);
        hosts.delete(host);
        unsubscribe();
        disposeSource?.();
        document.dispatchEvent(new Event("docs:manifest-draft"));
    };
};
