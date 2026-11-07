import type { ProjectFont } from "../compiler/fonts.js";
import type { createFontSettings } from "./font-settings.js";

/** Self-contained because published viewers embed this function directly. */
export const mountFontPickers = async (
    createSettings: typeof createFontSettings,
    registered: readonly ProjectFont[],
): Promise<void> => {
    const settings = createSettings(registered);
    const root = document.documentElement;
    const t = (key: string): string =>
        (window as Window & { __docsTranslate?: (key: string) => string }).__docsTranslate?.(key) ??
        key;
    const popup = document.createElement("div");
    popup.className = "theme-picker font-picker";
    popup.id = "font-picker";
    popup.popover = "auto";
    popup.setAttribute("role", "menu");
    document.body.append(popup);
    let trigger: HTMLButtonElement | undefined;
    let busy = true;
    let message = "Loading fonts";
    const target = (button: HTMLButtonElement): "editor" | "viewer" =>
        button.dataset.fontPicker === "editor" ? "editor" : "viewer";
    const choices = (): Map<string, string> =>
        new Map([
            ["", t("Default font")],
            ...registered
                .filter((font) => settings.fonts.has(font.family))
                .map((font): [string, string] => [font.family, font.name]),
        ]);
    const render = (): void => {
        if (!trigger) return;
        popup.replaceChildren();
        popup.setAttribute(
            "aria-label",
            t(target(trigger) === "editor" ? "Editor font" : "Viewer font"),
        );
        for (const [family, name] of choices()) {
            const option = document.createElement("button");
            option.type = "button";
            option.dataset.fontValue = family;
            option.setAttribute("role", "menuitemradio");
            option.setAttribute(
                "aria-checked",
                String(family === settings.selected[target(trigger)]),
            );
            option.textContent = option.title = name;
            popup.append(option);
        }
        if (message) {
            const status = document.createElement("div");
            status.className = "font-status";
            status.setAttribute("role", "status");
            status.textContent = t(message);
            popup.append(status);
        }
    };
    const sync = (): void => {
        const names = choices();
        for (const button of document.querySelectorAll<HTMLButtonElement>("[data-font-picker]")) {
            const kind = target(button);
            button.disabled = busy;
            button.title = `${t(kind === "editor" ? "Editor font" : "Viewer font")}: ${names.get(settings.selected[kind]) ?? t("Default font")}`;
            button.setAttribute("aria-label", button.title);
            button.setAttribute("aria-controls", popup.id);
            button.setAttribute("popovertarget", popup.id);
        }
        if (popup.matches(":popover-open")) render();
    };
    document.addEventListener("click", (event) => {
        const button =
            event.target instanceof Element
                ? event.target.closest<HTMLButtonElement>("[data-font-picker]")
                : null;
        if (!button || busy) return;
        event.preventDefault();
        if (trigger === button && popup.matches(":popover-open")) {
            popup.hidePopover();
            return;
        }
        trigger?.setAttribute("aria-expanded", "false");
        if (popup.matches(":popover-open")) popup.hidePopover();
        trigger = button;
        popup.dataset.theme =
            (target(button) === "editor"
                ? root.dataset.editorTheme
                : (button.closest<HTMLElement>(".preview-pane")?.dataset.theme ??
                  root.dataset.theme)) ?? "auto";
        render();
        const rect = button.getBoundingClientRect();
        popup.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 248))}px`;
        popup.style.top = `${rect.bottom + 6}px`;
        popup.style.maxHeight = `${Math.max(60, innerHeight - rect.bottom - 14)}px`;
        popup.showPopover();
        button.setAttribute("aria-expanded", "true");
        popup.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    });
    popup.addEventListener("click", (event) => {
        const option =
            event.target instanceof Element
                ? event.target.closest<HTMLElement>("[data-font-value]")
                : null;
        if (!option || !trigger) return;
        message = "";
        try {
            settings.select(target(trigger), option.dataset.fontValue ?? "");
        } catch (error) {
            message = error instanceof Error ? error.message : "Invalid font file";
        }
        if (!message) {
            popup.hidePopover();
            trigger.focus({ preventScroll: true });
        }
        sync();
        if (message) popup.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    });
    popup.addEventListener("keydown", (event) => {
        const options = [...popup.querySelectorAll<HTMLButtonElement>("button")];
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
        if (event.key === "Escape") trigger?.focus({ preventScroll: true });
    });
    popup.addEventListener("toggle", () => {
        if (!popup.matches(":popover-open")) trigger?.setAttribute("aria-expanded", "false");
    });
    new MutationObserver((records) => {
        if (
            records.some((record) =>
                [...record.addedNodes].some(
                    (node) =>
                        node instanceof Element &&
                        (node.matches("[data-font-picker]") ||
                            node.querySelector("[data-font-picker]")),
                ),
            )
        )
            sync();
    }).observe(document.body, { childList: true, subtree: true });
    document.addEventListener("docs:ui-language", sync);
    sync();
    try {
        await settings.ready;
        message = "";
    } catch (error) {
        message = error instanceof Error ? error.message : "Invalid font file";
    }
    busy = false;
    sync();
};
