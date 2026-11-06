import type { FileLayout } from "../core/files.js";
import { showDialog, showNotice } from "./edit-dialog.js";
import { t } from "./i18n.js";

type Snapshot = {
    files: { path: string; size: number; extension: string }[];
    layout: FileLayout;
    revision: string;
    documents: Record<string, string>;
};
type Row = { path: string; folder: boolean; depth: number };
const parent = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const icon = (path: string) =>
    `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="${path}"/></svg>`;
const folderIcon = icon("M2 5h6l2 2h8v10H2z");
const fileIcon = icon("M4 2h8l4 4v12H4zM12 2v5h4");

export const mountFiles = () => {
    const host = document.getElementById("files-manager");
    if (!host || host.dataset.mounted) return;
    host.dataset.mounted = "true";
    let snapshot: Snapshot | undefined;
    let selected = new Set<string>();
    const closed = new Set<string>();
    let rows: Row[] = [];
    let anchor: string | undefined;
    let busy = false;
    let dragging = false;
    let refreshPending = false;
    let drop: { directory: string; before?: string } | undefined;
    const toolbar = document.createElement("div");
    toolbar.className = "files-toolbar";
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = t("Search files");
    search.setAttribute("aria-label", t("Search files"));
    const extension = document.createElement("input");
    extension.type = "search";
    extension.setAttribute("list", "file-extensions");
    extension.placeholder = t("Extension");
    extension.setAttribute("aria-label", t("Extension"));
    extension.className = "files-extension";
    const extensions = document.createElement("datalist");
    extensions.id = "file-extensions";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = t("Default folder layout");
    toggle.setAttribute("aria-pressed", "false");
    toggle.title = t("Place new files in files/<extension>/");
    const makeButton = (label: string, svg?: string) => {
        const b = document.createElement("button");
        b.type = "button";
        b.title = t(label);
        b.setAttribute("aria-label", t(label));
        if (svg) b.innerHTML = svg;
        else b.textContent = t(label);
        return b;
    };
    const restructure = makeButton("Folder restructure");
    const move = makeButton("Move");
    const up = makeButton("Move up");
    const down = makeButton("Move down");
    const refresh = makeButton("Reload");
    toolbar.append(search, extension, extensions, toggle, restructure, move, up, down, refresh);
    const table = document.createElement("table");
    table.className = "files-table";
    table.setAttribute("aria-label", t("Files"));
    table.tabIndex = 0;
    const head = document.createElement("thead");
    head.innerHTML = `<tr><th scope="col"></th><th scope="col">${t("Name")}</th><th scope="col">${t("Size")}</th><th scope="col"></th></tr>`;
    const body = document.createElement("tbody");
    table.append(head, body);
    const viewport = document.createElement("div");
    viewport.className = "files-viewport";
    viewport.append(table);
    const root = document.createElement("button");
    root.type = "button";
    root.className = "files-root";
    root.textContent = "/";
    root.title = t("Move to root");
    host.append(toolbar, root, viewport);
    const request = async (input: Record<string, unknown>) => {
        const response = await fetch("/api/files", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        return data as Snapshot;
    };
    const pickedRows = () =>
        rows.filter(
            (row) =>
                selected.has(row.path) &&
                ![...selected].some((path) => row.path.startsWith(`${path}/`)),
        );
    const state = () => {
        for (const button of [toggle, restructure, move, up, down, refresh])
            button.disabled = busy || (!snapshot && button !== refresh);
        for (const button of [move, up, down]) button.disabled ||= selected.size === 0;
        root.disabled = busy || !selected.size;
        const picked = pickedRows();
        for (const button of [up, down])
            button.disabled ||=
                !picked.length ||
                picked.some((row) => parent(row.path) !== parent(picked[0]?.path ?? ""));
        toggle.setAttribute("aria-pressed", String(snapshot?.layout.defaultLayout ?? true));
    };
    const perform = async (button: HTMLButtonElement, input: Record<string, unknown>) => {
        if (busy) return;
        busy = true;
        button.dataset.state = "loading";
        button.setAttribute("aria-busy", "true");
        state();
        try {
            snapshot = await request({ ...input, revision: snapshot?.revision });
            selected.clear();
            render();
        } catch (error) {
            button.dataset.state = "error";
            button.title = error instanceof Error ? error.message : String(error);
            await showNotice(button.title);
        } finally {
            busy = false;
            button.removeAttribute("aria-busy");
            if (button.dataset.state === "loading") delete button.dataset.state;
            state();
            if (refreshPending && !dragging) refreshFiles();
        }
    };
    const refreshFiles = () => {
        if (!host.isConnected || !host.contains(refresh)) return;
        if (busy || dragging) {
            refreshPending = true;
            return;
        }
        refreshPending = false;
        void perform(refresh, { action: "read" });
    };
    const select = (
        path: string,
        event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
        toggleOnly = false,
    ) => {
        if (event.shiftKey && anchor) {
            const a = rows.findIndex((r) => r.path === anchor);
            const b = rows.findIndex((r) => r.path === path);
            if (a >= 0) {
                if (!event.ctrlKey && !event.metaKey) selected.clear();
                for (const row of rows.slice(Math.min(a, b), Math.max(a, b) + 1))
                    selected.add(row.path);
            }
        } else {
            if (event.ctrlKey || event.metaKey || toggleOnly) {
                if (selected.has(path)) selected.delete(path);
                else selected.add(path);
            } else selected = new Set([path]);
            anchor = path;
        }
        for (const tr of body.querySelectorAll<HTMLTableRowElement>("tr[data-path]")) {
            const yes = selected.has(tr.dataset.path ?? "");
            tr.classList.toggle("selected", yes);
            const box = tr.querySelector<HTMLInputElement>("input[type=checkbox]");
            if (box) box.checked = yes;
            tr.setAttribute("aria-selected", String(yes));
        }
        state();
    };
    const render = () => {
        if (!snapshot) return;
        const query = search.value.trim().toLowerCase();
        const ext = extension.value.trim().replace(/^\./, "").toLowerCase();
        const files = snapshot.files.filter(
            (file) =>
                (!query || file.path.toLowerCase().includes(query)) &&
                (!ext || file.extension === ext),
        );
        const children = new Map<string, string[]>();
        const folders = new Set<string>();
        for (const file of files) {
            const parts = file.path.split("/");
            for (let i = 0; i < parts.length; i++) {
                const path = parts.slice(0, i + 1).join("/");
                const dir = parent(path);
                const list = children.get(dir) ?? [];
                if (!list.includes(path)) list.push(path);
                children.set(dir, list);
                if (i < parts.length - 1) folders.add(path);
            }
        }
        rows = [];
        const walk = (dir: string, depth: number) => {
            for (const path of children.get(dir) ?? []) {
                const folder = folders.has(path);
                rows.push({ path, folder, depth });
                if (folder && (!closed.has(path) || query || ext)) walk(path, depth + 1);
            }
        };
        walk("", 0);
        body.replaceChildren();
        const sizes = new Map(snapshot.files.map((f) => [f.path, f.size]));
        for (const row of rows) {
            const tr = document.createElement("tr");
            tr.dataset.path = row.path;
            tr.draggable = true;
            tr.setAttribute("aria-selected", String(selected.has(row.path)));
            tr.classList.toggle("selected", selected.has(row.path));
            const checkCell = document.createElement("td");
            const check = document.createElement("input");
            check.type = "checkbox";
            check.checked = selected.has(row.path);
            check.setAttribute("aria-label", `${t("Select")} ${row.path}`);
            check.addEventListener("click", (e) => {
                e.stopPropagation();
                select(row.path, e, true);
            });
            checkCell.append(check);
            const name = document.createElement("td");
            const label = document.createElement("div");
            label.className = "files-name";
            label.style.paddingInlineStart = `${row.depth * 20}px`;
            const symbol = document.createElement("span");
            symbol.innerHTML = row.folder ? folderIcon : fileIcon;
            if (row.folder) {
                const button = makeButton(row.path);
                button.className = "files-folder";
                button.setAttribute(
                    "aria-expanded",
                    String(!closed.has(row.path) || !!query || !!ext),
                );
                button.replaceChildren(
                    symbol,
                    document.createTextNode(row.path.split("/").pop() ?? ""),
                );
                button.onclick = (e) => {
                    e.stopPropagation();
                    if (closed.has(row.path)) closed.delete(row.path);
                    else closed.add(row.path);
                    render();
                };
                label.append(button);
            } else {
                const link = document.createElement("a");
                const id = snapshot.documents[row.path];
                link.href = id ? `/${id}` : `/_files/file/${encodeURIComponent(row.path)}`;
                link.append(symbol, document.createTextNode(row.path.split("/").pop() ?? ""));
                link.title = row.path;
                link.onclick = (e) => {
                    if (e.shiftKey) {
                        e.preventDefault();
                        select(row.path, e);
                    }
                };
                label.append(link);
            }
            name.append(label);
            const size = document.createElement("td");
            const bytes = sizes.get(row.path);
            size.textContent =
                bytes === undefined
                    ? ""
                    : bytes < 1024
                      ? `${bytes} B`
                      : `${(bytes / 1024).toFixed(1)} KB`;
            const copyCell = document.createElement("td");
            const copy = makeButton("Copy path", icon("M7 6V2h10v12h-4M3 6h10v12H3z"));
            copy.onclick = async (e) => {
                e.stopPropagation();
                copy.dataset.state = "loading";
                try {
                    await navigator.clipboard.writeText(row.path);
                    copy.dataset.state = "done";
                    copy.title = t("Copied");
                } catch {
                    copy.dataset.state = "error";
                    copy.title = t("Copy failed");
                }
            };
            copyCell.append(copy);
            tr.append(checkCell, name, size, copyCell);
            tr.onclick = (e) => select(row.path, e);
            tr.ondragstart = (e) => {
                if (busy) {
                    e.preventDefault();
                    return;
                }
                if (!selected.has(row.path)) select(row.path, e);
                dragging = true;
                e.dataTransfer?.setData("application/x-dooc-files", JSON.stringify([...selected]));
                if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
            };
            tr.ondragover = (e) => {
                if (!dragging || busy) return;
                e.preventDefault();
                for (const node of body.querySelectorAll<HTMLElement>("[data-drop]"))
                    delete node.dataset.drop;
                const rect = tr.getBoundingClientRect();
                const fraction = (e.clientY - rect.top) / rect.height;
                const into = row.folder && fraction > 0.25 && fraction < 0.75;
                const after = fraction >= 0.5 && !into;
                tr.dataset.drop = into ? "into" : after ? "after" : "before";
                const siblings = rows.filter(
                    (r) => parent(r.path) === parent(row.path) && !selected.has(r.path),
                );
                const next = siblings[siblings.findIndex((r) => r.path === row.path) + 1];
                drop = into
                    ? { directory: row.path }
                    : { directory: parent(row.path), before: after ? next?.path : row.path };
            };
            tr.ondrop = (e) => {
                if (!dragging || !drop) return;
                e.preventDefault();
                if (!selected.has(row.path))
                    void perform(move, { action: "move", paths: [...selected], ...drop });
            };
            tr.ondragend = () => {
                dragging = false;
                drop = undefined;
                for (const node of body.querySelectorAll<HTMLElement>("[data-drop]"))
                    delete node.dataset.drop;
                if (refreshPending) refreshFiles();
            };
            body.append(tr);
        }
        if (!rows.length) {
            const tr = document.createElement("tr");
            const td = document.createElement("td");
            td.colSpan = 4;
            td.className = "files-placeholder";
            td.innerHTML = folderIcon;
            tr.append(td);
            body.append(tr);
        }
        extensions.replaceChildren(
            ...[...new Set(snapshot.files.map((f) => f.extension))].sort().map((ext) => {
                const option = document.createElement("option");
                option.value = `.${ext}`;
                return option;
            }),
        );
        state();
    };
    search.oninput = render;
    extension.oninput = render;
    toggle.onclick = () =>
        void perform(toggle, { action: "layout", enabled: !snapshot?.layout.defaultLayout });
    restructure.onclick = () => void perform(restructure, { action: "restructure" });
    refresh.onclick = () => void perform(refresh, { action: "read" });
    move.onclick = async () => {
        const field = document.createElement("textarea");
        field.rows = 2;
        field.value = parent([...selected][0] ?? "");
        field.placeholder = "/";
        field.setAttribute("aria-label", t("Folder"));
        if (
            await showDialog(t("Move"), field, [
                { value: "", label: t("Cancel") },
                { value: "move", label: t("Move") },
            ])
        )
            void perform(move, {
                action: "move",
                paths: [...selected],
                directory: field.value.trim().replace(/^\/$/, ""),
            });
    };
    const reorder = (direction: number, button: HTMLButtonElement) => {
        const picked = pickedRows();
        if (!picked.length) return;
        const dir = parent(picked[0]?.path ?? "");
        if (picked.some((r) => parent(r.path) !== dir)) return;
        const siblings = rows.filter((r) => parent(r.path) === dir);
        const edge = direction < 0 ? picked[0] : picked[picked.length - 1];
        const index = siblings.findIndex((r) => r.path === edge?.path);
        const adjacent = siblings[index + direction];
        if (!adjacent) return;
        void perform(button, {
            action: "move",
            paths: picked.map((r) => r.path),
            directory: dir,
            before: direction < 0 ? adjacent.path : siblings[index + 2]?.path,
        });
    };
    up.onclick = () => reorder(-1, up);
    down.onclick = () => reorder(1, down);
    table.onkeydown = (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "a") {
            e.preventDefault();
            selected = new Set(rows.map((r) => r.path));
            render();
        }
        if (e.key === "Escape") {
            selected.clear();
            render();
        }
        if (e.altKey && ["ArrowUp", "ArrowDown"].includes(e.key)) {
            e.preventDefault();
            reorder(e.key === "ArrowUp" ? -1 : 1, e.key === "ArrowUp" ? up : down);
        }
    };
    root.onclick = () =>
        void perform(root, { action: "move", paths: [...selected], directory: "" });
    root.ondragover = (e) => {
        if (dragging) e.preventDefault();
    };
    root.ondrop = (e) => {
        if (!dragging) return;
        e.preventDefault();
        void perform(move, { action: "move", paths: [...selected], directory: "" });
    };
    document.addEventListener(
        "docs:ui-language",
        () => {
            document.removeEventListener("docs:files-changed", refreshFiles);
            delete host.dataset.mounted;
            host.replaceChildren();
            mountFiles();
        },
        { once: true },
    );
    void perform(refresh, { action: "read" });
    document.addEventListener("docs:files-changed", refreshFiles);
};
