/** Keep the native select as the value and change-event source. */
export const mountSelectPickers = (
    t: (key: string) => string,
    selects: Iterable<HTMLSelectElement> = document.querySelectorAll("#fm-lang, #ui-language"),
): (() => void) => {
    const disposers: (() => void)[] = [];
    for (const select of selects) {
        const translations = select.id === "fm-lang";
        const trigger = select
            .closest(".fm-language")
            ?.querySelector<HTMLButtonElement>("[data-language-open]");
        const wrapper = document.createElement("div");
        wrapper.className = "language-select";
        const popup = document.createElement("div");
        popup.className = "language-picker";
        popup.id = `${select.id}-picker`;
        popup.popover = "manual";
        const input = document.createElement("input");
        input.type = "text";
        input.className = "language-select-input";
        input.autocomplete = "off";
        input.spellcheck = false;
        input.setAttribute("role", "combobox");
        input.setAttribute("aria-autocomplete", "list");
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
            const below = innerHeight - rect.bottom;
            const above = below < 240 && rect.top > below;
            Object.assign(popup.style, {
                width: `${rect.width}px`,
                left: `${rect.left}px`,
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
            const words = query.normalize("NFKC").toLowerCase().trim().split(/\s+/).filter(Boolean);
            const fragment = document.createDocumentFragment();
            let selected = 0;
            let count = 0;
            for (const [i, option] of [...select.options].entries()) {
                if (
                    option.disabled ||
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
                fragment.append(item);
                count++;
            }
            list.replaceChildren(fragment);
            empty.hidden = count > 0;
            empty.textContent = t("No results");
            highlight(selected);
        };
        const sync = (): void => {
            input.title = selectedText();
            input.readOnly = select.disabled;
            if (trigger) trigger.disabled = select.disabled;
            input.setAttribute("aria-disabled", String(select.disabled));
            input.placeholder = select.dataset.placeholder ?? t("Search languages");
            input.setAttribute("aria-label", select.getAttribute("aria-label") ?? t("Language"));
            if (translations)
                input.setAttribute(
                    "aria-description",
                    t("Enter to edit; Ctrl+Enter to add or remove translation"),
                );
            if (!isOpen() || !query) input.value = selectedText();
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
                input.value = selectedText();
                input.removeAttribute("aria-activedescendant");
            }
        });
        const choose = (item: HTMLButtonElement | null): void => {
            if (!item || select.disabled) return;
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
            popup.showPopover();
            input.select();
        };
        input.addEventListener("focus", open);
        trigger?.addEventListener("click", () => {
            input.focus();
            open();
        });
        input.addEventListener("click", open);
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
            } else if (event.key === "Enter" && isOpen()) {
                event.preventDefault();
                const item = list.querySelector<HTMLButtonElement>('[data-active="true"]');
                if (translations && event.ctrlKey) toggle(item);
                else choose(item);
            } else if (event.key === "Escape" && isOpen()) {
                event.preventDefault();
                popup.hidePopover();
                input.select();
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
            if (isOpen()) position();
        });
        resize.observe(input);
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
