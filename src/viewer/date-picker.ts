import { t } from "./i18n.js";

const dateValue = (date: Date): string =>
    `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export const parseDateValue = (value: string): Date | undefined => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
    const date = new Date(0);
    date.setHours(12, 0, 0, 0);
    date.setFullYear(
        Number(value.slice(0, 4)),
        Number(value.slice(5, 7)) - 1,
        Number(value.slice(8)),
    );
    if (dateValue(date) === value) return date;
};

export const mountDatePickers = (inputs: Iterable<HTMLInputElement>): (() => void) => {
    const disposers: (() => void)[] = [];
    for (const input of inputs) {
        const wrapper = document.createElement("div");
        wrapper.className = "date-control";
        const popup = document.createElement("div");
        popup.className = "date-picker language-picker";
        popup.id = `${input.id}-calendar`;
        popup.popover = "auto";
        popup.setAttribute("role", "dialog");
        popup.setAttribute(
            "aria-label",
            `${t("Choose date")}: ${input.getAttribute("aria-label")}`,
        );
        const button = (name: string, action: () => void, path?: string): HTMLButtonElement => {
            const control = document.createElement("button");
            control.type = "button";
            control.title = name;
            control.setAttribute("aria-label", name);
            if (path)
                control.innerHTML = `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
            else control.textContent = name;
            control.addEventListener("click", action);
            return control;
        };
        const trigger = button(
            popup.getAttribute("aria-label") ?? t("Choose date"),
            () => {
                if (!input.disabled && !input.closest("[inert]")) popup.togglePopover();
            },
            "M6 2v4m8-4v4M3 8h14M3 4h14v14H3ZM6 11h2m4 0h2m-8 3h2",
        );
        trigger.className = "date-trigger";
        trigger.disabled = input.disabled;
        trigger.setAttribute("aria-haspopup", "dialog");
        trigger.setAttribute("aria-controls", popup.id);
        trigger.setAttribute("aria-expanded", "false");
        input.placeholder = "YYYY-MM-DD";
        input.setAttribute("aria-keyshortcuts", "Alt+ArrowDown");
        input.autocomplete = "off";
        input.spellcheck = false;
        input.before(wrapper);
        wrapper.append(input, trigger, popup);
        let active = parseDateValue(input.value) ?? new Date();
        const isOpen = (): boolean => popup.matches(":popover-open");
        const position = (): void => {
            if (!isOpen()) return;
            const rect = input.getBoundingClientRect();
            const below = innerHeight - rect.bottom;
            const above = below < popup.offsetHeight + 8 && rect.top > below;
            Object.assign(popup.style, {
                left: `${Math.max(8, Math.min(rect.left, innerWidth - popup.offsetWidth - 8))}px`,
                top: above ? "auto" : `${rect.bottom + 4}px`,
                bottom: above ? `${innerHeight - rect.top + 4}px` : "auto",
                maxHeight: `${Math.max(80, (above ? rect.top : below) - 12)}px`,
            });
        };
        const close = (): void => {
            popup.hidePopover();
            input.focus();
        };
        const choose = (value: string): void => {
            if (input.disabled || input.closest("[inert]")) return;
            input.value = value;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            close();
        };
        const header = document.createElement("div");
        header.className = "date-picker-header";
        const heading = document.createElement("span");
        heading.id = `${popup.id}-month`;
        heading.setAttribute("aria-live", "polite");
        const moveMonth = (offset: number): void => {
            const day = active.getDate();
            active.setDate(1);
            active.setMonth(active.getMonth() + offset);
            const end = new Date(active);
            end.setMonth(end.getMonth() + 1, 0);
            active.setDate(Math.min(day, end.getDate()));
        };
        header.append(
            button(
                t("Previous month"),
                () => {
                    moveMonth(-1);
                    render();
                },
                "m12 5-5 5 5 5",
            ),
            heading,
            button(
                t("Next month"),
                () => {
                    moveMonth(1);
                    render();
                },
                "m8 5 5 5-5 5",
            ),
        );
        const table = document.createElement("table");
        table.setAttribute("role", "grid");
        table.setAttribute("aria-labelledby", heading.id);
        const weekdays = table.createTHead().insertRow();
        const days = table.createTBody();
        const footer = document.createElement("div");
        footer.className = "date-picker-footer";
        footer.append(
            button(t("Today"), () => choose(dateValue(new Date()))),
            button(t("Clear"), () => choose("")),
        );
        popup.append(header, table, footer);
        const focusDay = (): void =>
            table.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus();
        const render = (): void => {
            if (active.getFullYear() < 0) active.setFullYear(0, 0, 1);
            if (active.getFullYear() > 9999) active.setFullYear(9999, 11, 31);
            const locale = document.documentElement.lang || navigator.language;
            const month = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" });
            const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" });
            const fullDate = new Intl.DateTimeFormat(locale, { dateStyle: "full" });
            heading.textContent = month.format(active);
            weekdays.replaceChildren();
            for (let day = 0; day < 7; day++) {
                const cell = document.createElement("th");
                cell.scope = "col";
                cell.textContent = weekday.format(new Date(2024, 0, 7 + day));
                weekdays.append(cell);
            }
            days.replaceChildren();
            const date = new Date(active);
            date.setDate(1);
            date.setDate(1 - date.getDay());
            const today = dateValue(new Date());
            for (let week = 0; week < 6; week++) {
                const row = days.insertRow();
                for (let day = 0; day < 7; day++) {
                    const value = dateValue(date);
                    const control = button(fullDate.format(date), () => choose(value));
                    control.textContent = String(date.getDate());
                    control.dataset.date = value;
                    control.dataset.outside = String(date.getMonth() !== active.getMonth());
                    control.disabled = !parseDateValue(value);
                    control.tabIndex = value === dateValue(active) ? 0 : -1;
                    if (value === today) control.setAttribute("aria-current", "date");
                    const cell = row.insertCell();
                    cell.setAttribute("aria-selected", String(value === input.value));
                    cell.append(control);
                    date.setDate(date.getDate() + 1);
                }
            }
            position();
        };
        table.addEventListener("keydown", (event) => {
            const key = event.key;
            if (
                ![
                    "ArrowLeft",
                    "ArrowRight",
                    "ArrowUp",
                    "ArrowDown",
                    "Home",
                    "End",
                    "PageUp",
                    "PageDown",
                ].includes(key)
            )
                return;
            event.preventDefault();
            if (key === "PageUp" || key === "PageDown")
                moveMonth((key === "PageUp" ? -1 : 1) * (event.shiftKey ? 12 : 1));
            else
                active.setDate(
                    active.getDate() +
                        (key === "Home"
                            ? -active.getDay()
                            : key === "End"
                              ? 6 - active.getDay()
                              : ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[key] ??
                                0)),
                );
            render();
            focusDay();
        });
        popup.addEventListener("beforetoggle", (event) => {
            const open = (event as ToggleEvent).newState === "open";
            trigger.setAttribute("aria-expanded", String(open));
            if (open) {
                active = parseDateValue(input.value) ?? new Date();
                render();
            }
        });
        popup.addEventListener("toggle", () => {
            if (isOpen()) {
                position();
                focusDay();
            }
        });
        const keydown = (event: KeyboardEvent): void => {
            if (event.key === "Escape" && isOpen()) {
                event.preventDefault();
                close();
            } else if (event.key === "ArrowDown" && event.altKey && event.target === input) {
                event.preventDefault();
                trigger.click();
            }
        };
        wrapper.addEventListener("keydown", keydown);
        wrapper.addEventListener("focusout", (event) => {
            if (
                isOpen() &&
                event.relatedTarget instanceof Node &&
                !wrapper.contains(event.relatedTarget)
            )
                popup.hidePopover();
        });
        document.addEventListener("scroll", position, true);
        window.addEventListener("resize", position);
        disposers.push(() => {
            document.removeEventListener("scroll", position, true);
            window.removeEventListener("resize", position);
            wrapper.before(input);
            wrapper.remove();
        });
    }
    return () => {
        for (const dispose of disposers) dispose();
    };
};
