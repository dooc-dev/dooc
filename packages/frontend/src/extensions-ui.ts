import type { PluginResponse } from "../../../plugins/src/transport.js";
import {
    type ExtensionSummary,
    extensionFile,
    MAX_EXTENSION_BYTES,
} from "../../engine/src/core/extension-package.js";
import { PLUGINS_ICON } from "../../engine/src/core/icons.js";
import {
    workspaceConnection,
    workspaceFetch,
    workspaceId,
} from "../../workspace/src/connection.js";
import type { WorkspaceHello } from "../../workspace/src/protocol.js";
import { confirmDialog, showNotice } from "./edit-dialog.js";
import { browserExtensionRequest, extensionBase64, extensionBytes } from "./extensions-store.js";
import { t } from "./i18n.js";

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
};
interface ExtensionList {
    scope: string;
    items: ExtensionSummary[];
}
interface ExtensionContents {
    file: string;
    hash: string;
    files: { name: string; data: string }[];
}

export const mountExtensions = (): void => {
    const mounted = new Set<string>();
    const mount = () => {
        const id = workspaceId();
        if (mounted.has(id)) return;
        mounted.add(id);
        mountWorkspaceExtensions(id);
    };
    document.addEventListener("dooc:workspace-changed", mount);
    mount();
};

