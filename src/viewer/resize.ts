/** Shared by editor, preview, and published pages; keep this function self-contained. */
export const mountPanelResize = (): void => {
    const sidebar = document.getElementById("sidebar");
    const editor = document.getElementById("panel");
    const closed = (): boolean => document.body.classList.contains("sidebar-closed");
    const contentWidth = (): number =>
        Math.min(240, Math.max(0, window.innerWidth - (closed() ? 52 : 200) - (editor ? 320 : 0)));
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
            preferred ?? (options.direction === 1 ? 260 : Math.min(760, window.innerWidth * 0.52));
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
    document.getElementById("sidebar-toggle")?.addEventListener("click", layout);
    window.addEventListener("keydown", (event) => {
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

/** The navigation is replaced on refresh; keep listeners and height on its stable sidebar. */
export const mountToolsResize = (): (() => void) => {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar || !document.getElementById("nav-tools")) return () => {};
    const key = "docs:tools-height";
    let preferred: number | undefined;
    try {
        const saved = Number(localStorage.getItem(key));
        if (Number.isFinite(saved) && saved > 0) preferred = saved;
    } catch {
        /* Persistence is optional. */
    }
    // Without a saved height, fit the cards so the panel shows no empty band below them.
    const fittedHeight = (): number => {
        const tools = document.getElementById("nav-tools");
        const cards = tools?.querySelector(".nav-tool-cards");
        const last = cards?.lastElementChild;
        if (!tools || !cards || !last) return 220;
        // The card list stretches to the panel, so measure its content rather than scrollHeight.
        const content =
            last.getBoundingClientRect().bottom -
            cards.getBoundingClientRect().top +
            cards.scrollTop;
        return tools.offsetHeight - cards.clientHeight + content;
    };
    const apply = (height = preferred ?? Math.min(fittedHeight(), innerHeight * 0.4)): void => {
        const handle = document.getElementById("tools-resize");
        if (!handle) return;
        const max = Math.max(80, sidebar.clientHeight - 100);
        const min = Math.min(144, max);
        const value = Math.round(Math.max(min, Math.min(height, max)));
        sidebar.style.setProperty("--tools-height", `${value}px`);
        handle.setAttribute("aria-valuemin", String(min));
        handle.setAttribute("aria-valuemax", String(max));
        handle.setAttribute("aria-valuenow", String(value));
    };
    const persist = (): void => {
        preferred = Number.parseFloat(sidebar.style.getPropertyValue("--tools-height"));
        try {
            localStorage.setItem(key, String(preferred));
        } catch {
            /* Optional. */
        }
    };
    const isHandle = (event: Event): boolean =>
        event.target instanceof Element && !!event.target.closest("#tools-resize");
    const height = (): number =>
        document.getElementById("nav-tools")?.getBoundingClientRect().height ?? 0;
    let drag: { id: number; y: number; height: number; handle: HTMLElement } | undefined;
    sidebar.addEventListener("pointerdown", (event) => {
        if (!isHandle(event) || event.button !== 0 || drag) return;
        const handle = document.getElementById("tools-resize");
        if (!handle) return;
        event.preventDefault();
        handle.focus({ preventScroll: true });
        drag = { id: event.pointerId, y: event.clientY, height: height(), handle };
        handle.setPointerCapture(event.pointerId);
        document.body.classList.add("resizing-tools");
    });
    sidebar.addEventListener("pointermove", (event) => {
        if (drag?.id === event.pointerId) apply(drag.height + drag.y - event.clientY);
    });
    const stop = (): void => {
        if (!drag) return;
        drag = undefined;
        document.body.classList.remove("resizing-tools");
        persist();
    };
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const)
        sidebar.addEventListener(type, (event) => {
            if (drag?.id === event.pointerId) stop();
        });
    sidebar.addEventListener("keydown", (event) => {
        if (!isHandle(event) || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        event.preventDefault();
        apply(height() + (event.key === "ArrowUp" ? 20 : -20));
        persist();
    });
    sidebar.addEventListener("dblclick", (event) => {
        if (!isHandle(event)) return;
        preferred = undefined;
        try {
            localStorage.removeItem(key);
        } catch {
            /* Optional. */
        }
        apply();
    });
    window.addEventListener("resize", () => apply());
    const restore = () => {
        if (drag && !drag.handle.isConnected) stop();
        apply();
    };
    const nav = document.getElementById("nav-groups");
    if (nav) new MutationObserver(restore).observe(nav, { childList: true });
    restore();
    return restore;
};
