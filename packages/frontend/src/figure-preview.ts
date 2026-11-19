import type { FigureEntry } from "../../engine/src/core/content-types.js";
import { escapeHtml } from "../../engine/src/core/escape-html.js";
import { figureFrameHtml } from "../../engine/src/core/figure-frame.js";

export const deferredFigureHtml = (fig: FigureEntry, cls = "fig-frame", label?: string): string => {
    if (fig.markup.length <= 100_000) return figureFrameHtml(fig, cls, label);
    if (cls.includes("figpop-frame")) return escapeHtml(fig.title ?? fig.file);
    const url = `/api/figure-preview?file=${encodeURIComponent(fig.file)}${label === undefined ? "" : `&label=${encodeURIComponent(label)}`}`;
    return `<div class="figure-placeholder" data-figure-preview="${escapeHtml(url)}"><span>${escapeHtml(label || fig.title || fig.file)}</span><button type="button" data-i18n="Retry" hidden>Retry</button><span role="status"></span></div>`;
};

/** Load visible figures automatically, including previews inserted by navigation or HMR. */
export function mountFigurePreviews(
    request: (url: string, init?: RequestInit, workspace?: string) => Promise<Response> = fetch,
): void {
    const root = document.querySelector("main") ?? document.body;
    const load = async (host: HTMLElement): Promise<void> => {
        const button = host.querySelector<HTMLButtonElement>(":scope > button");
        const url = host.dataset.figurePreview;
        const status = host.querySelector<HTMLElement>('[role="status"]');
        if (!button || button.disabled || !url || !status) return;
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
            button.hidden = false;
            button.textContent = translate("Retry");
        } finally {
            button.disabled = false;
            host.removeAttribute("aria-busy");
        }
    };
    document.addEventListener("click", (event) => {
        const button =
            event.target instanceof Element
                ? event.target.closest<HTMLButtonElement>("[data-figure-preview] > button")
                : null;
        if (button?.parentElement) void load(button.parentElement);
    });
    const watched = new Set<HTMLElement>();
    const visibility = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting || !root.contains(entry.target)) continue;
                visibility.unobserve(entry.target);
                void load(entry.target as HTMLElement);
            }
        },
        { rootMargin: "200px" },
    );
    const watch = () => {
        for (const host of watched)
            if (!root.contains(host) || !host.dataset.figurePreview) {
                visibility.unobserve(host);
                watched.delete(host);
            }
        for (const host of root.querySelectorAll<HTMLElement>("[data-figure-preview]"))
            if (!watched.has(host)) {
                watched.add(host);
                visibility.observe(host);
            }
    };
    new MutationObserver(watch).observe(root, { childList: true, subtree: true });
    watch();
}
