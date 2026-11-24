export const DARK_C = `
  color-scheme: dark;
  --c-bg0:#101316; --c-bg1:#16191d; --c-surface:#1b1f24; --c-raised:#22272d;
  --c-line:#2a3037; --c-line-soft:#22272c;
  --c-fg:#f5f6f7; --c-fg-muted:#b4bac0; --c-fg-faint:#8a939b; --fw-body:400;
  --c-accent:#e65100; --c-ok:#4f9e6a; --c-danger:#c65b52; --c-warn:#c99a3a; --c-info:#6b8fbf;
  --c-shadow:rgba(0,0,0,.4);
  --doc-fg-4:#525a66; --doc-accent-2:#4a8bff; --doc-accent-fg:#ffffff;
  --doc-ok-2:#56d364; --doc-warn-2:#ffc14d; --doc-danger-2:#ff7a7a; --doc-info-2:#79b0ff;`;
export const LIGHT_C = `
  color-scheme: light;
  --c-bg0:#ffffff; --c-bg1:#f5f7f9; --c-surface:#fbfcfd; --c-raised:#e9edf2;
  --c-line:#d5dae0; --c-line-soft:#e4e8ec;
  --c-fg:#1a1e23; --c-fg-muted:#5a636c; --c-fg-faint:#687079; --fw-body:300;
  --c-accent:#c24800; --c-ok:#2f7d4f; --c-danger:#b23c31; --c-warn:#8a6516; --c-info:#3a6ea5;
  --c-shadow:rgba(15,23,32,.14);
  --doc-fg-4:#9099a8; --doc-accent-2:#0277bd; --doc-accent-fg:#ffffff;
  --doc-ok-2:#2ea043; --doc-warn-2:#f59f00; --doc-danger-2:#f04848; --doc-info-2:#4a8bff;`;

/** Run in the head before any themed content can be painted. */
export const initializeThemes = (themes = ["light", "dark"]): void => {
    const root = document.documentElement;
    const read = (key: string): string => {
        try {
            const value = localStorage.getItem(key);
            return value === "light" || value === "dark" ? value : "auto";
        } catch {
            return "auto";
        }
    };
    const stored = read("docs-preview:theme");
    root.dataset.theme =
        themes.length === 1 ? (themes[0] ?? "auto") : themes.includes(stored) ? stored : "auto";
    root.dataset.editorTheme = read("docs-editor:theme");
};

