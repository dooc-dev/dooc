// HMR for the dev server (shared by preview / edit). Funnels changes into a single SSE stream
// (`/api/hmr`), by source:
//   data side (content/*.md, dooc.yaml, figures/*) = picked up by this module's watcher;
//           preview swaps only the main body + nav (keeping scroll). edit likewise does a partial
//           update of just the body + nav (no reload; keeps CodeMirror cursor/scroll/undo and
//           unsaved content) — only on pages where edit-client.ts registered `onContent`
//           (unregistered, e.g. the new page, reloads).
//   client bundle side (src/viewer/edit-client.ts, src/core/*.tsx = bundle sources of the schema
//           graph interaction layer `/assets/graph.js`) = not imported by the server (esbuild
//           bundles them on demand), so tsx watch doesn't react → the data-side watcher picks
//           them up as "client" and triggers a reload.
//   server side (all other src/*.ts) = tsx watch restarts the whole process, so not watched.
//           The client notices the swap from the bootId difference in `hello` on reconnect and
//           reloads.
// All content events reach the editor, which compares disk contents with its saved base.
import { existsSync, readFileSync, realpathSync, unwatchFile, watch, watchFile } from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { managedFile } from "../compiler/files.js";
import { textfilePath } from "../compiler/textfile.js";
import { MANIFEST_FILE } from "../core/content-metadata.js";
import { isRemoteTextfile } from "../core/textfile.js";
import { prebuilt } from "./assets.js";
import type { ServeMode } from "./serve.js";
import { gitHeadFile } from "./workspace.js";

/** SSE endpoint. SoT for the server route and the client script's connection target. */
export const HMR_PATH = "/api/hmr";

/** Kind of change — content = main data, client = edit's client bundle (needs a reload). */
export type HmrKind = "content" | "client";

/**
 * Changed path (repo-root relative) → HMR kind. undefined for out-of-scope files
 * (dist output, temp files etc.).
 */
export const classifyChange = (rel: string): HmrKind | undefined => {
    const p = rel.replace(/\\/g, "/");
    // edit's client bundle itself (src/viewer/edit-client.ts) and src/core/*.tsx
    // (schema-graph-*.tsx = bundle sources of `/assets/graph.js`) aren't imported by the server
    // (esbuild bundles them per request), so tsx watch can't pick them up → explicitly classify
    // them as "client" here to trigger a reload. Other src/*.ts (the server itself) stay out of
    // scope (= tsx watch restart → the client picks it up from the bootId difference in hello).
    if (
        p === "src/viewer/edit-client.ts" ||
        p === "src/viewer/files-ui.ts" ||
        p === "src/viewer/resource-library-ui.ts" ||
        p === "src/viewer/edit-code-file.ts" ||
        p === "src/core/code-file.ts" ||
        p === "src/core/files.ts" ||
        p === "src/viewer/edit-schema-completion.ts" ||
        p === "src/viewer/edit-textfile.ts" ||
        p === "src/viewer/file-references.ts" ||
        p === "src/core/markdown.ts" ||
        p === "src/core/mermaid-mount.ts" ||
        p === "src/core/textfile.ts" ||
        p === "src/core/file-embed.ts" ||
        p === "src/core/term-reference.ts" ||
        p === "src/core/taxonomy.ts" ||
        p === "src/core/previewers.ts" ||
        p === "src/viewer/edit-file-preview.ts" ||
        p === "src/viewer/edit-conflict.ts" ||
        p === "src/viewer/edit-code-highlight.ts" ||
        p === "src/viewer/edit-git-diff.ts" ||
        p === "src/viewer/code-tokens.ts" ||
        p === "src/viewer/i18n.ts" ||
        p === "src/viewer/language-picker.ts" ||
        p === "src/viewer/theme-picker.ts" ||
        p === "src/viewer/ui-client.ts" ||
        p === "src/viewer/plugins-ui.ts" ||
        p === "src/viewer/plugin-view.ts" ||
        p === "src/viewer/plugin-resize.ts" ||
        p === "src/viewer/preview-update.ts" ||
        p === "src/plugins/view.ts" ||
        p === "src/viewer/nav-focus.ts" ||
        p === "src/viewer/code-highlight.ts" ||
        (p.startsWith("src/viewer/locales/") && p.endsWith(".json")) ||
        (p.startsWith("src/core/") && p.endsWith(".tsx"))
    ) {
        return "client";
    }
    // content = body text (.md) and dooc.yaml (= SoT for hierarchy and ordering).
    if (p === MANIFEST_FILE || (p.startsWith("content/") && p.endsWith(".md"))) {
        return "content";
    }
    if (p.startsWith("locales/") && p.endsWith(".md")) return "content";
    if (p.startsWith("figures/") && /\.(svg|html|png|webp|jpe?g)$/.test(p)) {
        return "content";
    }
    // icons/<id>.svg (doc icons) is data side too = partial update.
    if (p.startsWith("icons/") && p.endsWith(".svg")) {
        return "content";
    }
    return undefined;
};

