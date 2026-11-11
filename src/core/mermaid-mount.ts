import mermaid from "mermaid";

mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
});

let nextId = 0;

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
                const source = diagram.textContent ?? "";
                void mermaid.render(`dooc-mermaid-${++nextId}`, source).then(
                    ({ svg }) => {
                        if (!root.contains(diagram)) return;
                        diagram.innerHTML = svg;
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
    return () => {
        observer.disconnect();
        visibility.disconnect();
        pending.clear();
    };
};