/** Self-contained because published readers embed this function directly. */
export const mountThemePickers = (
    icons: Record<string, string>,
    themes = ["light", "dark"],
): void => {
    const root = document.documentElement;
    const documentChoices = themes.length === 1 ? themes : ["auto", ...themes];
    let documentDefault = root.dataset.theme ?? "auto";
    if (!documentChoices.includes(documentDefault)) documentDefault = documentChoices[0] ?? "auto";
    root.dataset.theme = documentDefault;
    root.dataset.editorTheme ??= "auto";
    const t = (key: string): string =>
        (window as Window & { __docsTranslate?: (key: string) => string }).__docsTranslate?.(key) ??
        key;
    const popup = document.createElement("div");
    popup.className = "theme-picker";
    popup.id = "theme-picker";
    popup.popover = "auto";
    popup.setAttribute("role", "menu");
    document.body.append(popup);
    let trigger: HTMLButtonElement | undefined;
    const target = (button: HTMLButtonElement): HTMLElement =>
        button.dataset.themePicker === "editor"
            ? root
            : (button.closest<HTMLElement>(".preview-pane") ?? root);
    const current = (button: HTMLButtonElement): string =>
        button.dataset.themePicker === "editor"
            ? (root.dataset.editorTheme ?? "auto")
            : (target(button).dataset.theme ?? "auto");
    const previewThemes = new WeakMap<HTMLElement, string>();
    const sync = (): void => {
        for (const pane of document.querySelectorAll<HTMLElement>(".preview-pane")) {
            if (pane.classList.contains("resources-pane")) {
                if (!previewThemes.has(pane))
                    previewThemes.set(pane, pane.dataset.theme ?? documentDefault);
            } else if (previewThemes.has(pane)) {
                pane.dataset.theme = previewThemes.get(pane);
                previewThemes.delete(pane);
            }
        }
        for (const pane of document.querySelectorAll<HTMLElement>(
            ".resources-pane, #sidebar, #panel",
        ))
            if (pane.dataset.theme !== root.dataset.editorTheme)
                pane.dataset.theme = root.dataset.editorTheme;
        for (const pane of document.querySelectorAll<HTMLElement>(
            ".preview-pane:not(.resources-pane)",
        ))
            if (!documentChoices.includes(pane.dataset.theme ?? ""))
                pane.dataset.theme = documentDefault;
        for (const button of document.querySelectorAll<HTMLButtonElement>("[data-theme-picker]")) {
            const value = current(button);
            const markup = icons[value === "auto" ? "" : value] ?? "";
            const valueLabel = button.querySelector<HTMLElement>("[data-picker-value]");
            if (button.dataset.themeIcon !== value) {
                const icon = valueLabel
                    ? button.closest(".editor-setting")?.querySelector("[data-setting-theme-icon]")
                    : button;
                if (icon) icon.innerHTML = markup;
                button.dataset.themeIcon = value;
            }
            const name = t(value === "auto" ? "Auto" : value === "light" ? "Light" : "Dark");
            if (valueLabel && valueLabel.textContent !== name) valueLabel.textContent = name;
            const label = t(
                button.dataset.themePicker === "editor" ? "Editor theme" : "Preview theme",
            );
            button.title = `${label}: ${name}`;
            button.setAttribute("aria-label", button.title);
            button.setAttribute("aria-haspopup", "menu");
            button.setAttribute("aria-controls", popup.id);
        }
    };
    document.addEventListener("click", (event) => {
        const button =
            event.target instanceof Element
                ? event.target.closest<HTMLButtonElement>("[data-theme-picker]")
                : null;
        if (!button) return;
        if (trigger === button && popup.matches(":popover-open")) {
            popup.hidePopover();
            return;
        }
        if (popup.matches(":popover-open")) popup.hidePopover();
        trigger = button;
        popup.dataset.theme = current(button);
        popup.replaceChildren();
        for (const value of button.dataset.themePicker === "editor"
            ? ["auto", "light", "dark"]
            : documentChoices) {
            const option = document.createElement("button");
            option.type = "button";
            option.dataset.value = value;
            option.setAttribute("role", "menuitemradio");
            option.setAttribute("aria-checked", String(value === current(button)));
            option.innerHTML = icons[value === "auto" ? "" : value] ?? "";
            option.append(
                document.createTextNode(
                    t(value === "auto" ? "Auto" : value === "light" ? "Light" : "Dark"),
                ),
            );
            popup.append(option);
        }
        const rect = button.getBoundingClientRect();
        popup.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 156))}px`;
        popup.style.top = `${Math.min(rect.bottom + 6, innerHeight - 140)}px`;
        popup.showPopover();
        button.setAttribute("aria-expanded", "true");
        popup.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    });
    popup.addEventListener("click", (event) => {
        const option =
            event.target instanceof Element
                ? event.target.closest<HTMLElement>("[data-value]")
                : null;
        if (!option || !trigger) return;
        const value = option.dataset.value ?? "auto";
        const editor = trigger.dataset.themePicker === "editor";
        if (editor) root.dataset.editorTheme = value;
        else {
            target(trigger).dataset.theme = value;
            documentDefault = value;
        }
        try {
            localStorage.setItem(editor ? "docs-editor:theme" : "docs-preview:theme", value);
        } catch {
            /* Theme selection still works without persistence. */
        }
        popup.hidePopover();
        trigger.focus();
        sync();
    });
    popup.addEventListener("keydown", (event) => {
        const options = [...popup.querySelectorAll<HTMLButtonElement>("button")];
        const index = options.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            options[
                (index + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length
            ]?.focus();
        }
        if (event.key === "Escape") trigger?.focus();
    });
    popup.addEventListener("toggle", () => {
        if (!popup.matches(":popover-open")) trigger?.setAttribute("aria-expanded", "false");
    });
    document.addEventListener("docs:ui-language", sync);
    new MutationObserver(sync).observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-theme", "data-editor-theme"],
    });
    sync();
};
