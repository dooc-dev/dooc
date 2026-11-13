/** Shared by editor, preview, and published pages; keep this function self-contained. */
export const mountPanelResize = (): void => {
    const sidebar = document.getElementById("sidebar");
    const editor = document.getElementById("panel");
    const closed = (): boolean => document.body.classList.contains("sidebar-closed");
    const split = (): boolean => !!document.querySelector("#preview-panes.split");
    const contentWidth = (): number =>
        Math.min(
            split() ? 480 : 240,
            Math.max(0, window.innerWidth - (closed() ? 52 : 200) - (editor ? 320 : 0)),
        );
    const panels = [
        {
            element: sidebar,
            handle: "sidebar-resize",
            key: "docs:sidebar-width",
            min: 200,
            max: 480,
            direction: 1,
        },
        {
            element: editor,
            handle: "resize",
            key: "docs-edit:panelw",
            min: 320,
            max: 960,
            direction: -1,
        },
    ].flatMap((options) => {
        const element = options.element;
        const handle = document.getElementById(options.handle);
        if (!element || !handle) return [];
        let preferred: number | undefined;
        try {
            const saved = Number(localStorage.getItem(options.key));
            if (Number.isFinite(saved) && saved > 0) preferred = saved;
        } catch {
            /* Width persistence is optional. */
        }
        const property = options.direction === 1 ? "--sidebar-width" : "--panel-width";
        const requested = (): number =>
            preferred ??
            (options.direction === 1
                ? 260
                : Math.min(split() ? 480 : 760, window.innerWidth * (split() ? 0.34 : 0.52)));
        if (options.direction === 1 && closed())
            element.style.setProperty(property, `${requested()}px`);
        const apply = (width: number): void => {
            const other = options.direction === 1 ? editor : sidebar;
            const max = Math.max(
                0,
                Math.min(
                    options.max,
                    window.innerWidth -
                        (other?.getBoundingClientRect().width ?? 0) -
                        contentWidth(),
                ),
            );
            const min = Math.min(options.min, max);
            const value = Math.round(Math.max(min, Math.min(width, max)));
            element.style.setProperty(property, `${value}px`);
            handle.setAttribute("aria-valuemin", String(min));
            handle.setAttribute("aria-valuemax", String(max));
            handle.setAttribute("aria-valuenow", String(value));
        };
        const persist = (): void => {
            preferred = element.getBoundingClientRect().width;
            try {
                localStorage.setItem(options.key, String(preferred));
            } catch {
                /* Optional. */
            }
        };
        let drag: { id: number; x: number; width: number } | undefined;
        handle.addEventListener("pointerdown", (event) => {
            if (event.button !== 0 || drag) return;
            event.preventDefault();
            handle.focus();
            drag = {
                id: event.pointerId,
                x: event.clientX,
                width: element.getBoundingClientRect().width,
            };
            handle.setPointerCapture(event.pointerId);
            handle.classList.add("drag");
            document.body.classList.add("resizing");
        });
        handle.addEventListener("pointermove", (event) => {
            if (drag?.id !== event.pointerId) return;
            apply(drag.width + options.direction * (event.clientX - drag.x));
        });
        const stop = (event: PointerEvent): void => {
            if (drag?.id !== event.pointerId) return;
            drag = undefined;
            handle.classList.remove("drag");
            document.body.classList.remove("resizing");
            persist();
        };
        handle.addEventListener("pointerup", stop);
        handle.addEventListener("pointercancel", stop);
        handle.addEventListener("lostpointercapture", stop);
        handle.addEventListener("dblclick", () => {
            preferred = undefined;
            try {
                localStorage.removeItem(options.key);
            } catch {
                /* Optional. */
            }
            apply(requested());
        });
        handle.addEventListener("keydown", (event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            apply(
                element.getBoundingClientRect().width +
                    options.direction * (event.key === "ArrowRight" ? 20 : -20),
            );
            persist();
        });
        return [{ ...options, element, apply, requested, persist, property }];
    });
    const layout = (): void => {
        if (editor && window.innerWidth <= 820) {
            const left = panels.find((panel) => panel.direction === 1);
            left?.element.style.setProperty(
                left.property,
                `${Math.min(left.requested(), window.innerWidth - 52)}px`,
            );
            return;
        }
        // On a smaller viewport, make room for the navigation before clamping both panels.
        const right = panels.find((panel) => panel.direction === -1);
        if (right) {
            const available = Math.max(
                0,
                window.innerWidth - (closed() ? 52 : 200) - contentWidth(),
            );
            right.element.style.setProperty(
                right.property,
                `${Math.min(right.requested(), available)}px`,
            );
        }
        for (const panel of panels) {
            if (panel.direction === 1 && closed()) continue;
            panel.apply(panel.requested());
        }
    };
    window.addEventListener("resize", layout);
    document.addEventListener("docs:panes-changed", layout);
    document.getElementById("sidebar-toggle")?.addEventListener("click", layout);
    window.addEventListener("keydown", (event) => {
        if (editor && window.innerWidth <= 820) return;
        if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || !event.altKey) return;
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        const right = panels.find((panel) => panel.direction === -1);
        if (!right) return;
        event.preventDefault();
        right.apply(
            right.element.getBoundingClientRect().width + (event.key === "ArrowLeft" ? 40 : -40),
        );
        right.persist();
    });
    layout();
};
