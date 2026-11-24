/** In narrow trees, show the current level beneath its compact ancestor chain. */
export const focusNavTree = (root: HTMLElement | null, href?: string): void => {
    if (!root) return;
    if (href !== undefined) {
        const target = new URL(href, location.href);
        for (const link of document.querySelectorAll<HTMLAnchorElement>(
            "#site-title, #nav-groups .nav-row > a[href]",
        )) {
            const url = new URL(link.href, location.href);
            const current =
                url.origin === target.origin &&
                url.pathname === target.pathname &&
                (!target.hash.startsWith("#/") ||
                    url.hash.split("#")[1]?.split("?")[0] ===
                        target.hash.split("#")[1]?.split("?")[0]);
            link.classList.toggle("cur", current);
            if (current) link.setAttribute("aria-current", "page");
            else link.removeAttribute("aria-current");
            if (current)
                for (
                    let item = link.closest(".nav-item")?.parentElement?.closest(".nav-item");
                    item;
                    item = item.parentElement?.closest(".nav-item")
                )
                    item.classList.add("open");
        }
    }
    const current = root.querySelector(".nav-row > a.cur")?.closest<HTMLElement>("[data-doc-id]");
    const path: HTMLElement[] = [];
    for (
        let item = current;
        item;
        item = item.parentElement?.closest<HTMLElement>("[data-doc-id]")
    ) {
        path.unshift(item);
    }
    const closed = document.body.classList.contains("sidebar-closed");
    const width = closed
        ? Number(root.dataset.expandedWidth) ||
          Number.parseFloat(getComputedStyle(root).getPropertyValue("--sidebar-width")) ||
          260
        : root.clientWidth;
    if (!width) return;
    if (!closed) root.dataset.expandedWidth = String(width);
    const indent = 48 + Math.max(0, path.length - 2) * 29;
    const ancestors = new Set(path.length > 2 && width < indent + 150 ? path.slice(0, -1) : []);
    const items = [...root.querySelectorAll<HTMLElement>(".nav-item[data-doc-id]")];
    const changed = items.some(
        (item) => item.classList.contains("nav-ancestor") !== ancestors.has(item),
    );
    const collapsed = ".nav-list:has(> .nav-ancestor) > .nav-item:not(.nav-ancestor)";
    const animate =
        changed &&
        root.dataset.focusedDoc !== undefined &&
        !matchMedia("(prefers-reduced-motion: reduce)").matches;
    const siblings = [...root.querySelectorAll<HTMLElement>(".nav-list > .nav-item")];
    const before = animate
        ? siblings.map((item) => ({
              item,
              hidden: item.matches(collapsed),
              height: item.getBoundingClientRect().height,
              opacity: getComputedStyle(item).opacity,
          }))
        : [];
    for (const item of items) {
        item.classList.toggle("nav-ancestor", ancestors.has(item));
        const list = item.querySelector<HTMLElement>(":scope > .nav-list");
        if (!list) continue;
        const level = Number(item.parentElement?.style.getPropertyValue("--nav-depth") || 1);
        list.style.setProperty("--nav-depth", String(ancestors.has(item) ? 2 : level + 1));
    }
    for (const item of siblings) item.inert = item.matches(collapsed);
    // Animate measured heights so siblings and Resources move together, including on reversal.
    for (const previous of before) {
        const { item } = previous;
        const hidden = item.matches(collapsed);
        if (hidden === previous.hidden) continue;
        for (const animation of item.getAnimations()) {
            if (animation.id === "nav-collapse") animation.cancel();
        }
        item.animate(
            {
                height: [`${previous.height}px`, `${item.getBoundingClientRect().height}px`],
                opacity: [previous.opacity, hidden ? "0" : "1"],
                visibility: "visible",
                overflow: "hidden",
            },
            { id: "nav-collapse", duration: 260, easing: "cubic-bezier(.2, .8, .2, 1)" },
        );
    }
    const id = current?.dataset.docId ?? "";
    if (root.dataset.focusedDoc !== id) {
        root.dataset.focusedDoc = id;
        for (const item of ancestors) item.classList.add("open");
        current?.querySelector(":scope > .nav-row")?.scrollIntoView({ block: "nearest" });
    }
    for (const item of items) {
        const list = item.querySelector<HTMLElement>(":scope > .nav-list");
        if (list) list.inert = !item.classList.contains("open");
        item.querySelector(":scope > .nav-row > .nav-tree-toggle")?.setAttribute(
            "aria-expanded",
            String(item.classList.contains("open")),
        );
    }
};
