import mermaid from "mermaid";

const BASE_CONFIG = {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    layout: "dagre",
} as const;
mermaid.initialize(BASE_CONFIG);

const SERIES = ["accent", "info", "ok", "warn", "danger"].flatMap((name) => [name, `${name}-2`]);

/** Map the page's --doc-* tokens onto Mermaid's base theme; undefined when the page defines none. */
export const mermaidThemeVariables = (
    token: (name: string) => string,
    darkMode: boolean,
): Record<string, string | boolean> | undefined => {
    const bg = token("bg");
    const fg = token("fg");
    if (!bg || !fg) return undefined;
    const border = token("border-2") || fg;
    const variables: Record<string, string | boolean> = {
        darkMode,
        background: bg,
        primaryColor: token("panel-2") || bg,
        primaryTextColor: fg,
        primaryBorderColor: border,
        secondaryColor: token("bg-2") || bg,
        secondaryBorderColor: border,
        tertiaryColor: token("bg-3") || bg,
        tertiaryBorderColor: border,
        textColor: fg,
        lineColor: token("fg-3") || fg,
        edgeLabelBackground: bg,
        noteBkgColor: token("panel") || bg,
        noteTextColor: fg,
        noteBorderColor: border,
        pieStrokeColor: bg,
        pieOuterStrokeColor: border,
        pieTitleTextColor: fg,
        pieLegendTextColor: fg,
    };
    // Mermaid derives pie slices by hue-shifting primaryColor, which stays gray for a neutral palette.
    SERIES.forEach((name, index) => {
        const color = token(name);
        if (color) variables[`pie${index + 1}`] = color;
    });
    return variables;
};

const applyTheme = (diagram: HTMLElement): void => {
    const style = getComputedStyle(diagram);
    const themeVariables = mermaidThemeVariables(
        (name) => style.getPropertyValue(`--doc-${name}`).trim(),
        style.colorScheme === "dark",
    );
    // shortcut: config is global, so diagrams queued together share the last palette; pass
    // per-diagram frontmatter if nested [data-theme] regions ever need distinct diagram colors.
    mermaid.initialize(
        themeVariables ? { ...BASE_CONFIG, theme: "base", themeVariables } : BASE_CONFIG,
    );
};

let nextId = 0;
const sources = new WeakMap<HTMLElement, string>();

/** Render newly inserted diagrams, including live previews and offline page navigation. */
export const watchMermaid = (root: ParentNode & Node): (() => void) => {
    const pending = new Set<HTMLElement>();
    const visibility = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const diagram = entry.target as HTMLElement;
                visibility.unobserve(diagram);
                pending.delete(diagram);
                if (!root.contains(diagram) || diagram.dataset.mermaid !== "pending") continue;
                diagram.dataset.mermaid = "rendering";
                // A themed re-render still shows the old SVG, so its source comes from the cache.
                const source =
                    (diagram.firstElementChild && sources.get(diagram)) ??
                    diagram.textContent ??
                    "";
                applyTheme(diagram);
                void mermaid.render(`dooc-mermaid-${++nextId}`, source).then(
                    ({ svg }) => {
                        if (!root.contains(diagram)) return;
                        diagram.innerHTML = svg;
                        sources.set(diagram, source);
                        diagram.dataset.mermaid = "ready";
                    },
                    (error: unknown) => {
                        if (!root.contains(diagram)) return;
                        diagram.dataset.mermaid = "error";
                        diagram.textContent = `${source}\n\n${error instanceof Error ? error.message : String(error)}`;
                        diagram.setAttribute("role", "status");
                    },
                );
            }
        },
        { rootMargin: "200px" },
    );
    const render = (node: ParentNode): void => {
        const diagrams = [...node.querySelectorAll<HTMLElement>("[data-mermaid]")];
        if (node instanceof HTMLElement && node.matches("[data-mermaid]")) diagrams.unshift(node);
        for (const diagram of diagrams) {
            if (diagram.dataset.mermaid !== "pending" || pending.has(diagram)) continue;
            pending.add(diagram);
            visibility.observe(diagram);
        }
    };
    render(root);
    const observer = new MutationObserver((records) => {
        for (const diagram of pending)
            if (!root.contains(diagram)) {
                pending.delete(diagram);
                visibility.unobserve(diagram);
            }
        for (const record of records)
            for (const node of record.addedNodes)
                if (node instanceof Element && root.contains(node)) render(node);
    });
    observer.observe(root, { childList: true, subtree: true });
    const retheme = (): void => {
        for (const diagram of root.querySelectorAll<HTMLElement>('[data-mermaid="ready"]'))
            diagram.dataset.mermaid = "pending";
        render(root);
    };
    const themeObserver = new MutationObserver(retheme);
    themeObserver.observe(document.documentElement, {
        attributeFilter: ["data-theme"],
        subtree: true,
    });
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", retheme);
    return () => {
        observer.disconnect();
        themeObserver.disconnect();
        media.removeEventListener("change", retheme);
        visibility.disconnect();
        pending.clear();
    };
};
