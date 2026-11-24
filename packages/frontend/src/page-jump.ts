import type { focusNavTree } from "./nav-focus.js";

/** Self-contained for live pages and standalone readers. */
export const mountPageJump = (select: typeof focusNavTree): void => {
    const key = "docs-edit:page-jump";
    const editor = document.body.classList.contains("edit");
    const toggle = document.getElementById("opt-page-jump") as HTMLInputElement | null;
    let enabled = true;
    try {
        if (editor) enabled = localStorage.getItem(key) !== "0";
    } catch {}
    let held: HTMLElement | null = null;
    let jumped = false;
    const reset = () => {
        held = null;
        jumped = false;
    };
    const current = () =>
        document.querySelector<HTMLAnchorElement>(
            "#site-title.cur, #nav-groups [data-doc-id] > .nav-row > a.cur",
        );
    const surface = (target: EventTarget | null): HTMLElement | null => {
        if (
            !enabled ||
            !(target instanceof Element) ||
            !current() ||
            document.querySelector('dialog[open], [aria-modal="true"]') ||
            target.closest(
                'input, textarea, select, button, label, a, summary, iframe, audio, video, canvas, svg, .cm-editor, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="textbox"], [role="searchbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="radiogroup"], [role="spinbutton"], [role="slider"], [role="tablist"], [role="tree"], [role="grid"], [role="listbox"], [role="menu"], [role="application"]',
            )
        )
            return null;
        if (target === document.body && !editor) return document.querySelector("main");
        return target.closest<HTMLElement>(editor ? ".preview-pane.active" : "main");
    };
    if (toggle) {
        toggle.checked = enabled;
        toggle.addEventListener("change", () => {
            enabled = toggle.checked;
            reset();
            try {
                localStorage.setItem(key, enabled ? "1" : "0");
            } catch {}
        });
    }
    document.addEventListener("pointerdown", (event) => {
        const pane = surface(event.target);
        if (pane !== held) reset();
        if (pane) {
            if (!pane.hasAttribute("tabindex")) pane.tabIndex = -1;
            pane.focus({ preventScroll: true });
        }
    });
    document.addEventListener("focusin", (event) => {
        if (held && surface(event.target) !== held) reset();
    });
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) reset();
    });
    document.addEventListener("keydown", (event) => {
        if (
            event.defaultPrevented ||
            event.isComposing ||
            event.ctrlKey ||
            event.altKey ||
            event.metaKey ||
            event.shiftKey
        ) {
            reset();
            return;
        }
        const pane = surface(event.target);
        if (!pane) {
            reset();
            return;
        }
        if (event.code === "Space" || event.key === " ") {
            if (!held && !event.repeat) {
                held = pane;
                jumped = false;
            }
            if (held) event.preventDefault();
            return;
        }
        if (
            !held ||
            held !== pane ||
            !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
        )
            return;
        event.preventDefault();
        jumped = true;
        const selected = current();
        const item = selected?.closest<HTMLElement>(".nav-item[data-doc-id]");
        const link = (item: Element | null | undefined) =>
            item?.querySelector<HTMLAnchorElement>(":scope > .nav-row > a[href]");
        let destination: HTMLAnchorElement | null | undefined;
        if (event.key === "ArrowRight") {
            const list =
                item?.querySelector(":scope > .nav-list") ??
                (!item ? document.querySelector("#nav-groups > .nav-root") : null);
            destination = link(list?.querySelector(":scope > .nav-item[data-doc-id]"));
            if (destination && item)
                (
                    window as Window & { __docsNavOpen?: (id: string, open: boolean) => void }
                ).__docsNavOpen?.(item.dataset.docId ?? "", true);
        } else if (event.key === "ArrowLeft" && item) {
            destination =
                link(item.parentElement?.closest(".nav-item[data-doc-id]")) ??
                document.querySelector<HTMLAnchorElement>("#site-title[href]");
        } else if (item && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            const siblings = [...(item.parentElement?.children ?? [])].filter((node) =>
                node.matches(".nav-item[data-doc-id]"),
            );
            destination = link(
                siblings[siblings.indexOf(item) + (event.key === "ArrowUp" ? -1 : 1)],
            );
        }
        if (!destination) return;
        if (!pane.hasAttribute("tabindex")) pane.tabIndex = -1;
        pane.focus({ preventScroll: true });
        select(document.getElementById("nav-groups"), destination.href);
        destination.click();
    });
    document.addEventListener("keyup", (event) => {
        if (event.code !== "Space" && event.key !== " ") return;
        const pane = held;
        const scroll = !jumped && pane && surface(event.target) === pane;
        reset();
        if (!pane) return;
        event.preventDefault();
        if (scroll) pane.scrollBy({ top: pane.clientHeight * 0.875, behavior: "auto" });
    });
};
