import {
    defaultPreviewSettings,
    PREVIEWERS,
    type PreviewSettings,
    parsePreviewSettings,
} from "../core/previewers.js";
import { confirmDialog, showDialog, showNotice } from "./edit-dialog.js";
import type { HmrBridge } from "./hmr.js";
import { t } from "./i18n.js";
import type { PreviewSettingsSnapshot } from "./preview-settings.js";

const icon = (path: string): string =>
    `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const COPY = icon(
    '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M12 3H5a2 2 0 0 0-2 2v7"/>',
);
const REMOVE = icon('<path d="M5 5l10 10M15 5 5 15"/>');
const ADD = icon('<path d="M10 3v14M3 10h14"/>');
const INFO = icon('<circle cx="10" cy="10" r="8"/><path d="M10 9v5m0-8h.01"/>');

const button = (label: string, markup?: string): HTMLButtonElement => {
    const el = document.createElement("button");
    el.type = "button";
    el.title = t(label);
    el.setAttribute("aria-label", t(label));
    if (markup) {
        el.innerHTML = markup;
        el.className = "preview-icon";
    } else el.textContent = t(label);
    return el;
};

export const mountPreviewSettings = (): void => {
    const trigger = document.getElementById("preview-settings-open");
    if (!trigger) return;
    trigger.addEventListener("click", () => {
        void openSettings();
    });
};

const openSettings = async (): Promise<void> => {
    if (document.querySelector(".preview-settings")) return;
    const body = document.createElement("div");
    body.className = "preview-settings";
    const style = document.createElement("style");
    style.textContent = `
        .app-dialog:has(.preview-settings) { width:min(760px,calc(100vw - 24px)); height:min(690px,calc(100dvh - 24px)); padding:20px; overflow:hidden; }
        .app-dialog:has(.preview-settings)[open] { display:flex; flex-direction:column; gap:14px; }
        .app-dialog:has(.preview-settings) h2 { margin:0; flex:none; }
        .preview-settings { flex:1; min-height:0; overflow:auto; scrollbar-gutter:stable; }
        .preview-settings fieldset { border:0; padding:0; margin:0 0 20px; min-width:0; }
        .preview-settings legend { padding:0 0 8px; font-weight:500; }
        .preview-settings table { width:100%; border-collapse:collapse; table-layout:fixed; }
        .preview-settings th, .preview-settings td { padding:6px; border-bottom:1px solid var(--c-line); text-align:left; vertical-align:middle; }
        .preview-settings th { font-weight:400; color:var(--c-fg-muted); }
        .preview-settings .preview-kind { width:100px; }
        .preview-settings .preview-actions { width:90px; text-align:center; white-space:nowrap; }
        .preview-settings textarea { display:block; width:100%; min-width:0; height:38px; min-height:38px; max-height:180px; resize:vertical; padding:8px; font:inherit; font-family:var(--doc-mono); color:var(--c-fg); background:var(--c-bg0); border:1px solid var(--c-line); border-radius:4px; }
        .preview-settings textarea:focus { border-color:var(--c-accent); }
        .app-dialog:has(.preview-settings) button.preview-icon { display:inline-flex; align-items:center; justify-content:center; width:34px; height:34px; padding:0; vertical-align:middle; }
        .app-dialog:has(.preview-settings) .dialog-actions { flex:none; flex-wrap:nowrap; align-items:center; }
        .app-dialog:has(.preview-settings) .preview-help { margin-right:auto; }
        .preview-save { width:8em; min-height:34px; }
        .preview-save[data-state="saved"] { color:var(--c-ok); }
        .preview-save[data-state="error"] { color:var(--c-danger); }
        .app-dialog:has(.preview-settings) button:disabled { cursor:default; opacity:.5; }
        @media(max-width:480px) { .app-dialog:has(.preview-settings) { padding:12px; } .preview-settings .preview-kind { width:80px; } .preview-settings th,.preview-settings td { padding:4px; } }
    `;
    body.append(style);
    const formats = document.createElement("fieldset");
    const domains = document.createElement("fieldset");
    const table = (
        parent: HTMLElement,
        label: string,
        headings: string[],
    ): HTMLTableSectionElement => {
        const legend = document.createElement("legend");
        legend.textContent = t(label);
        const element = document.createElement("table");
        element.setAttribute("aria-label", t(label));
        const head = element.createTHead().insertRow();
        for (const [i, text] of headings.entries()) {
            const th = document.createElement("th");
            th.scope = "col";
            th.textContent = t(text);
            if (headings.length === 2 && i === 0 && label === "File formats")
                th.className = "preview-kind";
            if (i === 1 && label === "Allowed domains") th.className = "preview-actions";
            head.append(th);
        }
        parent.append(legend, element);
        return element.createTBody();
    };
    const formatRows = table(formats, "File formats", ["Previewer", "Extensions"]);
    const domainRows = table(domains, "Allowed domains", ["Domain", "Actions"]);
    body.append(formats, domains);
    const inputs = new Map<string, HTMLTextAreaElement>();
    let snapshot: PreviewSettingsSnapshot | undefined;
    let dirty = false;
    let busy = false;
    const beforeUnload = (event: BeforeUnloadEvent): void => {
        if (dirty || busy) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    // Resource pages normally reload on content changes; keep their settings dialog open.
    const hmr = (window as Window & { __docsHmr?: HmrBridge }).__docsHmr;
    let changed = false;
    const holdContent = (): void => {
        changed = true;
    };
    if (hmr && !hmr.onContent) hmr.onContent = holdContent;
    const finished = showDialog(t("Preview settings"), body, [{ value: "", label: t("Close") }]);
    const dialog = body.closest("dialog");
    const footer = dialog?.querySelector(".dialog-actions");
    if (!dialog || !footer) return;
    const help = button("Preview settings", INFO);
    help.classList.add("preview-help");
    help.addEventListener("click", () => {
        void showNotice(
            t(
                "Register file extensions for previewers. Domains match exactly, including subdomains. External files use HTTPS without authentication. These registrations do not grant script execution.",
            ),
        );
    });
    const reload = button("Reload");
    const save = button("Save");
    save.className = "preview-save";
    footer.prepend(help, reload, save);
    const setState = (
        state: "loading" | "dirty" | "saving" | "saved" | "error",
        error?: string,
    ): void => {
        const label = t(
            { loading: "Loading", dirty: "Save", saving: "Saving", saved: "Saved", error: "Retry" }[
                state
            ],
        );
        save.dataset.state = state;
        save.textContent = label;
        save.title = error ?? label;
        save.setAttribute("aria-label", error ? `${label}: ${error}` : label);
        busy = state === "loading" || state === "saving";
        save.setAttribute("aria-busy", String(busy));
        save.disabled = busy || state === "saved";
        reload.disabled = busy;
        formats.disabled = domains.disabled = busy || !snapshot;
    };
    const change = (): void => {
        dirty = true;
        setState("dirty");
    };
    const field = (label: string, value: string, placeholder: string): HTMLTextAreaElement => {
        const input = document.createElement("textarea");
        input.rows = 1;
        input.value = value;
        input.placeholder = placeholder;
        input.spellcheck = false;
        input.autocomplete = "off";
        input.setAttribute("aria-label", label);
        input.addEventListener("input", change);
        return input;
    };
    const addDomain = (value: string): HTMLTextAreaElement => {
        const row = domainRows.insertRow();
        const input = field(t("Domain"), value, "example.com");
        row.insertCell().append(input);
        const actions = row.insertCell();
        actions.className = "preview-actions";
        const copy = button("Copy domain", COPY);
        copy.addEventListener("click", async () => {
            copy.disabled = true;
            try {
                await navigator.clipboard.writeText(input.value);
                copy.title = t("Copied");
            } catch (error) {
                copy.title = String(error);
            } finally {
                copy.disabled = false;
            }
        });
        const remove = button("Remove domain", REMOVE);
        remove.addEventListener("click", () => {
            row.remove();
            change();
        });
        actions.append(copy, remove);
        return input;
    };
    const render = (settings: PreviewSettings): void => {
        const heights = new Map([...inputs].map(([id, input]) => [id, input.style.height]));
        const domainHeights = new Map(
            [...domainRows.querySelectorAll("textarea")].map((input) => [
                input.value.trim().toLowerCase(),
                input.style.height,
            ]),
        );
        formatRows.replaceChildren();
        inputs.clear();
        for (const previewer of PREVIEWERS) {
            const row = formatRows.insertRow();
            const name = document.createElement("th");
            name.scope = "row";
            name.textContent = t(previewer.label);
            row.append(name);
            const input = field(
                `${t(previewer.label)}: ${t("Extensions")}`,
                settings.formats[previewer.id].join(", "),
                previewer.extensions.join(", "),
            );
            inputs.set(previewer.id, input);
            input.style.height = heights.get(previewer.id) ?? "";
            row.insertCell().append(input);
        }
        domainRows.replaceChildren();
        for (const domain of settings.domains)
            addDomain(domain).style.height = domainHeights.get(domain) ?? "";
        const row = domainRows.insertRow();
        const input = field(t("New domain"), "", "example.com");
        input.dataset.newDomain = "";
        row.insertCell().append(input);
        const actions = row.insertCell();
        actions.className = "preview-actions";
        const add = button("Add domain", ADD);
        add.addEventListener("click", () => {
            if (!input.value.trim()) {
                input.focus();
                return;
            }
            const added = addDomain(input.value.trim());
            domainRows.append(row);
            input.value = "";
            change();
            added.focus();
        });
        actions.append(add);
    };
    const request = async (input: object): Promise<PreviewSettingsSnapshot> => {
        const response = await fetch("/api/preview-settings", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? String(response.status));
        return result as PreviewSettingsSnapshot;
    };
    const load = async (): Promise<void> => {
        if (dirty && !(await confirmDialog(t("Discard changes"), t("Reload")))) return;
        setState("loading");
        try {
            snapshot = await request({ action: "read" });
            render(snapshot.settings);
            dirty = false;
            setState("saved");
        } catch (error) {
            setState("error", String(error));
        }
    };
    reload.addEventListener("click", () => {
        void load();
    });
    save.addEventListener("click", async () => {
        if (!snapshot) {
            await load();
            return;
        }
        setState("saving");
        try {
            const settings = parsePreviewSettings({
                domains: [...domainRows.querySelectorAll("textarea")]
                    .map((input) => input.value.trim())
                    .filter(Boolean),
                formats: Object.fromEntries(
                    [...inputs].map(([id, input]) => [
                        id,
                        input.value
                            .trim()
                            .toLowerCase()
                            .split(/[\s,]+/)
                            .filter(Boolean),
                    ]),
                ),
            });
            snapshot = await request({ action: "save", base: snapshot.base, settings });
            render(snapshot.settings);
            dirty = false;
            setState("saved");
        } catch (error) {
            setState("error", String(error));
            await showNotice(String(error));
        }
    });
    const close = async (): Promise<void> => {
        if (!busy && (!dirty || (await confirmDialog(t("Discard changes"), t("Close")))))
            dialog.close();
    };
    dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        void close();
    });
    const closeButton = footer.lastElementChild;
    closeButton?.addEventListener(
        "click",
        (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            void close();
        },
        { capture: true },
    );
    render(defaultPreviewSettings());
    void load();
    await finished;
    window.removeEventListener("beforeunload", beforeUnload);
    if (hmr?.onContent === holdContent) {
        delete hmr.onContent;
        if (changed) location.reload();
    }
};