const mountWorkspaceExtensions = (workspace: string): void => {
    const nav = document.getElementById("nav-extensions");
    if (!nav) return;
    const connection = workspaceConnection(workspace);
    let local = !connection && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
    let pluginAccounts = local;
    const ready = connection
        ? connection.client
              .request<WorkspaceHello>("hello")
              .then((hello) => {
                  local = hello.ops.includes("extensions");
                  pluginAccounts = hello.ops.includes("plugins");
              })
              .catch(() => {})
        : Promise.resolve();
    const scope = nav.dataset.scope ?? location.pathname;
    let state: ExtensionList = { scope: connection ? `${workspace}:${scope}` : scope, items: [] };
    let host: HTMLElement | null = null;
    let busy = false;
    let notice = "";
    let opened: ExtensionContents | undefined;
    let path = "";
    const drafts = new Map<string, string>();
    const input = element("input");
    input.type = "file";
    input.accept = ".zip,application/zip";
    input.multiple = true;
    const request = async (body: Record<string, unknown>) => {
        await ready;
        if (!local) return browserExtensionRequest(state.scope, body);
        if (connection) return connection.client.request("extensions", body);
        const response = await workspaceFetch(
            "/api/extensions",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(20000),
            },
            workspace,
        );
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? `Plugins: ${response.status}`);
        return result;
    };
    const accounts = new Map<string, { id: string; name: string } | null>();
    let loginUrl = "";
    const pluginRequest = async (body: Record<string, unknown>) => {
        await ready;
        if (!pluginAccounts)
            throw new Error(t("Plugin accounts are not available for this workspace."));
        if (connection) {
            const result = await connection.client.request<PluginResponse>("plugins", body);
            if (body.action === "connect" || body.action === "disconnect")
                document.dispatchEvent(
                    new CustomEvent("docs:plugin-connection", {
                        detail: { plugin: body.plugin, workspace },
                    }),
                );
            return result;
        }
        const response = await workspaceFetch(
            "/api/plugins",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(20000),
            },
            workspace,
        );
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? `Login: ${response.status}`);
        if (body.action === "connect" || body.action === "disconnect")
            document.dispatchEvent(
                new CustomEvent("docs:plugin-connection", {
                    detail: { plugin: body.plugin, workspace },
                }),
            );
        return result;
    };
    const loadAccounts = async () => {
        if (!pluginAccounts) return;
        for (const item of state.items)
            for (const plugin of item.plugins)
                accounts.set(plugin, (await pluginRequest({ action: "status", plugin })).user);
    };
    const login = (plugin: string) => {
        const popup = window.open("about:blank", "_blank");
        if (popup) popup.opener = null;
        void operate(async () => {
            try {
                const result = await pluginRequest({ action: "connect", plugin });
                if (popup) popup.location.replace(result.url);
                else loginUrl = result.url;
            } catch (error) {
                popup?.close();
                throw error;
            }
        });
    };
    const button = (label: string, click: () => void, disabled = false) => {
        const node = element("button", "extension-button", t(label));
        node.type = "button";
        node.disabled = busy || disabled;
        node.onclick = click;
        return node;
    };
    const text = (entry: { data: string }) => {
        const bytes = extensionBytes(entry.data);
        if (bytes.includes(0)) throw new Error("Binary file");
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    };
    const read = async (file: string) => {
        opened = (await request({ action: "read", file })) as ExtensionContents;
        drafts.clear();
        path = opened.files.find((entry) => entry.name === path)?.name ?? "package.json";
    };
    const changed = async (body: Record<string, unknown>) => {
        state = (await request(body)) as ExtensionList;
        await loadAccounts();
    };
    const operate = async (action: () => Promise<void>) => {
        if (busy) return;
        busy = true;
        notice = "";
        render();
        try {
            await action();
        } catch (error) {
            notice = error instanceof Error ? error.message : String(error);
        } finally {
            busy = false;
            render();
            if (notice && !host?.isConnected) await showNotice(notice);
        }
    };
    const edit = async (file: string) => {
        if (opened?.file === file) return;
        if (drafts.size && !(await confirmDialog(t("Discard plugin changes?"), t("Discard"), true)))
            return;
        await operate(() => read(file));
    };
    const apply = async () => {
        if (!opened || !drafts.has(path)) return;
        const file = opened.file,
            source = drafts.get(path),
            selected = path;
        await operate(async () => {
            await changed({ action: "edit", file, path: selected, source, hash: opened?.hash });
            const remaining = new Map(drafts);
            remaining.delete(selected);
            await read(file);
            for (const [key, value] of remaining) drafts.set(key, value);
        });
    };
    const render = () => {
        const card = workspaceId() === workspace ? document.getElementById("nav-extensions") : null;
        card?.setAttribute("aria-busy", String(busy));
        if (!host?.isConnected) return;
        host.replaceChildren();
        const header = element("div", "extensions-header");
        header.append(element("h1", "", t("Plugins")));
        const dropzone = element("label", "extensions-dropzone");
        const mark = element("span", "extension-icon");
        mark.innerHTML = PLUGINS_ICON;
        input.disabled = busy;
        input.setAttribute("aria-label", t("Add plugins"));
        dropzone.append(
            mark,
            element("strong", "", t("Add plugins")),
            element("span", "", t(busy ? "Loading…" : "Drag and drop here, or click to browse.")),
            input,
        );
        const message = element("p", "extensions-notice", notice);
        message.setAttribute("role", "status");
        const list = element("div", "extensions-list");
        for (const item of state.items) {
            const row = element("div", "extension-row");
            const icon = element("span", "extension-icon");
            icon.innerHTML = PLUGINS_ICON;
            if (item.icon) {
                const image = element("img");
                image.alt = "";
                image.dataset.pluginIconLight = item.icon.light;
                image.dataset.pluginIconDark = item.icon.dark ?? item.icon.light;
                image.src =
                    getComputedStyle(host).colorScheme === "dark"
                        ? image.dataset.pluginIconDark
                        : item.icon.light;
                image.onerror = () => image.remove();
                icon.append(image);
            }
            const info = element("div", "extension-info");
            info.append(
                element("strong", "", item.name),
                element("span", "extension-version", item.version),
            );
            info.append(
                element(
                    "small",
                    "",
                    item.readonly
                        ? t("Provided by viewer")
                        : `${item.file} · ${Math.ceil(item.size / 1024)} KB · ${t(item.error ? "Invalid package" : !local ? "Browser storage" : item.enabled ? "Enabled" : "Disabled")}`,
                ),
            );
            if (item.error) info.append(element("small", "extensions-notice", item.error));
            const actions = element("div", "extension-actions");
            if (local && !item.readonly)
                actions.append(
                    button(
                        item.enabled ? "Disable" : "Enable",
                        () =>
                            void operate(() =>
                                changed({
                                    action: item.enabled ? "disable" : "enable",
                                    file: item.file,
                                    hash: item.hash,
                                }),
                            ),
                        !!item.error,
                    ),
                );
            if (!item.readonly) {
                actions.append(button("Edit", () => void edit(item.file), !!item.error));
                actions.append(
                    button(
                        "Delete",
                        () =>
                            void (async () => {
                                if (
                                    !(await confirmDialog(
                                        t("Delete plugin {name}?", { name: item.name }),
                                        t("Delete"),
                                        true,
                                    ))
                                )
                                    return;
                                await operate(async () => {
                                    await changed({
                                        action: "delete",
                                        file: item.file,
                                        hash: item.hash,
                                    });
                                    if (opened?.file === item.file) {
                                        opened = undefined;
                                        drafts.clear();
                                    }
                                });
                            })(),
                    ),
                );
            }
            row.append(icon, info, actions);
            if (pluginAccounts && item.enabled) {
                const logins = element("div", "extension-accounts");
                for (const plugin of item.plugins) {
                    const account = accounts.get(plugin);
                    const line = element("div", "extension-actions");
                    line.append(
                        element("span", "", `${plugin} · ${account?.name ?? t("Not signed in")}`),
                    );
                    line.append(
                        button(account ? "Sign out" : "Sign in", () => {
                            if (!account) login(plugin);
                            else
                                void operate(async () => {
                                    await pluginRequest({ action: "disconnect", plugin });
                                    await loadAccounts();
                                });
                        }),
                    );
                    logins.append(line);
                }
                row.append(logins);
            }
            list.append(row);
        }
        host.append(header);
        if (!local)
            host.append(
                element(
                    "p",
                    "extensions-description",
                    t(
                        connection
                            ? "Plugins are saved in this browser. Server plugin installation is not available for this workspace."
                            : "Plugins are saved in this browser. Run server plugins in a local dooc editor.",
                    ),
                ),
            );
        host.append(dropzone, message, list);
        if (loginUrl) {
            const link = element("a", "", t("Continue login"));
            link.href = loginUrl;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            host.append(link);
        }
        if (!opened) return;
        const editor = element("section", "extension-editor");
        const tools = element("div", "extensions-header");
        tools.append(element("strong", "", opened.file));
        const select = element("select");
        select.setAttribute("aria-label", t("Plugin file"));
        select.disabled = busy;
        for (const entry of opened.files) {
            const option = element("option", "", entry.name + (drafts.has(entry.name) ? " *" : ""));
            option.value = entry.name;
            option.selected = path === entry.name;
            select.append(option);
        }
        select.onchange = () => {
            path = select.value;
            render();
        };
        tools.append(select);
        const entry = opened.files.find((entry) => entry.name === path);
        if (!entry) return;
        editor.append(tools);
        try {
            const original = text(entry);
            const field = element("textarea");
            field.value = drafts.get(path) ?? original;
            field.spellcheck = false;
            field.disabled = busy;
            field.setAttribute("aria-label", path);
            const save = button("Apply changes", () => void apply(), !drafts.has(path));
            field.oninput = () => {
                if (field.value === original) drafts.delete(path);
                else drafts.set(path, field.value);
                save.disabled = busy || !drafts.has(path);
                const option = select.selectedOptions[0];
                if (option) option.textContent = path + (drafts.has(path) ? " *" : "");
            };
            editor.append(field, save);
        } catch {
            editor.append(element("p", "", t("Binary asset — replace it by importing a new ZIP.")));
        }
        host.append(editor);
    };
    const upload = async (files: File[]) => {
        await operate(async () => {
            const errors: string[] = [];
            state = (await request({ action: "list" })) as ExtensionList;
            for (const file of files) {
                try {
                    extensionFile(file.name);
                    if (file.size > MAX_EXTENSION_BYTES)
                        throw new Error(t("Choose a ZIP smaller than 16 MiB"));
                    const previous = state.items.find((item) => item.file === file.name);
                    if (
                        previous &&
                        !(await confirmDialog(
                            t("Replace plugin {name}?", { name: previous.name }),
                            t("Replace"),
                        ))
                    )
                        continue;
                    await changed({
                        action: "install",
                        file: file.name,
                        data: extensionBase64(new Uint8Array(await file.arrayBuffer())),
                        base: previous?.hash ?? null,
                    });
                    if (opened?.file === file.name) await read(file.name);
                } catch (error) {
                    errors.push(
                        `${file.name}: ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            }
            notice = errors.join("\n");
        });
    };
    input.onchange = () => {
        void upload([...(input.files ?? [])]);
        input.value = "";
    };
    const inExtensions = (target: EventTarget | null) =>
        workspaceId() === workspace &&
        target instanceof Element &&
        target.closest("#nav-extensions, #extensions-manager");
    document.addEventListener("dragover", (event) => {
        if (!event.dataTransfer?.types.includes("Files")) return;
        const inside = inExtensions(event.target);
        document.body.classList.toggle("extensions-over", !!inside && !busy);
        if (inside) {
            event.preventDefault();
            event.dataTransfer.dropEffect = busy ? "none" : "copy";
        }
    });
    const clearDrag = () => document.body.classList.remove("extensions-over");
    document.addEventListener("dragleave", (event) => {
        if (!inExtensions(event.relatedTarget)) clearDrag();
    });
    document.addEventListener("dragend", clearDrag);
    window.addEventListener("blur", clearDrag);
    document.addEventListener("drop", (event) => {
        clearDrag();
        if (!inExtensions(event.target) || !event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
        void upload([...event.dataTransfer.files]);
    });
    window.addEventListener("beforeunload", (event) => {
        if (drafts.size || busy) event.preventDefault();
    });
    document.addEventListener("docs:ui-language", render);
    const mount = () => {
        if (workspaceId() !== workspace) return;
        const next =
            document.querySelector<HTMLElement>(".preview-pane.active #extensions-manager") ??
            (!document.querySelector("#preview-panes")
                ? document.getElementById("extensions-manager")
                : null);
        if (next !== host) {
            host = next;
            render();
            if (host && !busy)
                void operate(async () => {
                    state = (await request({ action: "list" })) as ExtensionList;
                    await loadAccounts();
                });
        }
    };
    new MutationObserver(mount).observe(document.body, { childList: true, subtree: true });
    document.addEventListener("dooc:workspace-changed", mount);
    mount();
    window.addEventListener("focus", () => {
        if (workspaceId() === workspace && host?.isConnected && !busy) void operate(loadAccounts);
    });
    void operate(async () => {
        state = (await request({ action: "list" })) as ExtensionList;
        await loadAccounts();
    });
};
