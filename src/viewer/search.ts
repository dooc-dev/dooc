import type { Block, ListItem } from "../core/blocks.js";
import { inlineSegmenter } from "../core/inline.js";
import { docPath } from "../core/routing.js";
import { docDisplayName } from "../core/taxonomy.js";
import type { Site } from "./serve.js";

export interface SearchSection {
    path: string;
    file: string;
    folder: boolean;
    title: string;
    heading: string;
    anchor: string;
    text: string;
}

export const searchIndex = (site: Site): SearchSection[] => {
    const parents = new Set(site.entries.map((entry) => entry.parent));
    const segments = inlineSegmenter({ terms: site.ctx.terms });
    const plain = (text: string): string =>
        segments(text)
            .map((part) => part.text)
            .join("");
    const list = (items: ListItem[]): string =>
        items
            .map((item) =>
                typeof item === "string"
                    ? plain(item)
                    : "blocks" in item
                      ? item.blocks.map(text).join(" ")
                      : `${plain(item.text)} ${list(item.children)}`,
            )
            .join(" ");
    const text = (block: Block): string => {
        switch (block.type) {
            case "h":
            case "p":
                return plain(block.text);
            case "quote":
                return block.blocks.map(text).join(" ");
            case "list":
                return list(block.items);
            case "code":
                return [block.filename ?? "", ...block.lines].join(" ");
            case "table":
                return [block.caption ?? "", ...block.headers, ...block.rows.flat()]
                    .map(plain)
                    .join(" ");
            case "callout":
                return [
                    block.title ?? "",
                    ...block.body.map((part) =>
                        part.type === "p" ? plain(part.text) : list(part.items),
                    ),
                ].join(" ");
            case "term":
                return [
                    block.entry.name,
                    block.entry.description ?? "",
                    block.entry.definition,
                ].join(" ");
            case "figureRef":
                return block.caption ?? site.ctx.figures.get(block.name)?.title ?? block.name;
            case "graph":
            case "schemaGraph":
                return `${block.caption ?? ""} ${block.source ?? ""}`;
            case "figures":
                return [...site.ctx.figures.values()]
                    .map((figure) => `${figure.title ?? figure.name} ${figure.desc ?? ""}`)
                    .join(" ");
        }
    };
    return site.entries.flatMap((entry) => {
        const base = {
            path: docPath(site.entries, entry.id),
            file: entry.file,
            folder: parents.has(entry.id),
            title: docDisplayName(entry.frontmatter, entry.id),
        };
        let section: SearchSection = {
            ...base,
            heading: "",
            anchor: "",
            text: "",
        };
        const sections = [section];
        for (const block of entry.blocks) {
            if (block.type === "h") {
                section = { ...base, heading: plain(block.text), anchor: block.slug, text: "" };
                sections.push(section);
            } else section.text += ` ${text(block)}`;
        }
        return sections.map((item) => ({ ...item, text: item.text.replace(/\s+/g, " ").trim() }));
    });
};

// Self-contained: the viewer embeds this function in offline HTML as well.
export const searchSections = (
    index: SearchSection[],
    query: string,
    currentPath = "",
): (SearchSection & { snippet: string })[] => {
    const normalize = (text: string): string => text.normalize("NFKC").toLowerCase();
    const words = [...new Set(normalize(query).trim().split(/\s+/).filter(Boolean))];
    if (!words.length) return [];
    const seen = new Set<string>();
    return index
        .flatMap((section) => {
            const title = normalize(section.title);
            const heading = normalize(section.heading);
            const text = section.text.normalize("NFKC");
            const body = text.toLowerCase();
            const name = section.anchor ? "" : normalize(`${section.file} ${section.path}`);
            const all = `${title} ${heading} ${body} ${name}`;
            if (!words.every((word) => all.includes(word))) return [];
            if (section.anchor && !words.some((word) => `${heading} ${body}`.includes(word)))
                return [];
            const score =
                (title === words.join(" ") ? 100 : 0) +
                words.reduce(
                    (sum, word) =>
                        sum +
                        (title.includes(word) ? 10 : 0) +
                        (name.includes(word) ? 10 : 0) +
                        (heading.includes(word) ? 5 : 0),
                    0,
                );
            const matches = words.map((word) => body.indexOf(word)).filter((at) => at >= 0);
            const start = Math.max(0, (matches.length ? Math.min(...matches) : 0) - 45);
            const snippet = `${start ? "…" : ""}${text.slice(start, start + 180)}${text.length > start + 180 ? "…" : ""}`;
            return [{ ...section, snippet, score }];
        })
        .sort(
            (a, b) =>
                Number(b.path === currentPath) - Number(a.path === currentPath) ||
                b.score - a.score,
        )
        .filter((hit) => {
            if (hit.path === currentPath) return true;
            if (seen.has(hit.path)) return false;
            seen.add(hit.path);
            return true;
        });
};

