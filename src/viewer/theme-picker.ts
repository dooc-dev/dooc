/** Self-contained because published viewers embed this function directly. */
export const mountThemePickers = (
    icons: Record<string, string>,
    themes = ["light", "dark"],
): void => {
    const root = document.documentElement;
    const documentChoices = themes.length === 1 ? themes : ["auto", ...themes];
    const read = (key: string): string => {
        try {
            const value = localStorage.getItem(key);
            return value === "light" || value === "dark" ? value : "auto";
        } catch {
            return "auto";
        }
    };
    let documentDefault = read("docs-preview:theme");
    if (!documentChoices.includes(documentDefault)) documentDefault = documentChoices[0] ?? "auto";
    root.dataset.theme = documentDefault;
    root.dataset.editorTheme = read("docs-editor:theme");
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
    const sync = (): void => {
        for (const pane of document.querySelectorAll<HTMLElement>(".resources-pane"))
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
            if (button.dataset.themeIcon !== value) {
                button.innerHTML = markup;
                button.dataset.themeIcon = value;
            }
            const label = t(
                button.dataset.themePicker === "editor" ? "Editor theme" : "Preview theme",
            );
            button.title = `${label}: ${t(value === "auto" ? "Auto" : value === "light" ? "Light" : "Dark")}`;
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
