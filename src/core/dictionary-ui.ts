/**
 * Sorts dictionary listings in place on `[data-dict-sort]` change. The A → Z rank is computed at
 * render time by the doc language's rule (html.ts → data-sort-order), so no language logic runs
 * here. Delegation keeps sorting working after preview/editor content replacement.
 */
export function mountDictionaries(root: ParentNode): () => void {
    const controller = new AbortController();
    root.addEventListener(
        "change",
        (event: Event): void => {
            const select = event.target;
            if (!(select instanceof HTMLSelectElement) || !select.matches("[data-dict-sort]"))
                return;
            const list = select.closest(".dictionary")?.querySelector(".dict");
            if (!list) return;
            const key = select.value === "source" ? "sourceOrder" : "sortOrder";
            const sign = select.value === "desc" ? -1 : 1;
            const cards = Array.from(list.querySelectorAll<HTMLElement>(".dict-card"));
            cards.sort((a, b) => sign * (Number(a.dataset[key]) - Number(b.dataset[key])));
            list.append(...cards);
        },
        { signal: controller.signal },
    );
    return () => controller.abort();
}
