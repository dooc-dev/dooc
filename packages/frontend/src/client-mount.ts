import { clientPath } from "../../workspace/src/client-path.js";

const mountLink = (link: HTMLAnchorElement) => {
    const href = link.getAttribute("href");
    if (!href || href === link.dataset.doocClientHref) return;
    const mounted = clientPath(href);
    if (mounted !== href) {
        link.setAttribute("href", mounted);
        link.dataset.doocClientHref = mounted;
    }
};

export const mountClientHtml = (html: string): string => {
    if (!globalThis.__doocClientBase) return html;
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const node of doc.querySelectorAll<HTMLElement>("[src], [href], [data-src]")) {
        for (const name of ["src", "href", "data-src"]) {
            const value = node.getAttribute(name);
            if (value) node.setAttribute(name, clientPath(value));
        }
        if (node.tagName === "A") node.dataset.doocClientHref = node.getAttribute("href") ?? "";
    }
    for (const style of doc.querySelectorAll("style"))
        style.textContent =
            style.textContent?.replace(
                /url\((['"]?)(\/assets\/[^)'"\s]+)\1\)/g,
                (_match, quote: string, path: string) => `url(${quote}${clientPath(path)}${quote})`,
            ) ?? "";
    return `<!doctype html>${doc.documentElement.outerHTML}`;
};

declare global {
    var __doocClientLinks: MutationObserver | undefined;
}

/** Navigation and search insert workspace-relative links after the initial page render. */
export const mountClientLinks = (): void => {
    globalThis.__doocClientLinks?.disconnect();
    if (!globalThis.__doocClientBase) return;
    const mount = (node: Node) => {
        if (node instanceof HTMLAnchorElement) mountLink(node);
        if (node instanceof Element)
            for (const link of node.querySelectorAll<HTMLAnchorElement>("a[href]")) mountLink(link);
    };
    mount(document.documentElement);
    const observer = new MutationObserver((records) => {
        for (const record of records) {
            if (record.type === "attributes") mount(record.target);
            else for (const node of record.addedNodes) mount(node);
        }
    });
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["href"],
    });
    globalThis.__doocClientLinks = observer;
    window.addEventListener(
        "click",
        (event) => {
            const link =
                event.target instanceof Element
                    ? event.target.closest<HTMLAnchorElement>("a[href]")
                    : null;
            if (link) mountLink(link);
        },
        true,
    );
};
