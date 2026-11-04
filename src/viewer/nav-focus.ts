/** In narrow trees, show the current level beneath its compact ancestor chain. */
export const focusNavTree = (root: HTMLElement | null): void => {
    if (!root) return;
    const current = root.querySelector(".nav-row > a.cur")?.closest<HTMLElement>("[data-doc-id]");
    const path: HTMLElement[] = [];
    for (
        let item = current;
        item;
        item = item.parentElement?.closest<HTMLElement>("[data-doc-id]")
    ) {
        path.unshift(item);
    }
    const width = root.clientWidth;
    if (!width) return;
    const indent = 48 + Math.max(0, path.length - 2) * 29;
    const ancestors = new Set(path.length > 2 && width < indent + 150 ? path.slice(0, -1) : []);
    for (const item of root.querySelectorAll<HTMLElement>(".nav-item[data-doc-id]")) {
        item.classList.toggle("nav-ancestor", ancestors.has(item));
        const list = item.querySelector<HTMLElement>(":scope > .nav-list");
        if (!list) continue;
        const level = Number(item.parentElement?.style.getPropertyValue("--nav-depth") || 1);
        list.style.setProperty("--nav-depth", String(ancestors.has(item) ? 2 : level + 1));
    }
    const id = current?.dataset.docId ?? "";
    if (root.dataset.focusedDoc !== id) {
        root.dataset.focusedDoc = id;
        for (const item of ancestors) item.classList.add("open");
        current?.querySelector(":scope > .nav-row")?.scrollIntoView({ block: "nearest" });
    }
};
