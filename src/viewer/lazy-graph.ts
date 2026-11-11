/** Load diagram runtimes only when a page or live preview contains a diagram. */
export const loadGraphScript = (): void => {
    const root = document.querySelector("main") ?? document.body;
    const selector = "svg[data-sg-layout], [data-mermaid]";
    let requested = false;
    const load = (): void => {
        if (requested) return;
        requested = true;
        const script = document.createElement("script");
        script.src = "/assets/graph.js";
        script.onload = () => observer.disconnect();
        script.onerror = () => {
            script.remove();
            requested = false;
        };
        document.head.append(script);
    };
    const observer = new MutationObserver((records) => {
        for (const record of records)
            for (const node of record.addedNodes)
                if (
                    node instanceof Element &&
                    root.contains(node) &&
                    (node.matches(selector) || node.querySelector(selector))
                )
                    load();
    });
    observer.observe(root, { childList: true, subtree: true });
    if (root.querySelector(selector)) load();
};
