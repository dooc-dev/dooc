import type { FigureEntry } from "../../engine/src/core/content-types.js";
import { escapeHtml } from "../../engine/src/core/escape-html.js";
import { figureFrameHtml } from "../../engine/src/core/figure-frame.js";

export const deferredFigureHtml = (fig: FigureEntry, cls = "fig-frame", label?: string): string => {
    if (fig.markup.length <= 100_000) return figureFrameHtml(fig, cls, label);
    if (cls.includes("figpop-frame")) return escapeHtml(fig.title ?? fig.file);
    const url = `/api/figure-preview?file=${encodeURIComponent(fig.file)}${label === undefined ? "" : `&label=${encodeURIComponent(label)}`}`;
    return `<div class="figure-placeholder" data-figure-preview="${escapeHtml(url)}"><span>${escapeHtml(label || fig.title || fig.file)}</span><button type="button" data-i18n="Load preview">Load preview</button><span role="status"></span></div>`;
};

/** Delegated so previews inserted by navigation or HMR use the same loading state. */
export function mountFigurePreviews(
    request: (url: string, init?: RequestInit, workspace?: string) => Promise<Response> = fetch,
): void {
    document.addEventListener("click", async (event) => {
        const button =
            event.target instanceof Element
                ? event.target.closest<HTMLButtonElement>("[data-figure-preview] > button")
                : null;
        const host = button?.parentElement;
        const url = host?.dataset.figurePreview;
        const status = host?.querySelector<HTMLElement>('[role="status"]');
        if (!button || !host || !url || !status) return;
        const translate = (key: string) =>
            (window as Window & { __docsTranslate?: (key: string) => string }).__docsTranslate?.(
                key,
            ) ?? key;
        button.disabled = true;
        host.setAttribute("aria-busy", "true");
        status.textContent = translate("Loading");
        try {
            const response = await request(
                url,
                undefined,
                host.closest<HTMLElement>("[data-workspace]")?.dataset.workspace,
            );
            if (!response.ok) throw new Error(translate("Preview unavailable"));
            const html = await response.text();
            if (!host.isConnected) return;
            const focused = document.activeElement === button;
            host.innerHTML = html;
            host.classList.remove("figure-placeholder");
            delete host.dataset.figurePreview;
            if (focused) {
                host.tabIndex = -1;
                host.focus({ preventScroll: true });
            }
        } catch (error) {
            if (!host.isConnected) return;
            status.textContent = error instanceof Error ? error.message : String(error);
            button.textContent = translate("Retry");
            button.dataset.i18n = "Retry";
        } finally {
            button.disabled = false;
            host.removeAttribute("aria-busy");
        }
    });
}
