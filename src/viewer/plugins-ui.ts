import { CHECK_ICON } from "../core/icons.js";
import type { PluginView } from "../plugins/view.js";
import { t } from "./i18n.js";
import { createPluginResize } from "./plugin-resize.js";
import { pluginViewHtml } from "./plugin-view.js";

export const mountPlugins = (): void => {
    window.addEventListener("message", (event: MessageEvent) => {
        const height = event.data?.doocPluginHeight;
        if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) return;
        for (const frame of document.querySelectorAll<HTMLIFrameElement>(
            "iframe[data-plugin-auto-height]",
        )) {
            if (
                frame.contentWindow !== event.source ||
                frame.parentElement?.hasAttribute("data-resized")
            )
                continue;
            const value = `${Math.max(32, Math.min(1200, Math.ceil(height)))}px`;
            if (frame.style.height !== value) frame.style.height = value;
        }
    });
    let registration = "";
    let headingId = 0;
    let seen = new WeakMap<HTMLElement, string>();
    const originals = new Map<HTMLElement, Node[]>();
    const resolved = new Map<string, Promise<{ plugin?: string; autoConnect?: boolean }>>();
    const connections = new Map<string, Promise<void>>();
    let connecting = Promise.resolve();
    const revisions = new Map<string, number>();
    const requests = new WeakMap<HTMLElement, object>();
    const channel =
        typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel("dooc:plugins");
    const clear = (plugin: string): void => {
        revisions.set(plugin, (revisions.get(plugin) ?? 0) + 1);
        for (const section of document.querySelectorAll<HTMLElement>("[data-plugin]")) {
            if (section.dataset.plugin !== plugin) continue;
            delete section.dataset.ready;
            for (const content of section.querySelectorAll(".plugin-content"))
                content.replaceChildren();
            const status = section.querySelector<HTMLElement>("[data-plugin-status]");
            if (status) status.textContent = t("Load data using your connected account");
        }
    };
    if (channel)
        channel.onmessage = (event: MessageEvent<unknown>) => {
            if (typeof event.data === "string") clear(event.data);
        };
    const mount = (): void => {
        if (!registration) return;
        for (const host of originals.keys()) if (!host.isConnected) originals.delete(host);
        for (const host of document.querySelectorAll<HTMLElement>("main [data-embed-url]")) {
            const url = host.dataset.embedUrl ?? "";
            if (seen.get(host) === url) continue;
            seen.set(host, url);
            const version = registration;
            let match = resolved.get(url);
            if (!match) {
                match = fetch("/api/plugins", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ action: "resolve", url }),
                    cache: "no-store",
                }).then(async (response) => {
                    if (!response.ok) throw new Error("Plugin URL resolution failed");
                    return response.json();
                });
                resolved.set(url, match);
            }
            void match
                .then(({ plugin, autoConnect }) => {
                    if (
                        !plugin ||
                        !host.isConnected ||
                        registration !== version ||
                        host.dataset.embedUrl !== url
                    )
                        return;
                    originals.set(host, [...host.childNodes]);
                    const section = document.createElement("section");
                    section.className = "plugin";
                    section.dataset.plugin = plugin;
                    section.dataset.url = url;
                    if (autoConnect) section.dataset.autoConnect = "true";
                    const header = document.createElement("header");
                    header.className = "plugin-header";
                    const info = document.createElement("div");
                    info.className = "plugin-info";
                    const heading = document.createElement("h2");
                    const link = document.createElement("a");
                    link.href = url;
                    link.target = "_blank";
                    link.rel = "noopener noreferrer";
                    link.textContent = host.textContent || url;
                    heading.append(link);
                    heading.id = `plugin-heading-${++headingId}`;
                    section.setAttribute("aria-labelledby", heading.id);
                    const toolbar = document.createElement("div");
                    toolbar.className = "plugin-toolbar";
                    for (const [action, label, paths] of [
                        [
                            "open",
                            "Open link",
                            '<path d="M11 3h6v6m0-6-8 8"/><path d="M8 4H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-4"/>',
                        ],
                        [
                            "copy",
                            "Copy link",
                            '<path d="m8 12 4-4m-5 2-2 2a3 3 0 0 0 4 4l2-2m-2-8 2-2a3 3 0 0 1 4 4l-2 2"/>',
                        ],
                        ["fold", "Collapse preview", '<path d="m5 7.5 5 5 5-5"/>'],
                    ]) {
                        const control = document.createElement(action === "open" ? "a" : "button");
                        control.className = "plugin-action";
                        control.dataset.pluginAction = action;
                        control.dataset.i18nTitle = label;
                        control.dataset.i18nAriaLabel = label;
                        control.title = t(label ?? "");
                        control.setAttribute("aria-label", t(label ?? ""));
                        control.innerHTML = `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
                        if (action === "copy") control.innerHTML += CHECK_ICON;
                        if (control instanceof HTMLAnchorElement) {
                            control.href = url;
                            control.target = "_blank";
                            control.rel = "noopener noreferrer";
                        } else control.type = "button";
                        if (action === "fold") {
                            control.setAttribute("aria-expanded", "true");
                            control.setAttribute("aria-controls", `plugin-result-${headingId}`);
                        }
                        toolbar.append(control);
                    }
                    const status = document.createElement("p");
                    status.dataset.pluginStatus = "";
                    status.setAttribute("role", "status");
                    status.textContent = t(
                        autoConnect
                            ? "Loading plugin data"
                            : "Load data using your connected account",
                    );
                    const controls = document.createElement("div");
                    controls.dataset.pluginControls = "";
                    controls.hidden = Boolean(autoConnect);
                    for (const [action, label] of autoConnect
                        ? [["read", "Retry"]]
                        : [
                              ["read", "Load data"],
                              ["connect", "Connect account"],
                              ["disconnect", "Forget connection"],
                          ]) {
                        const button = document.createElement("button");
                        button.type = "button";
                        button.dataset.pluginAction = action;
                        button.dataset.i18n = label;
                        button.textContent = t(label ?? "");
                        controls.append(button);
                    }
                    const result = document.createElement("div");
                    result.dataset.pluginResult = "";
                    result.className = "plugin-content";
                    result.id = `plugin-result-${headingId}`;
                    info.append(heading, status);
                    header.append(info, controls);
                    const collapsed = document.createElement("div");
                    collapsed.className = "plugin-content";
                    collapsed.dataset.pluginCollapsed = "";
                    section.append(toolbar, header, result, collapsed, createPluginResize(result));
                    host.replaceChildren(section);
                    if (autoConnect) void run(section, "read");
                })
                .catch(() => {
                    /* An unavailable plugin leaves the source URL readable. */
                });
        }
    };
    const events = new EventSource("/api/plugins/events");
    events.onmessage = (event: MessageEvent<string>) => {
        if (registration === event.data) return;
        registration = event.data;
        for (const section of document.querySelectorAll<HTMLElement>("[data-plugin]"))
            clear(section.dataset.plugin ?? "");
        for (const [host, nodes] of originals) if (host.isConnected) host.replaceChildren(...nodes);
        originals.clear();
        resolved.clear();
        connections.clear();
        seen = new WeakMap();
        mount();
    };
    new MutationObserver(mount).observe(document.querySelector("main") ?? document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-embed-url"],
    });
    window.addEventListener("popstate", mount);
    window.addEventListener("pagehide", () => {
        for (const section of document.querySelectorAll<HTMLElement>("[data-plugin]"))
            clear(section.dataset.plugin ?? "");
    });
    const run = async (
        section: HTMLElement,
        action: string,
        button?: HTMLButtonElement,
    ): Promise<void> => {
        const status = section.querySelector<HTMLElement>("[data-plugin-status]");
        const result = section.querySelector<HTMLElement>("[data-plugin-result]");
        const controls = section.querySelector<HTMLElement>("[data-plugin-controls]");
        const collapsed = section.querySelector<HTMLElement>("[data-plugin-collapsed]");
        if (!status || !result || !controls || !collapsed) return;
        const plugin = section.dataset.plugin ?? "";
        const autoConnect = section.dataset.autoConnect === "true";
        if (action !== "read") {
            clear(plugin);
            channel?.postMessage(plugin);
        }
        result.replaceChildren();
        collapsed.replaceChildren();
        delete section.dataset.ready;
        const revision = revisions.get(plugin) ?? 0;
        const request = {};
        requests.set(section, request);
        const current = (): boolean =>
            section.isConnected &&
            requests.get(section) === request &&
            (revisions.get(plugin) ?? 0) === revision;
        if (button) button.disabled = true;
        section.setAttribute("aria-busy", "true");
        status.textContent = t("Loading plugin data");
        try {
            if (autoConnect) {
                let connection = connections.get(plugin);
                if (!connection) {
                    // Share one mock authorization across embeds and serialize session-cookie creation.
                    connection = connecting
                        .catch(() => {})
                        .then(async () => {
                            const response = await fetch("/api/plugins", {
                                method: "POST",
                                headers: { "content-type": "application/json" },
                                credentials: "same-origin",
                                cache: "no-store",
                                body: JSON.stringify({ action: "connect", plugin }),
                            });
                            const data = await response.json();
                            if (!response.ok || typeof data.url !== "string")
                                throw new Error("Plugin request failed");
                            const url = new URL(data.url);
                            if (
                                url.origin !== location.origin ||
                                !url.pathname.startsWith("/api/plugins/mock/")
                            )
                                throw new Error("Plugin request failed");
                            const authorization = await fetch(url.href, {
                                credentials: "same-origin",
                                cache: "no-store",
                            });
                            if (!authorization.ok) throw new Error("Plugin request failed");
                        });
                    connections.set(plugin, connection);
                    connecting = connection;
                }
                await connection;
                if (!current()) return;
            }
            const response = await fetch("/api/plugins", {
                method: "POST",
                credentials: "same-origin",
                cache: "no-store",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action, plugin, url: section.dataset.url }),
            });
            const data = (await response.json()) as {
                error?: string;
                url?: string;
                view?: PluginView;
                user?: { name: string };
            };
            if (!current()) return;
            if (!response.ok) throw new Error(data.error ?? "Plugin request failed");
            if (action === "connect" && data.url) {
                const link = document.createElement("a");
                link.href = data.url;
                link.target = "_blank";
                link.rel = "noopener noreferrer";
                link.textContent = t("Continue to service");
                status.replaceChildren(link);
            } else if (action === "read" && data.view && data.user) {
                const html = pluginViewHtml(data.view);
                const summary = data.view.collapsed ? pluginViewHtml(data.view.collapsed) : "";
                result.innerHTML = html;
                collapsed.innerHTML = summary;
                section.dataset.ready = "true";
                status.textContent = autoConnect
                    ? ""
                    : t("Connected as {name}", { name: data.user.name });
                controls.hidden = autoConnect;
            } else status.textContent = t("Connection forgotten in dooc");
        } catch (error) {
            if (current()) {
                if (autoConnect) connections.delete(plugin);
                controls.hidden = false;
                status.textContent = t(
                    error instanceof Error ? error.message : "Plugin request failed",
                );
            }
        } finally {
            if (button) button.disabled = false;
            if (requests.get(section) === request) section.removeAttribute("aria-busy");
        }
    };
    document.addEventListener("click", (event) => {
        const button =
            event.target instanceof Element
                ? event.target.closest<HTMLButtonElement>("button[data-plugin-action]")
                : null;
        const section = button?.closest<HTMLElement>("[data-plugin]");
        if (!button || !section) return;
        const action = button.dataset.pluginAction ?? "";
        if (action === "fold") {
            const collapsed = section.classList.toggle("collapsed");
            const label = collapsed ? "Expand preview" : "Collapse preview";
            button.setAttribute("aria-expanded", String(!collapsed));
            button.dataset.i18nTitle = label;
            button.dataset.i18nAriaLabel = label;
            button.title = t(label);
            button.setAttribute("aria-label", t(label));
        } else if (action === "copy") {
            void navigator.clipboard.writeText(section.dataset.url ?? "").then(
                () => {
                    button.dataset.state = "copied";
                    button.title = t("Copied");
                    button.setAttribute("aria-label", t("Copied"));
                    setTimeout(() => {
                        delete button.dataset.state;
                        button.title = t("Copy link");
                        button.setAttribute("aria-label", t("Copy link"));
                    }, 1500);
                },
                () => {
                    button.title = t("Copy failed");
                    button.setAttribute("aria-label", t("Copy failed"));
                },
            );
        } else void run(section, action, button);
    });
};
