import {
    filterSubformats,
    mountSubformatPageActions,
    restoreSubformatViews,
} from "./subformats-ui.js";

export const restoreResourceFilters = (previous: Element | undefined, next: Element): void => {
    for (const root of next.querySelectorAll<HTMLElement>("[data-subformat-page]"))
        root.dispatchEvent(new Event("change", { bubbles: true }));
    next.querySelector("[data-resource-filter]")?.dispatchEvent(
        new Event("change", { bubbles: true }),
    );
    if (!previous) return;
    restoreSubformatViews(previous, next);
    for (const selector of ["[data-resource-search]", "[data-resource-filter]"]) {
        const before = previous.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
        const after = next.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
        if (!before || !after) continue;
        if (
            after instanceof HTMLSelectElement &&
            ![...after.options].some((option) => option.value === before.value)
        )
            continue;
        after.value = before.value;
        after.dispatchEvent(new Event("change", { bubbles: true }));
    }
};

/** Delegation keeps controls working when the editor replaces a resource page. */
export const mountResourceLibrary = (openSource?: (file: string, line: number) => void): void => {
    if (document.body.classList.contains("edit")) mountSubformatPageActions();
    const filter = (event: Event): void => {
        const target = event.target;
        if (
            !(target instanceof Element) ||
            !target.matches("[data-resource-search], [data-resource-filter], [data-subformat-page]")
        )
            return;
        const root = target.closest<HTMLElement>("[data-resource-results]");
        if (!root) return;
        const query =
            root
                .querySelector<HTMLInputElement>("[data-resource-search]")
                ?.value.normalize("NFKC")
                .toLowerCase()
                .trim()
                .split(/\s+/)
                .filter(Boolean) ?? [];
        const group = root.querySelector<HTMLSelectElement>("[data-resource-filter]")?.value ?? "";
        if (filterSubformats(root, query, openSource)) return;
        let count = 0;
        for (const item of root.querySelectorAll<HTMLElement>("[data-resource-item]")) {
            const text = item.textContent?.normalize("NFKC").toLowerCase() ?? "";
            item.hidden =
                (!!group && item.dataset.resourceGroup !== group) ||
                !query.every((word) => text.includes(word));
            if (!item.hidden) count++;
        }
        const status = root.querySelector("[data-resource-count]");
        if (status) status.textContent = String(count);
        const empty = root.querySelector<HTMLElement>("[data-resource-empty]");
        if (empty) empty.hidden = count > 0;
    };
    document.addEventListener("input", filter);
    document.addEventListener("change", filter);
    for (const select of document.querySelectorAll("[data-resource-filter]"))
        select.dispatchEvent(new Event("change", { bubbles: true }));
    const mountPages = (): void => {
        for (const root of document.querySelectorAll<HTMLElement>("[data-subformat-page]"))
            filterSubformats(root, [], openSource);
    };
    mountPages();
    document.addEventListener("docs:page-shown", mountPages);
    if (openSource)
        document.addEventListener("click", (event) => {
            if (
                event.defaultPrevented ||
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
            )
                return;
            const link = (event.target as Element).closest<HTMLAnchorElement>(
                "[data-resource-source]",
            );
            if (!link?.dataset.resourceSource) return;
            event.preventDefault();
            openSource(link.dataset.resourceSource, Number(link.dataset.resourceLine) || 1);
        });
};