/** One SSE frame (in the format the client's EventSource reads). */
export const sseFrame = (event: string, data: unknown): string =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * Notification hooks the client script puts on `window.__docsHmr` (contract with edit-client.ts).
 * setDirty = shares the unsaved state,
 * onContent = hook for applying content changes in place (registered by edit-client.ts; falls
 * back to a reload if unregistered).
 */
export interface HmrBridge {
    setDirty: (v: boolean) => void;
    onContent?: (files: string[]) => void;
    updatePreview?: (target: HTMLElement, source: HTMLElement) => void;
}

export interface HmrHub {
    /** GET /api/hmr — holds the connection and keeps pushing broadcasts to it. */
    handle: (res: ServerResponse) => void;
    broadcast: (kind: HmrKind, files: string[]) => void;
}

export const createHmrHub = (bootId: string): HmrHub => {
    const clients = new Set<ServerResponse>();
    // Ping periodically to clean up dead sockets, even on localhost without a proxy.
    const ping = setInterval(() => {
        for (const res of clients) {
            res.write(": ping\n\n");
        }
    }, 20_000);
    ping.unref();
    return {
        handle: (res) => {
            res.writeHead(200, {
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-cache, no-transform",
                connection: "keep-alive",
            });
            // Make clients reconnect quickly right after a restart (tsx watch); the default
            // reconnect interval is browser-dependent.
            res.write("retry: 300\n\n");
            res.write(sseFrame("hello", { bootId }));
            clients.add(res);
            res.on("close", () => clients.delete(res));
        },
        broadcast: (kind, files) => {
            const frame = sseFrame("change", { kind, files });
            for (const res of clients) {
                res.write(frame);
            }
        },
    };
};

/**
 * Folders to watch. The docs-side ones are relative to docsRoot, src to pkgRoot (only files that
 * classifyChange marks "client" count).
 */

/**
 * Notifies data-side changes batched by kind. An editor save fires multiple events
 * (rename + change), so debounce collapses them into one. Referenced text files can be added
 * as drafts are compiled; close() releases all watchers.
 */
