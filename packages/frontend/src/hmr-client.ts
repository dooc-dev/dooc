import { workspaceFetch, workspaceId } from "../../workspace/src/connection.js";
// Browser side of hot reload: applies the workspace's "change" events to the open page.
//   preview + content = refetch this URL and swap <main> and the nav (scroll kept);
//   edit + content    = hand the files to the editor (`onContent`), which updates in place and
//                       keeps the cursor, undo history and unsaved text; pages without an editor
//                       reload;
//   client            = the bundle changed, reload;
//   a new boot id on reconnect = the server process was replaced, reload.
// A reload never discards unsaved text: while the editor is dirty it becomes a badge.

import type { HmrBridge, HmrKind } from "../../server/src/hmr.js";
import { pageWorkspace } from "../../workspace/src/client.js";
import type { WorkspaceHello } from "../../workspace/src/protocol.js";
import { updateNav } from "./nav-update.js";

/** Keep the reader chrome, open branches and event handlers when only the page changes. */
export const updateReaderPage = (next: Document): boolean => {
    const main = document.querySelector("main");
    const nextMain = next.querySelector("main");
    if (!main || !nextMain) return false;
    const owner = window as unknown as {
        __docsHmr?: Partial<HmrBridge>;
        __docsNavRestore?: () => void;
    };
    document.title = next.title;
    for (const icon of document.head.querySelectorAll("link[data-document-icon]")) icon.remove();
    document.head.append(...next.head.querySelectorAll("link[data-document-icon]"));
    const title = document.getElementById("site-title");
    const nextTitle = next.getElementById("site-title");
    if (title && nextTitle) {
        title.textContent = nextTitle.textContent;
        title.title = nextTitle.title;
        for (const name of ["href", "class", "aria-current", "data-jump-url"]) {
            const value = nextTitle.getAttribute(name);
            if (value === null) title.removeAttribute(name);
            else title.setAttribute(name, value);
        }
    }
    const nextLogo = next.getElementById("site-icon-slot");
    if (nextLogo) document.getElementById("site-icon-slot")?.replaceWith(nextLogo);
    const updatePreview = owner.__docsHmr?.updatePreview;
    if (updatePreview) updatePreview(main, nextMain);
    else main.innerHTML = nextMain.innerHTML;
    const nav = document.getElementById("nav-groups");
    const nextNav = next.getElementById("nav-groups");
    if (nav && nextNav) {
        updateNav(nav, nextNav.innerHTML);
        owner.__docsNavRestore?.();
    }
    for (const name of ["documentManifest", "documentPath", "contentLanguage"])
        document.body.dataset[name] = next.body.dataset[name] ?? "";
    document.dispatchEvent(new Event("dooc:document-changed"));
    document.dispatchEvent(new Event("docs:page-shown"));
    return true;
};

export const mountHmr = (mode: "preview" | "edit"): void => {
    let dirty = false;
    let pendingReload = false;
    let badge: HTMLButtonElement | undefined;
    const reload = (): void => {
        if (!dirty) {
            location.reload();
            return;
        }
        pendingReload = true;
        if (badge) return;
        badge = document.createElement("button");
        badge.type = "button";
        badge.textContent = "Updated externally — click to reload";
        badge.style.cssText =
            "position:fixed;right:14px;bottom:14px;z-index:9999;font:inherit;font-size:12px;padding:6px 10px;border-radius:6px;cursor:pointer;border:1px solid var(--doc-border-2,#c4ccd8);background:var(--doc-panel,#fff);color:var(--doc-fg-2,#2a3140);box-shadow:0 2px 8px rgba(0,0,0,.18)";
        badge.addEventListener("click", () => location.reload());
        document.body.appendChild(badge);
    };
    const owner = window as unknown as {
        __docsHmr?: Partial<HmrBridge>;
        __docsNavRestore?: () => void;
    };
    // The page's own bundle may have registered onContent / updatePreview already; merge.
    owner.__docsHmr = Object.assign(owner.__docsHmr ?? {}, {
        setDirty: (value: boolean) => {
            dirty = Boolean(value);
            if (!dirty && pendingReload) location.reload();
        },
    });

    let revision = 0;
    const swap = async (): Promise<void> => {
        const request = ++revision;
        const requestedWorkspace = workspaceId();
        const requestedUrl = location.href;
        let next: Document;
        try {
            const response = await workspaceFetch(
                requestedUrl,
                {
                    headers: { "cache-control": "no-cache" },
                },
                requestedWorkspace,
            );
            if (
                request !== revision ||
                workspaceId() !== requestedWorkspace ||
                location.href !== requestedUrl
            )
                return;
            if (!response.ok) {
                reload();
                return;
            }
            next = new DOMParser().parseFromString(await response.text(), "text/html");
        } catch {
            // The server is restarting; the boot id on reconnect takes over.
            return;
        }
        if (
            request !== revision ||
            workspaceId() !== requestedWorkspace ||
            location.href !== requestedUrl
        )
            return;
        const main = document.querySelector("main");
        if (main?.getAttribute("aria-busy") === "true") return;
        const y = main?.scrollTop ?? 0;
        if (!updateReaderPage(next)) {
            reload();
            return;
        }
        main?.scrollTo(0, y);
    };

    const observed = new Set<string>();
    document.addEventListener("dooc:document-changed", () => {
        revision++;
    });
    const observe = () => {
        const id = workspaceId();
        if (observed.has(id)) return;
        observed.add(id);
        const workspace = pageWorkspace(id);
        let boot: string | undefined;
        workspace.opened(() => {
            void workspace.request<WorkspaceHello>("hello").then(
                (hello) => {
                    if (workspaceId() === id && boot !== undefined && hello.boot !== boot) reload();
                    boot = hello.boot;
                },
                // Dropped again before answering; the next open asks again.
                () => {},
            );
        });
        workspace.on("change", (data) => {
            if (workspaceId() !== id) return;
            const { kind, files } = data as { kind: HmrKind; files: string[] };
            if (kind === "content")
                document.dispatchEvent(
                    new CustomEvent("dooc:content-changed", { detail: { workspace: id, files } }),
                );
            if (kind !== "content") reload();
            else if (mode === "preview") void swap();
            else if (owner.__docsHmr?.onContent) owner.__docsHmr.onContent(files);
            else reload();
        });
    };
    document.addEventListener("dooc:workspace-changed", observe);
    observe();
};
