/** Load enhancement scripts only when their content is near the viewport. */
export const loadPreviewScript = (src: string, selector: string, type = ""): void => {
    const root = document.querySelector("main") ?? document.body;
    let requested = false;
    const load = (): void => {
        if (requested) return;
        requested = true;
        const script = document.createElement("script");
        script.type = type;
        script.src = src;
        script.onload = () => {
            observer.disconnect();
            visibility.disconnect();
            pending.clear();
        };
        script.onerror = () => {
            script.remove();
            requested = false;
        };
        document.head.append(script);
    };
    const pending = new Set<Element>();
    const visibility = new IntersectionObserver(
        (entries) => {
            if (entries.some((entry) => entry.isIntersecting && root.contains(entry.target)))
                load();
        },
        { rootMargin: "200px" },
    );
    const watch = () => {
        for (const node of pending)
            if (!root.contains(node)) {
                visibility.unobserve(node);
                pending.delete(node);
            }
        for (const node of root.querySelectorAll(selector))
            if (!pending.has(node)) {
                pending.add(node);
                visibility.observe(node);
            }
    };
    const observer = new MutationObserver(watch);
    observer.observe(root, { childList: true, subtree: true });
    watch();
};
