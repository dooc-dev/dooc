/** Self-contained so editor previews and standalone readers share section folding. */
export function mountSectionFolds(doc: Document): void {
    const content = (heading: Element): Element[] => {
        const result: Element[] = [];
        const level = Number(heading.tagName[1]);
        for (let node = heading.nextElementSibling; node; node = node.nextElementSibling) {
            if (/^H[1-6]$/.test(node.tagName) && Number(node.tagName[1]) <= level) break;
            result.push(node);
        }
        return result;
    };
    const collapsed = () =>
        doc.querySelectorAll<HTMLButtonElement>('.section-fold[aria-expanded="false"]');
    const expanded = (button: HTMLButtonElement, value: boolean): void => {
        button.setAttribute("aria-expanded", String(value));
        const label = value ? "Collapse section" : "Expand section";
        button.dataset.i18nTitle = button.dataset.i18nAriaLabel = label;
        button.title =
            (window as Window & { __docsTranslate?: (key: string) => string }).__docsTranslate?.(
                label,
            ) ?? label;
        button.setAttribute("aria-label", button.title);
    };
    const apply = (): void => {
        for (const node of doc.querySelectorAll("[data-section-hidden]"))
            node.removeAttribute("data-section-hidden");
        for (const button of collapsed())
            if (button.parentElement)
                for (const node of content(button.parentElement))
                    node.setAttribute("data-section-hidden", "");
    };
    const reveal = (target: Element): void => {
        for (const button of collapsed()) {
            const heading = button.parentElement;
            if (
                heading &&
                (heading === target || content(heading).some((node) => node.contains(target)))
            )
                expanded(button, true);
        }
        apply();
    };
    const revealHash = (hash: string, scope: ParentNode): Element | null => {
        if (!hash) return null;
        try {
            const id = decodeURIComponent(hash.slice(hash.lastIndexOf("#") + 1));
            const target = scope.querySelector(`#${CSS.escape(id)}`);
            if (target) reveal(target);
            return target;
        } catch {
            return null;
        }
    };
    doc.addEventListener(
        "click",
        (event) => {
            if (!(event.target instanceof Element)) return;
            const button = event.target.closest<HTMLButtonElement>(".section-fold");
            if (button) {
                expanded(button, button.getAttribute("aria-expanded") !== "true");
                apply();
                return;
            }
            const link = event.target.closest<HTMLAnchorElement>("a[href]");
            if (link?.origin === location.origin && link.pathname === location.pathname)
                revealHash(link.hash, link.closest(".preview-pane") ?? doc);
        },
        true,
    );
    doc.addEventListener("docs:reveal-section", (event) => {
        if (event.target instanceof Element) reveal(event.target);
    });
    window.addEventListener("hashchange", () => {
        revealHash(location.hash, doc.querySelector(".preview-pane.active") ?? doc)?.scrollIntoView(
            {
                block: "start",
            },
        );
    });
    new MutationObserver(apply).observe(doc.querySelector("main") ?? doc.body, {
        childList: true,
        subtree: true,
    });
    apply();
}
