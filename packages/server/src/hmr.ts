// HMR for the dev server (shared by preview / edit). Classifies and watches changes; serve.ts
// broadcasts them as workspace "change" events and hmr-client.ts applies them. By source:
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
import { dirname, join, resolve } from "node:path";
import { managedFile } from "../../engine/src/compiler/files.js";
import { textfilePath } from "../../engine/src/compiler/textfile.js";
import { isManifestFile } from "../../engine/src/core/content-metadata.js";
import { isRemoteTextfile } from "../../engine/src/core/textfile.js";
import { prebuilt } from "./assets.js";
import { gitHeadFile } from "./workspace.js";

/** Kind of change — content = main data, client = edit's client bundle (needs a reload). */
export type HmrKind = "content" | "client";

/**
 * Changed path (repo-root relative) → HMR kind. undefined for out-of-scope files
 * (dist output, temp files etc.).
 */
export const classifyChange = (rel: string): HmrKind | undefined => {
    const p = rel.replace(/\\/g, "/");
    // Browser-only sources are bundled per request, not imported by the server, so `tsx watch`
    // never restarts for them; classify them as "client" to trigger a reload. Everything else
    // under packages/ is server-side: the restart changes the boot id and the page reloads.
    if (
        /^packages\/frontend\/src\/.+\.(tsx?|json)$/.test(p) ||
        p === "packages/workspace/src/client.ts"
    ) {
        return "client";
    }
    // content = body text (.md) and dooc.yaml (= SoT for hierarchy and ordering).
    if (isManifestFile(p) || (p.startsWith("content/") && p.endsWith(".md"))) {
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
    const dirs: [string, string][] = [["packages", join(pkgRoot, "packages")]];
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
                isManifestFile(path) ||
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
            watchers.push(
                watch(parent, (_event, name) => {
                    if (String(name) === ".gitignore") note(".gitignore", "content");
                }),
            );
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
