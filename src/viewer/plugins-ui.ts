import { CHECK_ICON } from "../core/icons.js";
import type { PluginView } from "../plugins/view.js";
import { t } from "./i18n.js";
import { mountPluginActions } from "./plugin-actions.js";
import { createPluginResize } from "./plugin-resize.js";
import { pluginViewHtml } from "./plugin-view.js";

export const mountPlugins = (): void => {
    const disposers = new Map<HTMLElement, () => void>();
    const syncIcons = () => {
        for (const image of document.querySelectorAll<HTMLImageElement>(
            "img[data-plugin-icon-light]",
        )) {
            const source =
                getComputedStyle(image).colorScheme === "dark"
                    ? image.dataset.pluginIconDark
                    : image.dataset.pluginIconLight;
            if (source && image.src !== source) image.src = source;
        }
    };
    new MutationObserver(syncIcons).observe(document.documentElement, {
        subtree: true,
        attributes: true,
        attributeFilter: ["data-theme", "data-editor-theme"],
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncIcons);
    const render = (section: HTMLElement, view: PluginView) => {
        const result = section.querySelector<HTMLElement>("[data-plugin-result]");
        const collapsed = section.querySelector<HTMLElement>("[data-plugin-collapsed]");
        const url = section.dataset.url;
        if (!result || !collapsed || !url) throw new Error(t("Plugin request failed"));
        const html = pluginViewHtml(view);
        const summary = view.collapsed ? pluginViewHtml(view.collapsed) : "";
        result.innerHTML = html;
        collapsed.innerHTML = summary;
        section.querySelector(".plugin-heading")?.remove();
        if (view.header) {
            const heading = document.createElement("span");
            heading.className = "plugin-heading";
            const link = document.createElement("a");
            link.href = url;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            if (view.header.icon) {
                const image = document.createElement("img");
                image.alt = "";
                image.width = image.height = 16;
                image.dataset.pluginIconLight = view.header.icon.light;
                image.dataset.pluginIconDark = view.header.icon.dark ?? view.header.icon.light;
                image.src = view.header.icon.light;
                link.append(image);
            }
            const name = document.createElement("strong");
            name.textContent = view.header.title;
            link.append(name);
            heading.append(link);
            if (view.header.context) {
                const context = document.createElement("span");
                context.className = "plugin-heading-context";
                context.textContent = view.header.context;
                heading.append(context);
            }
            if (view.header.reference) {
                const ref = document.createElement("button");
                ref.type = "button";
                ref.dataset.blockCopy = view.header.reference;
                ref.textContent = view.header.reference;
                ref.title = t("Copy");
                heading.append(ref);
            }
            section.querySelector(".plugin-toolbar")?.prepend(heading);
            syncIcons();
        }
    };
    let registration = "";
    let headingId = 0;
    let seen = new WeakMap<HTMLElement, string>();
    const originals = new Map<HTMLElement, Node[]>();
    const resolved = new Map<
        string,
        Promise<{ plugin?: string; autoConnect?: boolean; connected?: boolean }>
    >();
    const connections = new Map<string, Promise<void>>();
    let connecting: Promise<void> | undefined;
    const revisions = new Map<string, number>();
    const requests = new WeakMap<HTMLElement, object>();
    const channel =
        typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel("dooc:plugins");
    const clear = (plugin: string): void => {
        resolved.clear();
        revisions.set(plugin, (revisions.get(plugin) ?? 0) + 1);
        for (const section of document.querySelectorAll<HTMLElement>("[data-plugin]")) {
            if (section.dataset.plugin !== plugin) continue;
            disposers.get(section)?.();
            disposers.delete(section);
            delete section.dataset.ready;
            for (const content of section.querySelectorAll(".plugin-content"))
                content.replaceChildren();
            const status = section.querySelector<HTMLElement>("[data-plugin-status]");
            if (status) status.textContent = t("Load data using your connected account");
        }
    };
    document.addEventListener("docs:plugin-connection", (event) => {
        const plugin = (event as CustomEvent<unknown>).detail;
        if (typeof plugin !== "string") return;
        clear(plugin);
        channel?.postMessage(plugin);
    });
    if (channel)
        channel.onmessage = (event: MessageEvent<unknown>) => {
            if (typeof event.data === "string") clear(event.data);
        };
    const mount = (): void => {
        if (!registration) return;
        for (const [section, dispose] of disposers)
            if (!section.isConnected) {
                dispose();
                disposers.delete(section);
            }
        for (const host of originals.keys()) if (!host.isConnected) originals.delete(host);
        for (const host of document.querySelectorAll<HTMLElement>("main [data-embed-url]")) {
            const url = host.dataset.embedUrl ?? "";
            if (seen.get(host) === url) continue;
            seen.set(host, url);
            const version = registration;
            let match = resolved.get(url);
            if (!match) {
                match = (async () => {
                    const response = await fetch("/api/plugins", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ action: "resolve", url }),
                        cache: "no-store",
                    });
                    if (!response.ok) throw new Error("Plugin URL resolution failed");
                    return response.json();
                })();
                resolved.set(url, match);
            }
            const mountHost = async () => {
                try {
                    const { plugin, autoConnect, connected } = await match;
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
                        [
                            "edit",
                            "Edit",
                            '<path d="m12 3 5 5M3 17l4-1L17 6a2.1 2.1 0 0 0-3-3L4 13Z"/>',
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
                        if (action === "edit" && control instanceof HTMLButtonElement) {
                            control.disabled = true;
                            control.setAttribute("aria-pressed", "false");
                        }
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
                    if (autoConnect || connected) void run(section, "read");
                } catch {
                    // An unavailable plugin leaves the source URL readable.
                }
            };
            void mountHost();
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
        disposers.get(section)?.();
        disposers.delete(section);
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
                    const previous = connecting;
                    connection = (async () => {
                        try {
                            await previous;
                        } catch {
                            // A failed connection must not block the next authorization.
                        }
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
                    })();
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
                render(section, data.view);
                section.dataset.ready = "true";
                status.textContent = autoConnect
                    ? ""
                    : t("Connected as {name}", { name: data.user.name });
                controls.hidden = autoConnect;
                let viewSignature = JSON.stringify(data.view);
                const api = async (action: string, payload = {}) => {
                    if (!current()) throw new Error("Plugin connection changed");
                    const response = await fetch("/api/plugins", {
                        method: "POST",
                        credentials: "same-origin",
                        cache: "no-store",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({
                            action,
                            plugin,
                            url: section.dataset.url,
                            ...payload,
                        }),
                    });
                    const data = await response.json();
                    if (!current()) throw new Error("Plugin connection changed");
                    if (!response.ok)
                        throw Object.assign(new Error(data.error ?? "Plugin request failed"), {
                            status: response.status,
                        });
                    return data;
                };
                disposers.set(
                    section,
                    mountPluginActions(
                        section,
                        api,
                        async (ready, force) => {
                            const data = await api("read");
                            const signature = JSON.stringify(data.view);
                            if ((force || signature !== viewSignature) && ready()) {
                                render(section, data.view);
                                viewSignature = signature;
                            }
                        },
                        current,
                    ),
                );
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
    window.addEventListener("focus", () => {
        resolved.clear();
        for (const section of document.querySelectorAll<HTMLElement>("[data-plugin]"))
            if (!section.dataset.ready && !section.hasAttribute("aria-busy"))
                void run(section, "read");
    });
    document.addEventListener("click", async (event) => {
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
            try {
                await navigator.clipboard.writeText(section.dataset.url ?? "");
                button.dataset.state = "copied";
                button.title = t("Copied");
                button.setAttribute("aria-label", t("Copied"));
                setTimeout(() => {
                    delete button.dataset.state;
                    button.title = t("Copy link");
                    button.setAttribute("aria-label", t("Copy link"));
                }, 1500);
            } catch {
                button.title = t("Copy failed");
                button.setAttribute("aria-label", t("Copy failed"));
            }
        } else if (action !== "edit") await run(section, action, button);
    });
};
