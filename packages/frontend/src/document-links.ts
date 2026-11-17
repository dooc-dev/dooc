import type { showDialog } from "./edit-dialog.js";

/** Self-contained so live readers and standalone HTML use the same click behavior. */
export const mountDocumentLinks = (
    dialog: typeof showDialog,
    network = true,
    request?: (path: string) => Promise<Response>,
): void => {
    const t = (text: string): string =>
        (window as Window & { __docsTranslate?: (text: string) => string }).__docsTranslate?.(
            text,
        ) ?? text;
    const mobile = () =>
        matchMedia("(max-width: 600px), (hover: none) and (pointer: coarse)").matches;
    const webUrl = (value: string | undefined): string | undefined => {
        if (!value) return;
        try {
            const url = new URL(value);
            if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password)
                return url.href;
        } catch {
            /* Invalid links cannot navigate. */
        }
    };
    let confirming = false;
    const confirm = async (url: string, message = "Open this website in a new tab?") => {
        if (confirming) return;
        confirming = true;
        try {
            if (
                (await dialog(t("Open externally?"), `${t(message)}\n\n${url}`, [
                    { value: "", label: t("Cancel") },
                    { value: "open", label: t("Open externally") },
                ])) === "open"
            )
                window.open(url, "_blank", "noopener,noreferrer");
        } finally {
            confirming = false;
        }
    };
    const click = (event: MouseEvent) => {
        if (event.defaultPrevented || (event.button !== 0 && event.button !== 1)) return;
        const link =
            event.target instanceof Element
                ? event.target.closest<HTMLAnchorElement>(
                      "a[href][data-jump-url], a[data-web-open]",
                  )
                : null;
        if (!link || link.hasAttribute("download")) return;
        const url = webUrl(link.dataset.jumpUrl ?? link.href);
        if (!url) return;
        if (event.button === 1 || event.ctrlKey || event.metaKey) {
            event.preventDefault();
            window.open(url, "_blank", "noopener,noreferrer");
        } else if (link.hasAttribute("data-web-open") || mobile() || !network) {
            event.preventDefault();
            void confirm(url);
        }
    };
    window.addEventListener("click", click, true);
    window.addEventListener("auxclick", click, true);
    const mounted = new WeakSet<HTMLElement>();
    const mount = () => {
        for (const host of document.querySelectorAll<HTMLElement>(".document-web[data-web-url]")) {
            if (mounted.has(host)) continue;
            mounted.add(host);
            const url = webUrl(host.dataset.webUrl);
            const status = host.querySelector<HTMLElement>("[data-web-status]");
            if (!url || !status) continue;
            if (mobile() || !network) {
                status.dataset.i18n = "Open this website externally to view it.";
                status.textContent = t(status.dataset.i18n);
                void confirm(url);
                continue;
            }
            const frame = document.createElement("iframe");
            frame.className = "document-web-frame";
            frame.title = host.dataset.title || url;
            frame.referrerPolicy = "no-referrer";
            frame.sandbox.add("allow-scripts", "allow-forms", "allow-popups");
            let failed = false;
            const fail = (
                message = "This website could not be displayed here. Open it externally?",
            ) => {
                if (failed) return;
                failed = true;
                clearTimeout(timer);
                document.removeEventListener("securitypolicyviolation", violation);
                if (!host.isConnected) return;
                status.hidden = false;
                status.dataset.i18n = message;
                status.textContent = t(message);
                void confirm(url, message);
            };
            const timer = setTimeout(
                () => fail("This website has not loaded. Open it externally?"),
                12000,
            );
            frame.onerror = () => fail();
            frame.onload = () => {
                clearTimeout(timer);
                document.removeEventListener("securitypolicyviolation", violation);
                if (!failed) status.hidden = true;
            };
            // shortcut: Browsers hide some cross-origin frame denials; retain the explicit external action.
            const violation = (event: SecurityPolicyViolationEvent) => {
                if (event.effectiveDirective === "frame-src" && event.blockedURI === url) fail();
            };
            document.addEventListener("securitypolicyviolation", violation);
            frame.src = url;
            host.append(frame);
            if (request)
                void request(
                    `/api/frame-policy?url=${encodeURIComponent(host.dataset.webUrl ?? url)}&parent=${encodeURIComponent(location.origin)}`,
                )
                    .then(async (response) => {
                        if (response.ok && (await response.json()).blocked === true) fail();
                    })
                    .catch(() => {});
        }
    };
    new MutationObserver(mount).observe(document.querySelector("main") ?? document.body, {
        childList: true,
        subtree: true,
    });
    mount();
};
