/** Self-contained so the same controls work in the viewer and exported HTML. */
export function mountTables(root: ParentNode): () => void {
    const controller = new AbortController();
    const mounted = new WeakMap<HTMLElement, () => void>();
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    const initialize = () => {
        for (const box of root.querySelectorAll<HTMLElement>(".data-table")) {
            if (mounted.has(box)) continue;
            const template = box.querySelector<HTMLTemplateElement>("[data-table-rows]");
            const table = box.querySelector("table");
            const header = box.dataset.tableMode === "header";
            if (!template || !table) continue;
            const viewport = box.querySelector<HTMLElement>(".data-table-scroll");
            const handle = box.querySelector<HTMLElement>(".data-table-resize");
            if (viewport && handle) {
                let drag: { y: number; height: number } | undefined;
                const resize = (height: number) => {
                    const max = Math.max(64, table.getBoundingClientRect().height + 2);
                    const value = Math.round(Math.max(64, Math.min(height, max)));
                    viewport.style.maxHeight = "none";
                    viewport.style.height = `${value}px`;
                    handle.setAttribute("aria-valuenow", String(value));
                    handle.setAttribute("aria-valuemax", String(Math.round(max)));
                };
                handle.setAttribute("aria-valuemin", "64");
                handle.addEventListener(
                    "focus",
                    () => {
                        handle.setAttribute(
                            "aria-valuenow",
                            String(Math.round(viewport.getBoundingClientRect().height)),
                        );
                        handle.setAttribute(
                            "aria-valuemax",
                            String(
                                Math.max(64, Math.round(table.getBoundingClientRect().height + 2)),
                            ),
                        );
                    },
                    { signal: controller.signal },
                );
                handle.addEventListener(
                    "pointerdown",
                    (event) => {
                        if (event.button !== 0) return;
                        drag = {
                            y: event.clientY,
                            height: viewport.getBoundingClientRect().height,
                        };
                        handle.setPointerCapture(event.pointerId);
                        event.preventDefault();
                    },
                    { signal: controller.signal },
                );
                handle.addEventListener(
                    "pointermove",
                    (event) => {
                        if (drag) resize(drag.height + event.clientY - drag.y);
                    },
                    { signal: controller.signal },
                );
                handle.addEventListener(
                    "lostpointercapture",
                    () => {
                        drag = undefined;
                    },
                    { signal: controller.signal },
                );
                handle.addEventListener(
                    "keydown",
                    (event) => {
                        const height = viewport.getBoundingClientRect().height;
                        if (event.key === "ArrowDown") resize(height + 32);
                        else if (event.key === "ArrowUp") resize(height - 32);
                        else if (event.key === "Home") resize(64);
                        else if (event.key === "End")
                            resize(table.getBoundingClientRect().height + 2);
                        else return;
                        event.preventDefault();
                        event.stopPropagation();
                    },
                    { signal: controller.signal },
                );
            }
            const rows = JSON.parse(template.content.textContent ?? "[]") as string[][];
            const key = `docs-table:${box.dataset.tableSource}:${box.dataset.tableMode}`;
            let column = -1;
            let descending = false;
            try {
                const saved = JSON.parse(localStorage.getItem(key) ?? "null");
                if (Number.isInteger(saved?.column) && saved.column < (rows[0]?.length ?? 0))
                    column = Math.max(-1, saved.column);
                descending = saved?.descending === true;
            } catch {
                // Storage is optional; source order and sorting remain usable.
            }
            const render = () => {
                const label =
                    box.querySelector("[data-table-column-label]")?.textContent ?? "Column";
                const head = document.createElement("tr");
                const number = document.createElement("th");
                number.scope = "col";
                number.textContent = "#";
                head.append(number);
                for (let index = 0; index < (rows[0]?.length ?? 0); index++) {
                    const cell = document.createElement("th");
                    cell.scope = "col";
                    if (index === column)
                        cell.setAttribute("aria-sort", descending ? "descending" : "ascending");
                    const button = document.createElement("button");
                    button.type = "button";
                    button.dataset.tableSort = String(index);
                    button.textContent = header
                        ? rows[0]?.[index] || `${label} ${index + 1}`
                        : `${label} ${index + 1}`;
                    const mark = document.createElement("span");
                    mark.className = "data-table-sort-mark";
                    mark.setAttribute("aria-hidden", "true");
                    mark.textContent = index === column && descending ? "↓" : "↑";
                    button.append(mark);
                    cell.append(button);
                    head.append(cell);
                }
                table.tHead?.replaceChildren(head);
                const data = rows.map((cells, index) => ({ cells, index })).slice(header ? 1 : 0);
                if (column >= 0) {
                    const numeric = data.every(
                        ({ cells }) =>
                            !cells[column]?.trim() ||
                            /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(
                                cells[column]?.trim() ?? "",
                            ),
                    );
                    data.sort((a, b) => {
                        const left = a.cells[column]?.trim() ?? "";
                        const right = b.cells[column]?.trim() ?? "";
                        if (!left || !right)
                            return Number(!left) - Number(!right) || a.index - b.index;
                        const order = numeric
                            ? Number(left) - Number(right)
                            : collator.compare(left, right);
                        return (descending ? -order : order) || a.index - b.index;
                    });
                }
                const body = document.createDocumentFragment();
                for (const { cells, index } of data) {
                    const row = document.createElement("tr");
                    const number = document.createElement("th");
                    number.scope = "row";
                    number.textContent = String(index + 1);
                    row.append(number);
                    for (const text of cells) {
                        const cell = document.createElement("td");
                        cell.textContent = text;
                        row.append(cell);
                    }
                    body.append(row);
                }
                table.tBodies[0]?.replaceChildren(body);
            };
            const persist = () => {
                try {
                    localStorage.setItem(key, JSON.stringify({ column, descending }));
                } catch {
                    // Sorting also works without storage.
                }
                render();
            };
            box.addEventListener(
                "click",
                (event) => {
                    const button = (event.target as Element).closest<HTMLButtonElement>("button");
                    if (!button) return;
                    if (button.hasAttribute("data-table-sort")) {
                        const next = Number(button.dataset.tableSort);
                        if (column !== next) {
                            column = next;
                            descending = false;
                        } else if (!descending) descending = true;
                        else column = -1;
                        persist();
                        box.querySelector<HTMLButtonElement>(`[data-table-sort="${next}"]`)?.focus({
                            preventScroll: true,
                        });
                    }
                },
                { signal: controller.signal },
            );
            mounted.set(box, render);
            render();
        }
    };
    initialize();
    const observer = new MutationObserver(initialize);
    observer.observe(root, { childList: true, subtree: true });
    root.addEventListener(
        "docs:ui-language",
        () => {
            for (const box of root.querySelectorAll<HTMLElement>(".data-table"))
                mounted.get(box)?.();
        },
        { signal: controller.signal },
    );
    return () => {
        observer.disconnect();
        controller.abort();
    };
}
