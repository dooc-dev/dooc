// Body-text figures (svg / html in figures/) are rendered confined in a sandboxed iframe
// (srcdoc): the figure's <style> doesn't leak into the page and the page's CSS doesn't reach the
// figure (full isolation). Rasters are fine as plain <img>.
//   - Theme: the parent's CSS variables don't reach the iframe, so the theme is passed via the
//     srcdoc's <html data-doc-theme> (the FIGURE_THEME_STYLE already embedded in the figure looks
//     at `[data-doc-theme] [data-doc-figure]`). mountFigureFrames follows the parent's theme
//     switches by rewriting the srcdoc. "auto" = left to prefers-color-scheme inside the figure
//     (so it still follows the OS even in consumers without scripts).
//   - Height: svg height is determined by the viewBox ratio (aspect-ratio), so no script is
//     needed (sandbox="" = everything forbidden). html depends on its content, so a script that
//     only postMessages the height to the parent is added (sandbox="allow-scripts" only; no
//     allow-same-origin = treated as a separate origin, so it can't reach the parent's DOM /
//     cookies. The figure's own <script> is forbidden by the compiler).
import type { FigureEntry } from "./content-types.js";

const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const BASE_STYLE =
    "<style>html,body{margin:0;padding:0;height:100%;background:transparent;overflow:hidden}" +
    'html{color-scheme:light dark}html[data-doc-theme="light"]{color-scheme:light}html[data-doc-theme="dark"]{color-scheme:dark}' +
    'body{font:14px/1.6 system-ui,-apple-system,"Segoe UI","Noto Sans JP",sans-serif}' +
    "body>svg{display:block;width:100%;height:100%}</style>";
// html figures only: report the content height to the parent (the parent finds its own iframe
// via event.source).
const HEIGHT_SCRIPT =
    '<script>(()=>{const s=()=>parent.postMessage({docFigureHeight:Math.ceil(document.body.scrollHeight)},"*");' +
    'document.documentElement.style.height="auto";document.body.style.height="auto";' +
    "new ResizeObserver(s).observe(document.body);s();})()</script>";

export type FigureTheme = "auto" | "light" | "dark";

export const figureSrcdoc = (fig: FigureEntry, theme: FigureTheme = "auto"): string =>
    `<!doctype html><html data-doc-theme="${theme}"><head><meta charset="utf-8">${BASE_STYLE}</head><body>${fig.markup}${fig.kind === "html" ? HEIGHT_SCRIPT : ""}</body></html>`;

/**
 * Display width of the svg root (width attribute, or the viewBox width if absent) and its aspect
 * ratio. undefined if they can't be read.
 */
const svgBox = (markup: string): { width: number; w: number; h: number } | undefined => {
    const root = /<svg\b[^>]*>/i.exec(markup)?.[0] ?? "";
    const attr = (n: string): string | undefined =>
        new RegExp(`\\s${n}\\s*=\\s*["']([^"']*)["']`, "i").exec(root)?.[1];
    const vb = attr("viewBox")
        ?.trim()
        .split(/[\s,]+/)
        .map(Number);
    const [w, h] =
        vb && vb.length === 4
            ? [vb[2], vb[3]]
            : [Number.parseFloat(attr("width") ?? ""), Number.parseFloat(attr("height") ?? "")];
    if (!w || !h || !(w > 0) || !(h > 0)) {
        return undefined;
    }
    const px = Number.parseFloat(attr("width") ?? "");
    return { width: px > 0 && !/%/.test(attr("width") ?? "") ? px : w, w, h };
};

/** One figure → an isolated iframe (rasters stay as <img>). */
export const figureFrameHtml = (fig: FigureEntry, cls = "fig-frame", label?: string): string => {
    if (fig.kind === "video")
        return label
            ? fig.markup.replace(/\baria-label="[^"]*"/, () => `aria-label="${esc(label)}"`)
            : fig.markup;
    if (fig.kind === "image") {
        return label === undefined
            ? fig.markup
            : fig.markup.replace(/\balt="[^"]*"/, () => `alt="${esc(label)}"`);
    }
    const box = fig.kind === "svg" ? svgBox(fig.markup) : undefined;
    const style = box
        ? `width:${box.width}px;aspect-ratio:${box.w} / ${box.h}`
        : fig.kind === "svg"
          ? "width:100%;height:240px"
          : "width:100%;height:120px";
    return `<iframe class="${cls}" data-doc-figure-frame="${fig.kind}" sandbox="${fig.kind === "html" ? "allow-scripts" : ""}" scrolling="no" loading="lazy" title="${esc(label || fig.title || `Fig.${fig.name}`)}" style="${style}" srcdoc="${esc(figureSrcdoc(fig))}"></iframe>`;
};

/**
 * Parent side of figure iframes: theme following (rewrites the srcdoc's data-doc-theme when
 * <html data-theme> or the OS setting changes) and applying html figure heights. Also works for
 * iframes inserted later (e.g. when edit swaps out the main content). Self-contained (it is
 * stringified with toString and embedded in the page) — do not reference outside identifiers.
 */
export function mountFigureFrames(doc: Document): void {
    const SEL = "iframe[data-doc-figure-frame]";
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const watched = new WeakSet<Element>();
    const loaded = new WeakSet<Element>();
    const theme = (element: Element): string => {
        const t =
            element.closest<HTMLElement>("[data-theme]")?.dataset.theme ??
            doc.documentElement.dataset.theme;
        return t === "light" || t === "dark" ? t : media.matches ? "dark" : "light";
    };
    const apply = (f: Element): void => {
        if (!watched.has(f)) {
            watched.add(f);
            f.removeAttribute("data-theme-ready");
            f.addEventListener("load", () => {
                loaded.add(f);
                apply(f);
            });
        }
        // Rewriting srcdoc during its initial load can leave the frame without layout.
        if (!loaded.has(f)) return;
        const src = f.getAttribute("srcdoc") ?? "";
        const next = src.replace(
            /^(<!doctype html><html data-doc-theme=")[a-z]+"/,
            `$1${theme(f)}"`,
        );
        if (next !== src) {
            loaded.delete(f);
            f.removeAttribute("data-theme-ready");
            f.setAttribute("srcdoc", next);
        } else f.setAttribute("data-theme-ready", "true");
    };
    const all = (): void => {
        for (const f of doc.querySelectorAll(SEL)) apply(f);
    };
    new MutationObserver((records) => {
        for (const r of records) {
            if (r.type === "attributes") {
                all();
                return;
            }
            for (const n of r.addedNodes) {
                if (!(n instanceof Element)) continue;
                if (n.matches(SEL)) apply(n);
                for (const f of n.querySelectorAll(SEL)) apply(f);
            }
        }
    }).observe(doc.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
        childList: true,
        subtree: true,
    });
    media.addEventListener("change", all);
    window.addEventListener("message", (ev: MessageEvent) => {
        const h = (ev.data as { docFigureHeight?: unknown } | null)?.docFigureHeight;
        // A frame can report zero before layout; keep its initial viewport until measured.
        if (typeof h !== "number" || !Number.isFinite(h) || h <= 0) return;
        for (const f of doc.querySelectorAll<HTMLIFrameElement>(
            `${SEL}[data-doc-figure-frame="html"]`,
        )) {
            if (f.contentWindow === ev.source) f.style.height = `${h}px`;
        }
    });
    all();
}
