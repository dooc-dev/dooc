/** Delegation keeps controls working when the editor replaces a resource page. */
export const mountResourceLibrary = (openSource?: (file: string, line: number) => void): void => {
    const filter = (event: Event): void => {
        const target = event.target;
        if (
            !(target instanceof Element) ||
            !target.matches("[data-resource-search], [data-resource-filter]")
        )
            return;
        const root = target.closest("[data-resource-results]");
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