export const watchProject = (
    docsRoot: string,
    pkgRoot: string,
    onChange: (kind: HmrKind, files: string[]) => void,
    debounceMs = 60,
): { close: () => void; watchTextfiles: (files: Iterable<string>) => void } => {
    const pending = new Map<string, HmrKind>();
    let timer: NodeJS.Timeout | undefined;
    const flush = (): void => {
        timer = undefined;
        const byKind = new Map<HmrKind, string[]>();
        for (const [file, kind] of pending) {
            byKind.set(kind, [...(byKind.get(kind) ?? []), file]);
        }
        pending.clear();
        for (const [kind, files] of byKind) {
            onChange(kind, files);
        }
    };
    const note = (rel: string, kind = classifyChange(rel)): void => {
        if (!kind) {
            return;
        }
        pending.set(rel, kind);
        if (!timer) {
            timer = setTimeout(flush, debounceMs);
            timer.unref();
        }
    };
    // Skip missing folders (checkouts / test fixtures without optional asset folders) to avoid ENOENT.
    const dirs: [string, string][] = [["src", join(pkgRoot, "src")]];
    const watchers = dirs
        .filter(([, abs]) => !prebuilt && existsSync(abs))
        .map(([dir, abs]) =>
            watch(abs, { recursive: true }, (_event, name) => {
                if (name) {
                    note(`${dir}/${String(name)}`);
                }
            }),
        );
    // Watch the directory so atomic replacements of the manifest are detected too.
    watchers.push(
        watch(docsRoot, { recursive: true }, (_event, name) => {
            if (!name) return;
            const path = String(name).replaceAll("\\", "/");
            if (
                path === MANIFEST_FILE ||
                path.startsWith("locales/") ||
                /(^|\/)\.gitignore$/.test(path)
            )
                note(path, "content");
            else if (managedFile(path) && !path.startsWith("src/") && !/\.(tmp|swp)$/.test(path))
                note(path, "content");
        }),
    );
    const textfiles = new Map<string, () => void>();
    const headFile = gitHeadFile(docsRoot);
    if (headFile) {
        for (let parent = realpathSync(docsRoot); !existsSync(join(parent, ".git")); ) {
            const next = dirname(parent);
            if (next === parent) break;
            parent = next;
            const ignore = join(parent, ".gitignore");
            const changed = () => note(".gitignore", "content");
            watchFile(ignore, { persistent: false, interval: 200 }, changed);
            textfiles.set(ignore, changed);
        }
        const directory = dirname(headFile);
        const common = join(directory, "commondir");
        const directories = new Set([
            directory,
            existsSync(common)
                ? resolve(directory, readFileSync(common, "utf8").trim())
                : directory,
        ]);
        for (const path of directories)
            watchers.push(
                watch(path, { recursive: true }, (_event, name) => {
                    const file = String(name).replaceAll("\\", "/");
                    if (file === "HEAD" || file === "packed-refs" || file.startsWith("refs/"))
                        note(".git/HEAD", "content");
                    else if (file === "index" || file === "info/exclude" || file === "config")
                        note(`.git/${file}`, "content");
                }),
            );
    }
    // shortcut: keep encountered file watches until shutdown; prune if sessions collect many removed references.
    const watchTextfiles = (files: Iterable<string>): void => {
        for (const file of files) {
            if (isRemoteTextfile(file)) continue;
            try {
                textfilePath(docsRoot, file);
            } catch {
                continue;
            }
            const path = resolve(docsRoot, file);
            if (textfiles.has(path)) continue;
            const changed = () => note(file.replace(/^(\.\/)+/, ""), "content");
            // Poll referenced paths so atomic saves, deletion and creation are all detected.
            watchFile(path, { persistent: false, interval: 200 }, changed);
            textfiles.set(path, changed);
        }
    };
    const close = (): void => {
        if (timer) {
            clearTimeout(timer);
            timer = undefined;
        }
        for (const w of watchers) {
            w.close();
        }
        for (const [path, listener] of textfiles) unwatchFile(path, listener);
    };
    return { close, watchTextfiles };
};

/**
 * Client script injected into page(). How changes are applied depends on mode:
 *   preview = swap the main <main> + nav (keeping scroll / sidebar state).
 *   edit    = delegate content changes to `window.__docsHmr.onContent` (registered by
 *             edit-client.ts) without reloading (pages without it, e.g. the new page, reload).
 *             Changes to the client bundle (`src/viewer/edit-client.ts` / `src/core/*.tsx`) and
 *             a bootId difference in `hello` (= the server itself restarted) reload. While there
 *             are unsaved (dirty) changes, the reload is downgraded to a badge and waits.
 */
