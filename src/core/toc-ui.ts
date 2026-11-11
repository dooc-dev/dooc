/** Self-contained so live previews and standalone HTML share the same navigation. */
export function mountToc(doc: Document): () => void {
    const controller = new AbortController();
    const mounted = new Map<
        HTMLElement,
        { article: HTMLElement; update: () => void; dispose: () => void }
    >();
    let sequence = 0;
    let frame = 0;
    const schedule = (): void => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            for (const { update } of mounted.values()) update();
        });
    };
    const resize = new ResizeObserver(schedule);
    const initialize = (): void => {
        for (const [nav, { article, dispose }] of mounted)
            if (!nav.isConnected || !article.isConnected) {
                dispose();
                resize.unobserve(article);
                mounted.delete(nav);
                nav.remove();
            }
        for (const nav of doc.querySelectorAll<HTMLElement>(".in-toc")) {
            if (mounted.has(nav)) continue;
            const article = nav.closest("article");
            const button = nav.querySelector<HTMLButtonElement>(".toc-current");
            const list = nav.querySelector("ul");
            if (!article || !button || !list) continue;
            const pane = nav.closest<HTMLElement>(".preview-pane");
            const scroller = pane ?? nav.closest("main") ?? doc.scrollingElement;
            if (!scroller) continue;
            const header = (pane ?? article.parentElement)?.querySelector<HTMLElement>(
                ":scope > .pane-actions, :scope > .page-actions",
            );
            const listeners = new AbortController();
            const options = { signal: listeners.signal };
            list.id = `toc-options-${++sequence}`;
            button.setAttribute("aria-controls", list.id);
            const sections = [...nav.querySelectorAll<HTMLAnchorElement>("[data-toc-target]")]
                .map((link) => ({
                    link,
                    heading: article.querySelector<HTMLElement>(
                        `#${CSS.escape(link.dataset.tocTarget ?? "")}`,
                    ),
                }))
                .filter((section) => section.heading !== null);
            let active: HTMLAnchorElement | undefined;
            let card = false;
            const update = (): void => {
                const narrow = article.clientWidth < 520;
                if (card !== narrow) {
                    card = narrow;
                    const focused = nav.contains(doc.activeElement);
                    list.popover = card ? null : "auto";
                    list.removeAttribute("style");
                    nav.classList.toggle("toc-card", card);
                    if (focused)
                        (card ? (active ?? sections[0]?.link) : button)?.focus({
                            preventScroll: true,
                        });
                }
                const top =
                    (header?.getBoundingClientRect().bottom ??
                        pane?.getBoundingClientRect().top ??
                        0) + 20;
                let current = sections[0];
                for (const section of sections)
                    if ((section.heading?.getBoundingClientRect().top ?? Infinity) <= top)
                        current = section;
                if (
                    scroller.scrollTop > 0 &&
                    scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1
                )
                    current = sections.at(-1);
                if (current?.link === active) return;
                active?.removeAttribute("aria-current");
                active = current?.link;
                if (active) {
                    active.setAttribute("aria-current", "location");
                    button.textContent = button.title = active.textContent ?? "";
                }
            };
            button.addEventListener(
                "click",
                () => {
                    if (list.matches(":popover-open")) {
                        list.hidePopover();
                        return;
                    }
                    const rect = button.getBoundingClientRect();
                    const width = Math.min(240, innerWidth - 16);
                    list.style.width = `${width}px`;
                    list.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
                    list.style.top = `${rect.bottom + 6}px`;
                    list.showPopover();
                    list.scrollTop = Math.max(0, (active?.offsetTop ?? 0) - list.clientHeight / 2);
                    active?.focus({ preventScroll: true });
                },
                options,
            );
            list.addEventListener(
                "toggle",
                () => {
                    button.setAttribute("aria-expanded", String(list.matches(":popover-open")));
                },
                options,
            );
            list.addEventListener(
                "keydown",
                (event) => {
                    if (card) return;
                    const index = sections.findIndex(({ link }) => link === doc.activeElement);
                    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                        event.preventDefault();
                        const next =
                            event.key === "Home"
                                ? 0
                                : event.key === "End"
                                  ? sections.length - 1
                                  : (index +
                                        (event.key === "ArrowDown" ? 1 : sections.length - 1)) %
                                    sections.length;
                        sections[next]?.link.focus();
                    }
                    if (event.key === "Escape") button.focus({ preventScroll: true });
                },
                options,
            );
            list.addEventListener(
                "click",
                (event) => {
                    if (
                        event.button !== 0 ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                    )
                        return;
                    const link = (event.target as Element).closest("[data-toc-target]");
                    const heading = sections.find((section) => section.link === link)?.heading;
                    if (!heading) return;
                    if (!card) {
                        list.hidePopover();
                        button.focus({ preventScroll: true });
                    }
                    if (pane) {
                        // Pane activation is asynchronous, so resolve the clicked pane directly.
                        event.preventDefault();
                        heading.scrollIntoView({ block: "start" });
                    }
                },
                options,
            );
            mounted.set(nav, { article, update, dispose: () => listeners.abort() });
            resize.observe(article);
        }
        schedule();
    };
    const observer = new MutationObserver(initialize);
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    doc.addEventListener("scroll", schedule, {
        capture: true,
        passive: true,
        signal: controller.signal,
    });
    doc.addEventListener("load", schedule, { capture: true, signal: controller.signal });
    doc.addEventListener("docs:font-change", schedule, { signal: controller.signal });
    window.addEventListener("resize", schedule, { signal: controller.signal });
    initialize();
    return () => {
        controller.abort();
        observer.disconnect();
        resize.disconnect();
        cancelAnimationFrame(frame);
        for (const { dispose } of mounted.values()) dispose();
        mounted.clear();
    };
}
