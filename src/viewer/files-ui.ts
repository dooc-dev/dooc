import { showNotice } from "./edit-dialog.js";
import { t } from "./i18n.js";

type Snapshot = {
    files: { path: string; size: number; extension: string }[];
    revision: string;
    documents: Record<string, string>;
};
type Row = { path: string; folder: boolean; depth: number };
const parent = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const icon = (path: string) =>
    `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="${path}"/></svg>`;
const folderIcon = icon("M2 5h6l2 2h8v10H2z");
const fileIcon = icon("M4 2h8l4 4v12H4zM12 2v5h4");

export const mountFiles = (openFile?: (file: string) => void): (() => void) | undefined => {
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
    const suggestions = document.createElement("datalist");
    suggestions.id = "file-search-suggestions";
    search.setAttribute("list", suggestions.id);
    const makeButton = (label: string, svg?: string) => {
        const b = document.createElement("button");
        b.type = "button";
        b.title = t(label);
        b.setAttribute("aria-label", t(label));
        if (svg) b.innerHTML = svg;
        else b.textContent = t(label);
        return b;
    };
    const refresh = makeButton("Reload", icon("M17 8a7 7 0 1 0 0 5M17 3v5h-5"));
    const name = document.createElement("span");
    name.textContent = t("Name");
    const searchLabel = document.createElement("label");
    searchLabel.className = "resource-search";
    searchLabel.innerHTML = icon("M14 14l4 4M15 9a6 6 0 1 1-12 0 6 6 0 0 1 12 0");
    searchLabel.append(search);
    toolbar.append(name, searchLabel, suggestions, refresh);
    const table = document.createElement("table");
    table.className = "files-table";
    table.setAttribute("aria-label", t("Files"));
    table.tabIndex = 0;
    const head = document.createElement("thead");
    head.innerHTML = `<tr><th scope="col"></th><th scope="col">${t("Size")}</th><th scope="col"></th></tr>`;
    head.querySelector("th")?.append(toolbar);
    const body = document.createElement("tbody");
    table.append(head, body);
    const viewport = document.createElement("div");
    viewport.className = "files-viewport";
    viewport.append(table);
    host.append(viewport);
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
        refresh.disabled = busy;
    };
    const perform = async (input: Record<string, unknown>) => {
        if (busy) return;
        busy = true;
        refresh.dataset.state = "loading";
        refresh.setAttribute("aria-busy", "true");
        state();
        try {
            snapshot = await request({ ...input, revision: snapshot?.revision });
            selected.clear();
            render();
        } catch (error) {
            refresh.dataset.state = "error";
            refresh.title = error instanceof Error ? error.message : String(error);
            await showNotice(refresh.title);
        } finally {
            busy = false;
            refresh.removeAttribute("aria-busy");
            if (refresh.dataset.state === "loading") delete refresh.dataset.state;
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
        void perform({ action: "read" });
    };
    const select = (
        path: string,
        event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
    ) => {
        const a = rows.findIndex((r) => r.path === anchor);
        const b = rows.findIndex((r) => r.path === path);
        if (event.shiftKey && a >= 0 && b >= 0) {
            if (!event.ctrlKey && !event.metaKey) selected.clear();
            for (const row of rows.slice(Math.min(a, b), Math.max(a, b) + 1))
                selected.add(row.path);
        } else {
            if (event.ctrlKey || event.metaKey) {
                if (selected.has(path)) selected.delete(path);
                else selected.add(path);
            } else selected = new Set([path]);
            anchor = path;
        }
        for (const tr of body.querySelectorAll<HTMLTableRowElement>("tr[data-path]")) {
            const yes = selected.has(tr.dataset.path ?? "");
            tr.classList.toggle("selected", yes);
            tr.setAttribute("aria-selected", String(yes));
        }
        state();
    };
    const render = () => {
        if (!snapshot) return;
        const query = search.value.trim().toLowerCase();
        const dot = search.value.lastIndexOf(".");
        suggestions.replaceChildren(
            ...(dot < 0
                ? []
                : [
                      ...new Set(
                          snapshot.files
                              .filter((file) =>
                                  file.path.toLowerCase().endsWith(`.${file.extension}`),
                              )
                              .map((file) => file.extension),
                      ),
                  ]
                      .filter(Boolean)
                      .sort()
                      .map((extension) => {
                          const option = document.createElement("option");
                          option.value = search.value.slice(0, dot + 1) + extension;
                          return option;
                      })),
        );
        const files = snapshot.files.filter((file) => file.path.toLowerCase().includes(query));
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
                if (folder && (!closed.has(path) || query)) walk(path, depth + 1);
            }
        };
        walk("", 0);
        body.replaceChildren();
        const sizes = new Map(snapshot.files.map((f) => [f.path, f.size]));
        for (const file of snapshot.files)
            for (let dir = parent(file.path); dir; dir = parent(dir))
                sizes.set(dir, (sizes.get(dir) ?? 0) + file.size);
        for (const row of rows) {
            const tr = document.createElement("tr");
            tr.dataset.path = row.path;
            tr.draggable = true;
            tr.setAttribute("aria-selected", String(selected.has(row.path)));
            tr.classList.toggle("selected", selected.has(row.path));
            const name = document.createElement("td");
            const label = document.createElement("div");
            label.className = "files-name";
            label.style.paddingInlineStart = `${row.depth * 16}px`;
            const symbol = document.createElement("span");
            symbol.innerHTML = row.folder ? folderIcon : fileIcon;
            const filename = document.createElement("span");
            filename.className = "files-basename";
            filename.textContent = row.path.split("/").pop() ?? "";
            if (row.folder) {
                const button = makeButton(row.path);
                button.className = "files-folder";
                button.setAttribute("aria-expanded", String(!closed.has(row.path) || !!query));
                button.replaceChildren(symbol, filename);
                button.onclick = (e) => {
                    e.stopPropagation();
                    if (e.ctrlKey || e.metaKey || e.shiftKey) {
                        select(row.path, e);
                        return;
                    }
                    if (closed.has(row.path)) closed.delete(row.path);
                    else closed.add(row.path);
                    render();
                };
                label.append(button);
            } else {
                const link = document.createElement("a");
                link.href =
                    snapshot.documents[row.path] ?? `/_files/file/${encodeURIComponent(row.path)}`;
                link.append(symbol, filename);
                link.title = row.path;
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
                      : bytes < 1024 ** 2
                        ? `${(bytes / 1024).toFixed(1)} KB`
                        : bytes < 1024 ** 3
                          ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
                          : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
            const copyCell = document.createElement("td");
            const copy = makeButton("Copy path", icon("M7 6V2h10v12h-4M3 6h10v12H3z"));
            copy.className = "files-copy";
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
            tr.append(name, size, copyCell);
            tr.onclick = (e) => {
                select(row.path, e);
                if (e.ctrlKey || e.metaKey || e.shiftKey) {
                    e.preventDefault();
                } else if (!row.folder && openFile) {
                    e.preventDefault();
                    openFile(row.path);
                }
            };
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
                    void perform({ action: "move", paths: [...selected], ...drop });
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
            td.colSpan = 3;
            td.className = "files-placeholder";
            td.innerHTML = folderIcon;
            tr.append(td);
            body.append(tr);
        }
        state();
    };
    search.oninput = render;
    refresh.onclick = () => void perform({ action: "read" });
    const reorder = (direction: number) => {
        const picked = pickedRows();
        if (!picked.length) return;
        const dir = parent(picked[0]?.path ?? "");
        if (picked.some((r) => parent(r.path) !== dir)) return;
        const siblings = rows.filter((r) => parent(r.path) === dir);
        const edge = direction < 0 ? picked[0] : picked[picked.length - 1];
        const index = siblings.findIndex((r) => r.path === edge?.path);
        const adjacent = siblings[index + direction];
        if (!adjacent) return;
        void perform({
            action: "move",
            paths: picked.map((r) => r.path),
            directory: dir,
            before: direction < 0 ? adjacent.path : siblings[index + 2]?.path,
        });
    };
    table.onkeydown = (e) => {
        if (e.target === search) return;
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
            reorder(e.key === "ArrowUp" ? -1 : 1);
        }
    };
    let dispose = (): void => {
        document.removeEventListener("docs:files-changed", refreshFiles);
        document.removeEventListener("docs:ui-language", relocalize);
        delete host.dataset.mounted;
    };
    const relocalize = (): void => {
        dispose();
        host.replaceChildren();
        dispose = mountFiles(openFile) ?? (() => {});
    };
    document.addEventListener("docs:ui-language", relocalize, { once: true });
    void perform({ action: "read" });
    document.addEventListener("docs:files-changed", refreshFiles);
    return () => dispose();
};