export const hmrClientScript = (mode: ServeMode): string => `
(() => {
  const MODE = ${JSON.stringify(mode)};
  let bootId = null;
  let isDirty = false;
  let pendingReload = false;

  let badge = null;
  const showBadge = () => {
    pendingReload = true;
    if (badge) return;
    badge = document.createElement("button");
    badge.type = "button";
    badge.textContent = "Updated externally — click to reload";
    badge.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:9999;font:inherit;font-size:12px;padding:6px 10px;border-radius:6px;cursor:pointer;border:1px solid var(--doc-border-2,#c4ccd8);background:var(--doc-panel,#fff);color:var(--doc-fg-2,#2a3140);box-shadow:0 2px 8px rgba(0,0,0,.18)";
    badge.addEventListener("click", () => location.reload());
    document.body.appendChild(badge);
  };

  // Never silently discard unsaved changes (downgrade to a badge and wait).
  const reload = () => { if (isDirty) { showBadge(); return; } location.reload(); };

  // preview partial swap — refetch the same URL and replace only the contents of <main> and nav.
  const swap = async () => {
    let next;
    try {
      const res = await fetch(location.href, { headers: { "cache-control": "no-cache" } });
      if (!res.ok) { reload(); return; }
      next = new DOMParser().parseFromString(await res.text(), "text/html");
    } catch { return; } // e.g. server restarting — picked up by the next hello
    const main = document.querySelector("main");
    const nextMain = next.querySelector("main");
    if (!main || !nextMain) { reload(); return; }
    const y = window.scrollY;
    document.title = next.title;
    const title = document.getElementById("site-title");
    const nextTitle = next.getElementById("site-title");
    if (title && nextTitle) {
      title.textContent = nextTitle.textContent;
      title.title = nextTitle.title;
    }
    const logo = document.getElementById("site-icon");
    const nextLogo = next.getElementById("site-icon");
    if (logo && nextLogo) logo.replaceWith(nextLogo);
    const updatePreview = window.__docsHmr && window.__docsHmr.updatePreview;
    if (updatePreview) updatePreview(main, nextMain);
    else main.innerHTML = nextMain.innerHTML;
    const nav = document.getElementById("nav-groups");
    const nextNav = next.getElementById("nav-groups");
    if (nav && nextNav) {
      nav.innerHTML = nextNav.innerHTML;
      if (window.__docsNavRestore) window.__docsNavRestore();
    }
    window.scrollTo(0, y);
  };

  // Notification hooks for the edit client (src/viewer/edit-client.ts). edit-client.ts may run
  // first (bootScripts sit near the top of body, this script at the end of body), so merge
  // instead of clobbering what's already there (an earlier onContent registration).
  window.__docsHmr = Object.assign(window.__docsHmr || {}, {
    setDirty: (v) => {
      isDirty = Boolean(v);
      if (!isDirty && pendingReload) location.reload();
    },
  });

  const es = new EventSource(${JSON.stringify(HMR_PATH)});
  es.addEventListener("hello", (ev) => {
    const id = JSON.parse(ev.data).bootId;
    if (bootId === null) { bootId = id; return; }
    // bootId changed = the server itself (src/*.ts) was replaced and restarted.
    if (id !== bootId) reload();
  });
  es.addEventListener("change", (ev) => {
    const { kind, files } = JSON.parse(ev.data);
    if (MODE === "preview") { if (kind === "content") void swap(); return; }
    if (kind === "content") {
      const onContent = window.__docsHmr && window.__docsHmr.onContent;
      // If registered, leave it to the in-place update and don't reload (the editor swaps
      // body/nav itself). Unregistered (pages without an editor, e.g. the empty 0-doc page)
      // → reload.
      if (onContent) { onContent(files); return; }
      reload();
      return;
    }
    // Client bundle (src/viewer/edit-client.ts / src/core/*.tsx) changed — reload to refetch it.
    reload();
  });
})();`;
