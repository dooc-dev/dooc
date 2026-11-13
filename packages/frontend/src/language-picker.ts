const fitWorkspaceLabel = (input: HTMLInputElement, label: string): void => {
    input.title = label;
    input.value = label;
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return;
    const style = getComputedStyle(input);
    context.font = style.font;
    const width =
        input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const characters = [...label];
    if (context.measureText(label).width > width) {
        while (characters.length && context.measureText(`${characters.join("")}...`).width > width)
            characters.pop();
        input.value = `${characters.join("")}...`;
    }
};

/** Keep the native select as the value and change-event source. */
export const mountSelectPickers = (
    t: (key: string) => string,
    selects: Iterable<HTMLSelectElement> = document.querySelectorAll("#fm-lang, #ui-language"),
): (() => void) => {
    const disposers: (() => void)[] = [];
    for (const select of selects) {
        const translations = select.id === "fm-lang";
        const workspace = select.hasAttribute("data-workspace-pane");
        const trigger = select
            .closest(".fm-language")
            ?.querySelector<HTMLButtonElement>("[data-language-open]");
        const wrapper = document.createElement("div");
        wrapper.className = `language-select${workspace ? " workspace-select" : ""}`;
        const popup = document.createElement("div");
        popup.className = `language-picker${workspace ? " workspace-picker" : ""}`;
        popup.id = `${select.id}-picker`;
        popup.popover = "manual";
        const input = document.createElement("input");
        input.type = "text";
        input.className = `language-select-input${workspace ? " workspace-picker-input" : ""}`;
        if (workspace) input.id = `${select.id}-input`;
        input.autocomplete = "off";
        input.spellcheck = false;
        input.setAttribute("role", "combobox");
        input.setAttribute("aria-autocomplete", workspace ? "none" : "list");
        input.setAttribute("aria-haspopup", "listbox");
        input.setAttribute("aria-expanded", "false");
        const list = document.createElement("div");
        list.className = "language-options";
        list.id = `${select.id}-options`;
        list.tabIndex = -1;
        list.setAttribute("role", "listbox");
        if (translations) {
            list.setAttribute("aria-multiselectable", "true");
            input.setAttribute("aria-keyshortcuts", "Control+Enter");
        }
        input.setAttribute("aria-controls", list.id);
        const empty = document.createElement("div");
        empty.className = "language-empty";
        empty.setAttribute("role", "status");
        popup.append(list, empty);
        select.before(wrapper);
        wrapper.append(select, input, popup);
        select.hidden = true;
        let active = 0;
        let query = "";
        const isOpen = (): boolean => popup.matches(":popover-open");
        const selectedText = (): string => select.selectedOptions[0]?.text ?? "";
        const position = (): void => {
            const rect = input.getBoundingClientRect();
            const width = workspace
                ? Math.min(Math.max(rect.width, 280), innerWidth - 16)
                : rect.width;
            const below = innerHeight - rect.bottom;
            const above = below < 240 && rect.top > below;
            Object.assign(popup.style, {
                width: `${width}px`,
                left: `${workspace ? Math.max(8, Math.min(rect.left + (rect.width - width) / 2, innerWidth - width - 8)) : rect.left}px`,
                maxHeight: `${Math.max(80, Math.min(360, (above ? rect.top : below) - 12))}px`,
                top: above ? "auto" : `${rect.bottom + 4}px`,
                bottom: above ? `${innerHeight - rect.top + 4}px` : "auto",
            });
        };
        const highlight = (index: number): void => {
            const options = [...list.querySelectorAll<HTMLButtonElement>("button")];
            active = options.length ? (index + options.length) % options.length : 0;
            options.forEach((option, i) => {
                option.dataset.active = String(i === active);
            });
            const option = options[active];
            if (option) {
                input.setAttribute("aria-activedescendant", option.id);
                if (isOpen()) option.scrollIntoView({ block: "nearest" });
            } else input.removeAttribute("aria-activedescendant");
        };
        const render = (): void => {
            const highlighted =
                workspace && isOpen()
                    ? list.querySelector<HTMLButtonElement>('[data-active="true"]')?.dataset.value
                    : undefined;
            const words = query.normalize("NFKC").toLowerCase().trim().split(/\s+/).filter(Boolean);
            const fragment = document.createDocumentFragment();
            let selected = 0;
            let preserved: number | undefined;
            let count = 0;
            for (const [i, option] of [...select.options].entries()) {
                if (
                    (!workspace && option.disabled) ||
                    !words.every((word) =>
                        option.text.normalize("NFKC").toLowerCase().includes(word),
                    )
                )
                    continue;
                const item = document.createElement("button");
                item.type = "button";
                item.tabIndex = -1;
                item.id = `${select.id}-option-${i}`;
                item.dataset.value = option.value;
                item.textContent = item.title = option.text;
                if (workspace) {
                    item.dataset.change = option.dataset.change ?? "";
                    if (option.dataset.create) item.dataset.create = option.dataset.create;
                    item.setAttribute("aria-disabled", String(select.disabled || option.disabled));
                    if (option.disabled) {
                        const reason = option.dataset.unavailable || option.title || option.text;
                        item.dataset.unavailable = item.title = reason;
                        item.setAttribute("aria-description", reason);
                        const label = document.createElement("span");
                        label.textContent = option.text;
                        const info = document.createElement("span");
                        info.className = "workspace-unavailable-icon";
                        info.setAttribute("aria-hidden", "true");
                        info.innerHTML =
                            '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M10 9v5M10 6.5h.01"/></svg>';
                        item.replaceChildren(label, info);
                    }
                }
                item.disabled = select.disabled;
                item.setAttribute("role", "option");
                item.setAttribute(
                    "aria-selected",
                    translations ? (option.dataset.added ?? "false") : String(option.selected),
                );
                if (translations) {
                    const marker = document.createElement("span");
                    marker.className = "language-toggle";
                    marker.textContent = option.dataset.added === "true" ? "✓" : "+";
                    marker.title = t(
                        option.value === select.dataset.source
                            ? "Source language cannot be removed"
                            : option.dataset.added === "true"
                              ? "Remove translation"
                              : "Add translation",
                    );
                    item.textContent = option.text;
                    item.prepend(marker);
                    item.setAttribute("aria-current", String(option.selected));
                }
                if (option.selected) selected = count;
                if (option.value === highlighted) preserved = count;
                fragment.append(item);
                count++;
            }
            list.replaceChildren(fragment);
            empty.hidden = count > 0;
            empty.textContent = t("No results");
            highlight(preserved ?? selected);
        };
        const sync = (): void => {
            input.title = selectedText();
            input.readOnly = workspace || select.disabled;
            if (workspace) {
                wrapper.dataset.workspacePane = input.dataset.workspacePane =
                    select.dataset.workspacePane;
                wrapper.dataset.active = input.dataset.active = select.dataset.active;
                input.setAttribute("aria-current", String(select.dataset.active === "true"));
                input.dataset.change = select.selectedOptions[0]?.dataset.change ?? "";
                input.setAttribute("aria-description", selectedText());
                if (select.disabled && isOpen()) popup.hidePopover();
            }
            if (trigger) trigger.disabled = select.disabled;
            input.setAttribute("aria-disabled", String(select.disabled));
            input.placeholder = workspace
                ? ""
                : (select.dataset.placeholder ?? t("Search languages"));
            input.setAttribute("aria-label", select.getAttribute("aria-label") ?? t("Language"));
            if (translations)
                input.setAttribute(
                    "aria-description",
                    t("Enter to edit; Ctrl+Enter to add or remove translation"),
                );
            if (!isOpen() || !query) {
                if (workspace) fitWorkspaceLabel(input, selectedText());
                else input.value = selectedText();
            }
            if (isOpen()) render();
        };
        popup.addEventListener("beforetoggle", (event) => {
            const open = (event as ToggleEvent).newState === "open";
            input.setAttribute("aria-expanded", String(open));
            trigger?.setAttribute("aria-expanded", String(open));
            if (open) {
                render();
                position();
            } else {
                query = "";
                if (workspace) fitWorkspaceLabel(input, selectedText());
                else input.value = selectedText();
                input.removeAttribute("aria-activedescendant");
            }
        });
        const choose = (item: HTMLButtonElement | null): void => {
            if (!item || select.disabled) return;
            if (
                workspace &&
                ![...select.options].some(
                    (option) => option.value === item.dataset.value && !option.disabled,
                )
            )
                return;
            select.value = item.dataset.value ?? "";
            if (!translations) popup.hidePopover();
            select.dispatchEvent(new Event("change", { bubbles: true }));
            sync();
        };
        const toggle = (item: HTMLButtonElement | null): void => {
            if (!item || select.disabled || item.dataset.value === select.dataset.source) return;
            select.dispatchEvent(
                new CustomEvent("docs:toggle-language", { detail: item.dataset.value }),
            );
        };
        const open = (): void => {
            if (isOpen() || select.disabled) return;
            select.dispatchEvent(new Event("docs:picker-open"));
            popup.showPopover();
            if (!workspace) input.select();
        };
        if (!workspace) input.addEventListener("focus", open);
        trigger?.addEventListener("click", () => {
            input.focus();
            open();
        });
        input.addEventListener("click", () => {
            if (workspace && isOpen()) popup.hidePopover();
            else open();
        });
        input.addEventListener("input", () => {
            query = input.value;
            if (isOpen()) render();
            else popup.showPopover();
        });
        input.addEventListener("keydown", (event) => {
            if (event.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (isOpen()) highlight(active + (event.key === "ArrowDown" ? 1 : -1));
                else open();
            } else if (workspace && isOpen() && ["Home", "End"].includes(event.key)) {
                event.preventDefault();
                highlight(event.key === "Home" ? 0 : list.children.length - 1);
            } else if ((event.key === "Enter" || (workspace && event.key === " ")) && isOpen()) {
                event.preventDefault();
                const item = list.querySelector<HTMLButtonElement>('[data-active="true"]');
                if (translations && event.ctrlKey) toggle(item);
                else choose(item);
            } else if (workspace && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                open();
            } else if (event.key === "Escape" && isOpen()) {
                event.preventDefault();
                popup.hidePopover();
                if (!workspace) input.select();
            }
        });
        list.addEventListener("pointerdown", (event) => event.preventDefault());
        list.addEventListener("click", (event) => {
            const target = event.target as Element;
            const item = target.closest<HTMLButtonElement>("button");
            if (translations && target.closest(".language-toggle")) toggle(item);
            else choose(item);
        });
        popup.addEventListener("toggle", () => {
            if (isOpen()) highlight(active);
        });
        wrapper.addEventListener("focusout", (event) => {
            if (
                isOpen() &&
                !(event.relatedTarget instanceof Node && wrapper.contains(event.relatedTarget))
            )
                popup.hidePopover();
        });
        const outside = (event: PointerEvent): void => {
            if (isOpen() && event.target instanceof Node && !wrapper.contains(event.target))
                popup.hidePopover();
        };
        document.addEventListener("pointerdown", outside);
        const resize = new ResizeObserver(() => {
            if (workspace) fitWorkspaceLabel(input, selectedText());
            if (isOpen()) position();
        });
        resize.observe(input);
        const reposition = () => {
            if (isOpen()) position();
        };
        window.addEventListener("resize", reposition);
        select.addEventListener("change", sync);
        const observer = new MutationObserver(sync);
        observer.observe(select, {
            childList: true,
            subtree: true,
            attributes: true,
        });
        document.addEventListener("docs:ui-language", sync);
        disposers.push(() => {
            document.removeEventListener("pointerdown", outside);
            document.removeEventListener("docs:ui-language", sync);
            select.removeEventListener("change", sync);
            window.removeEventListener("resize", reposition);
            resize.disconnect();
            observer.disconnect();
            wrapper.replaceWith(select);
            select.hidden = false;
        });
        sync();
    }
    return () => {
        for (const dispose of disposers) dispose();
    };
};
