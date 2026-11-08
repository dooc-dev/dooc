import { t } from "./i18n.js";

export const createPluginResize = (content: HTMLElement): HTMLElement => {
    const handle = document.createElement("div");
    handle.className = "plugin-resize";
    handle.tabIndex = 0;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "horizontal");
    handle.setAttribute("aria-controls", content.id);
    handle.setAttribute("aria-valuemin", "32");
    handle.setAttribute("aria-valuemax", "1200");
    handle.dataset.i18nTitle = handle.dataset.i18nAriaLabel = "Resize plugin card";
    handle.title = t("Resize plugin card");
    handle.setAttribute("aria-label", handle.title);
    const height = () => content.getBoundingClientRect().height;
    const resize = (value: number) => {
        const size = Math.round(Math.max(32, Math.min(1200, value)));
        content.dataset.resized = "";
        content.style.height = `${size}px`;
        handle.setAttribute("aria-valuenow", String(size));
    };
    handle.addEventListener("focus", () => {
        handle.setAttribute("aria-valuenow", String(Math.round(height())));
    });
    let drag: { id: number; y: number; height: number } | undefined;
    handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || drag) return;
        event.preventDefault();
        handle.focus({ preventScroll: true });
        drag = { id: event.pointerId, y: event.clientY, height: height() };
        handle.setPointerCapture(event.pointerId);
        handle.classList.add("drag");
    });
    handle.addEventListener("pointermove", (event) => {
        if (drag?.id === event.pointerId) resize(drag.height + event.clientY - drag.y);
    });
    const stop = (event: PointerEvent) => {
        if (drag?.id !== event.pointerId) return;
        drag = undefined;
        handle.classList.remove("drag");
    };
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const)
        handle.addEventListener(type, stop);
    handle.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown") resize(height() + 32);
        else if (event.key === "ArrowUp") resize(height() - 32);
        else if (event.key === "Home") resize(32);
        else if (event.key === "End") resize(1200);
        else return;
        event.preventDefault();
        event.stopPropagation();
    });
    return handle;
};