export const SEARCH_LABELS = [
    "Search documents",
    "No results",
    "Searching…",
    "Could not load search. Press Ctrl+F to retry.",
    "{count} results",
    "Showing {shown} of {count} results",
    "Folder",
    "Move search",
    "Resize search",
];

// Embedded by page(); keep browser behavior independent of the editor bundle.
export const mountSearch = (
    initial: SearchSection[],
    search: typeof searchSections,
    labels: Record<string, string>,
    published: boolean,
): void => {
    const dialog = document.createElement("dialog");
    dialog.id = "doc-search";
    dialog.setAttribute("aria-label", labels["Search documents"] ?? "Search documents");
    dialog.innerHTML = `<div class="search-head"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg><input id="doc-search-input" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="doc-search-results" autocomplete="off" spellcheck="false"></div><div class="search-status" role="status" aria-live="polite"></div><div id="doc-search-results" role="listbox"></div><div class="search-grip search-grip-left" role="button" tabindex="0"></div><div class="search-grip search-grip-right" role="button" tabindex="0"></div><div class="search-resize" role="button" tabindex="0"></div>`;
    document.body.append(dialog);
    const input = dialog.querySelector("input") as HTMLInputElement;
    const results = dialog.querySelector("#doc-search-results") as HTMLElement;
    const status = dialog.querySelector(".search-status") as HTMLElement;
    const t = (key: string, values: Record<string, number> = {}): string => {
        const translate = (window as Window & { __docsTranslate?: (key: string) => string })
            .__docsTranslate;
        return (translate?.(key) ?? labels[key] ?? key).replace(
            /\{(\w+)\}/g,
            (token, name: string) => String(values[name] ?? token),
        );
    };
    let index = initial;
    let selected = 0;
    let revision = 0;
    let loading = false;
    let failed = false;
    let language = "";
    const currentPath = (): string =>
        published
            ? location.hash.slice(1).split(/[?#]/)[0] || initial[0]?.path || ""
            : location.pathname;
    const select = (position: number): void => {
        const items = [...results.querySelectorAll<HTMLAnchorElement>("a")];
        selected = items.length ? (position + items.length) % items.length : 0;
        items.forEach((item, i) => {
            item.setAttribute("aria-selected", String(i === selected));
        });
        const active = items[selected];
        if (active) {
            input.setAttribute("aria-activedescendant", active.id);
            active.scrollIntoView({ block: "nearest" });
        } else input.removeAttribute("aria-activedescendant");
    };
    const render = (): void => {
        const hits = search(index, input.value, currentPath());
        results.replaceChildren();
        dialog.classList.toggle("search-filled", input.value.length > 0);
        for (const [i, hit] of hits.slice(0, 60).entries()) {
            const link = document.createElement("a");
            link.id = `doc-search-result-${i}`;
            link.setAttribute("role", "option");
            link.tabIndex = -1;
            link.href = `${published ? "#" : ""}${hit.path}${!published && language ? `?lang=${encodeURIComponent(language)}` : ""}${hit.anchor ? `#${encodeURIComponent(hit.anchor)}` : ""}`;
            const meta = document.createElement("div");
            meta.className = "search-meta";
            const folder = hit.folder && !hit.anchor;
            const type = document.createElement("small");
            type.textContent = folder
                ? t("Folder")
                : (hit.file.split(".").pop()?.toUpperCase() ?? "");
            const path = document.createElement("small");
            path.className = "search-path";
            path.textContent = folder ? `${hit.path}/` : hit.file;
            path.title = path.textContent;
            meta.append(type, path);
            const title = document.createElement("strong");
            title.textContent = `${hit.title}${hit.heading ? ` › ${hit.heading}` : ""}`;
            const snippet = document.createElement("span");
            snippet.textContent = hit.snippet;
            link.append(meta, title, snippet);
            results.append(link);
        }
        status.textContent = loading
            ? t("Searching…")
            : failed
              ? t("Could not load search. Press Ctrl+F to retry.")
              : !input.value.trim()
                ? ""
                : !hits.length
                  ? t("No results")
                  : hits.length > 60
                    ? t("Showing {shown} of {count} results", { shown: 60, count: hits.length })
                    : t("{count} results", { count: hits.length });
        status.classList.toggle("search-count", !loading && !failed && hits.length > 0);
        input.setAttribute("aria-expanded", String(hits.length > 0));
        select(0);
    };
    const localize = (): void => {
        dialog.setAttribute("aria-label", t("Search documents"));
        input.setAttribute("aria-label", t("Search documents"));
        for (const handle of dialog.querySelectorAll<HTMLElement>(".search-grip, .search-resize")) {
            handle.title = t(
                handle.classList.contains("search-resize") ? "Resize search" : "Move search",
            );
            handle.setAttribute("aria-label", handle.title);
        }
        render();
    };
    const position = (rect: DOMRect, dx: number, dy: number, resize = false): void => {
        const clamp = (value: number, min: number, max: number): number =>
            Math.max(Math.min(min, max), Math.min(value, max));
        const width = clamp(rect.width + (resize ? dx : 0), 280, innerWidth - 16);
        const height = clamp(rect.height + (resize ? dy : 0), 56, innerHeight - 16);
        const left = clamp(rect.left + (resize ? 0 : dx), 8, innerWidth - width - 8);
        const top = clamp(rect.top + (resize ? 0 : dy), 8, innerHeight - height - 8);
        Object.assign(dialog.style, {
            left: `${left}px`,
            top: `${top}px`,
            right: "auto",
            margin: "0",
            width: `${width}px`,
            maxHeight: `${innerHeight - top - 8}px`,
        });
        if (resize || dialog.style.height) dialog.style.height = `${height}px`;
    };
    for (const handle of dialog.querySelectorAll<HTMLElement>(".search-grip, .search-resize")) {
        const resize = handle.classList.contains("search-resize");
        let drag: { id: number; x: number; y: number; rect: DOMRect } | undefined;
        handle.addEventListener("pointerdown", (event) => {
            if (event.button !== 0 || drag) return;
            event.preventDefault();
            handle.focus();
            drag = {
                id: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                rect: dialog.getBoundingClientRect(),
            };
            handle.setPointerCapture(event.pointerId);
        });
        handle.addEventListener("pointermove", (event) => {
            if (drag?.id === event.pointerId)
                position(drag.rect, event.clientX - drag.x, event.clientY - drag.y, resize);
        });
        const stop = (): void => {
            drag = undefined;
        };
        handle.addEventListener("pointerup", stop);
        handle.addEventListener("pointercancel", stop);
        handle.addEventListener("lostpointercapture", stop);
        handle.addEventListener("keydown", (event) => {
            if (!event.key.startsWith("Arrow")) return;
            event.preventDefault();
            event.stopPropagation();
            const step = event.shiftKey ? 40 : 10;
            position(
                dialog.getBoundingClientRect(),
                event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0,
                event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0,
                resize,
            );
        });
    }
    window.addEventListener("resize", () => {
        if (dialog.open) position(dialog.getBoundingClientRect(), 0, 0);
    });
    const open = async (): Promise<void> => {
        const request = ++revision;
        language =
            JSON.parse(document.getElementById("boot")?.textContent || "null")?.contentLanguage ??
            new URL(location.href).searchParams.get("lang") ??
            "";
        if (!dialog.open) dialog.show();
        if (dialog.style.left) position(dialog.getBoundingClientRect(), 0, 0);
        input.focus();
        input.select();
        failed = false;
        loading = !published;
        if (!published) index = [];
        render();
        if (published) return;
        try {
            const response = await fetch(
                `/api/search${language ? `?lang=${encodeURIComponent(language)}` : ""}`,
            );
            if (!response.ok) throw new Error(String(response.status));
            const data = (await response.json()) as SearchSection[];
            if (request !== revision) return;
            index = data;
        } catch {
            if (request !== revision) return;
            failed = true;
        }
        loading = false;
        render();
    };
    document.addEventListener(
        "keydown",
        (event) => {
            if (
                (event.ctrlKey || event.metaKey) &&
                !event.altKey &&
                !event.shiftKey &&
                event.key.toLowerCase() === "f"
            ) {
                event.preventDefault();
                event.stopPropagation();
                if (document.querySelector(":modal")) return;
                void open();
            }
        },
        true,
    );
    input.addEventListener("input", render);
    input.addEventListener("keydown", (event) => {
        if (event.isComposing) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            select(selected + (event.key === "ArrowDown" ? 1 : -1));
        } else if (event.key === "Enter") {
            event.preventDefault();
            results.querySelector<HTMLAnchorElement>('[aria-selected="true"]')?.click();
        }
    });
    results.addEventListener("click", (event) => {
        if ((event.target as Element).closest("a")) dialog.close();
    });
    dialog.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !event.isComposing) {
            event.preventDefault();
            dialog.close();
        }
    });
    document.addEventListener("pointerdown", (event) => {
        if (dialog.open && !dialog.contains(event.target as Node)) dialog.close();
    });
    document.addEventListener("docs:ui-language", localize);
    localize();
};
