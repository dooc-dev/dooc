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

    const swap = async (): Promise<void> => {
        const requestedWorkspace = workspaceId();
        let next: Document;
        try {
            const response = await workspaceFetch(
                location.href,
                {
                    headers: { "cache-control": "no-cache" },
                },
                requestedWorkspace,
            );
            if (workspaceId() !== requestedWorkspace) return;
            if (!response.ok) {
                reload();
                return;
            }
            next = new DOMParser().parseFromString(await response.text(), "text/html");
        } catch {
            // The server is restarting; the boot id on reconnect takes over.
            return;
        }
        if (workspaceId() !== requestedWorkspace) return;
        const main = document.querySelector("main");
        const nextMain = next.querySelector("main");
        if (!main || !nextMain) {
            reload();
            return;
        }
        const y = main.scrollTop;
        document.title = next.title;
        const title = document.getElementById("site-title");
        const nextTitle = next.getElementById("site-title");
        if (title && nextTitle) {
            title.textContent = nextTitle.textContent;
            title.title = nextTitle.title;
        }
        const nextLogo = next.getElementById("site-icon");
        if (nextLogo) document.getElementById("site-icon")?.replaceWith(nextLogo);
        const updatePreview = owner.__docsHmr?.updatePreview;
        if (updatePreview) updatePreview(main, nextMain);
        else main.innerHTML = nextMain.innerHTML;
        const nav = document.getElementById("nav-groups");
        const nextNav = next.getElementById("nav-groups");
        if (nav && nextNav) {
            updateNav(nav, nextNav.innerHTML);
            owner.__docsNavRestore?.();
        }
        main.scrollTo(0, y);
    };

    const observed = new Set<string>();
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
            if (kind !== "content") reload();
            else if (mode === "preview") void swap();
            else if (owner.__docsHmr?.onContent) owner.__docsHmr.onContent(files);
            else reload();
        });
    };
    document.addEventListener("dooc:workspace-changed", observe);
    observe();
};
