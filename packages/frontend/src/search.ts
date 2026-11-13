import type { Block, ListItem } from "../../engine/src/core/blocks.js";
import { inlineSegmenter } from "../../engine/src/core/inline.js";
import { docPath } from "../../engine/src/core/routing.js";
import { docDisplayName } from "../../engine/src/core/taxonomy.js";
import type { Site } from "../../server/src/serve.js";

export interface SearchSection {
    /** text: rendered document text; file: a file name; folder: a folder document's path. */
    kind: "text" | "file" | "folder";
    path: string;
    file: string;
    title: string;
    heading: string;
    anchor: string;
    text: string;
}

/** `files` are workspace files that open at /_files/file/<path> (edit mode only). */
export const searchIndex = (site: Site, files: readonly string[] = []): SearchSection[] => {
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
            case "themeVariants":
                return text(block.default);
            case "external":
                return `${block.alt ?? ""} ${block.url}`;
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
    const docs = site.entries.flatMap((entry) => {
        const base = {
            path: docPath(site.entries, entry.id),
            file: entry.sourceFile ?? entry.file,
            title: docDisplayName(entry.frontmatter, entry.id),
            heading: "",
            anchor: "",
            text: "",
        };
        let section: SearchSection = { ...base, kind: "text" };
        const sections: SearchSection[] = [section, { ...base, kind: "file" }];
        if (parents.has(entry.id))
            sections.push({ ...base, kind: "folder", file: `${base.path}/` });
        for (const block of entry.blocks) {
            if (block.type === "h") {
                section = { ...base, kind: "text", heading: plain(block.text), anchor: block.slug };
                sections.push(section);
            } else section.text += ` ${text(block)}`;
        }
        return sections.map((item) => ({ ...item, text: item.text.replace(/\s+/g, " ").trim() }));
    });
    const sources = new Set(docs.map((section) => section.file));
    return [
        ...docs,
        ...files
            .filter((file) => !sources.has(file))
            .map((file) => ({
                kind: "file" as const,
                path: `/_files/file/${encodeURIComponent(file)}`,
                file,
                title: file.split("/").pop() ?? file,
                heading: "",
                anchor: "",
                text: "",
            })),
    ];
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
            if (section.kind !== "text") {
                // File names match on the basename, so "md" or ".md" finds extensions.
                const name = normalize(
                    section.kind === "file" ? (section.file.split("/").pop() ?? "") : section.file,
                );
                if (!words.every((word) => name.includes(word))) return [];
                // A folder document also matches as its own file; prefer showing it as a folder.
                const score =
                    (section.kind === "folder" ? 25 : 20) * words.length +
                    (name === words.join(" ") ? 100 : 0);
                return [{ ...section, snippet: "", score }];
            }
            const title = normalize(section.title);
            const heading = normalize(section.heading);
            const text = section.text.normalize("NFKC");
            const body = text.toLowerCase();
            const all = `${title} ${heading} ${body}`;
            if (!words.every((word) => all.includes(word))) return [];
            if (section.anchor && !words.some((word) => `${heading} ${body}`.includes(word)))
                return [];
            const score =
                (title === words.join(" ") ? 100 : 0) +
                words.reduce(
                    (sum, word) =>
                        sum + (title.includes(word) ? 10 : 0) + (heading.includes(word) ? 5 : 0),
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
    "Matches text",
    "Matches file name",
    "Matches folder name",
    "Move search",
    "Resize search",
    "Close search",
    "Move search to sidebar",
    "Float search",
    "Copy path",
    "Copied",
    "Copy failed",
];

// Embedded by page(); keep browser behavior independent of the editor bundle.
export const mountSearch = (
    initial: SearchSection[],
    search: typeof searchSections,
    labels: Record<string, string>,
    published: boolean,
    requestFile: typeof fetch = fetch,
): void => {
    const svg = (d: string, size = 14): string =>
        `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
    const kinds = {
        text: { icon: svg("M5 6h14M5 11h14M5 16h9"), label: "Matches text" },
        file: { icon: svg("M6 3h8l4 4v14H6zM14 3v4h4"), label: "Matches file name" },
        folder: { icon: svg("M3 6h6l2 2h10v11H3z"), label: "Matches folder name" },
    };
    const dialog = document.createElement("dialog");
    dialog.id = "doc-search";
    dialog.setAttribute("aria-label", labels["Search documents"] ?? "Search documents");
    dialog.innerHTML = `<div class="search-grip" role="button" tabindex="0" data-label="Move search"></div><div class="search-head">${svg("M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM16 16l4 4", 18)}<input id="doc-search-input" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="doc-search-results" autocomplete="off" spellcheck="false"><button type="button" class="search-dock"></button><button type="button" class="search-close" data-label="Close search">${svg("M6 6l12 12M18 6 6 18")}</button></div><div class="search-status" role="status" aria-live="polite"></div><div id="doc-search-results" role="listbox"></div><div class="search-resize search-resize-x" role="button" tabindex="0" data-axis="x" data-label="Resize search"></div><div class="search-resize search-resize-y" role="button" tabindex="0" data-axis="y" data-label="Resize search"></div><div class="search-resize search-resize-xy" data-axis="xy" aria-hidden="true"></div><div class="search-resize search-resize-w" role="button" tabindex="0" data-axis="w" data-label="Resize search"></div>`;
    document.body.insertBefore(dialog, document.getElementById("panel"));
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
    // Wrap query words in <mark>, comparing each character the way searchSections() does.
    const highlight = (target: HTMLElement, text: string, words: string[]): HTMLElement => {
        let folded = "";
        const source: number[] = [];
        for (let i = 0; i < text.length; i++) {
            const part = (text[i] ?? "").normalize("NFKC").toLowerCase();
            folded += part;
            for (let j = 0; j < part.length; j++) source.push(i);
        }
        const marked: boolean[] = [];
        for (const word of words)
            for (let at = folded.indexOf(word); at >= 0; at = folded.indexOf(word, at + 1))
                for (let i = source[at] ?? 0; i <= (source[at + word.length - 1] ?? -1); i++)
                    marked[i] = true;
        let start = 0;
        for (let i = 1; i <= text.length; i++) {
            if (i < text.length && !!marked[i] === !!marked[start]) continue;
            const run = text.slice(start, i);
            if (marked[start]) {
                const mark = document.createElement("mark");
                mark.textContent = run;
                target.append(mark);
            } else target.append(run);
            start = i;
        }
        return target;
    };
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
    const copyButton = (text: string): HTMLButtonElement => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "search-copy";
        const show = (icon: string, label: string): void => {
            button.innerHTML = icon;
            button.title = t(label);
            button.setAttribute("aria-label", button.title);
        };
        const reset = (): void => show(svg("M9 9h11v11H9zM5 15H4V4h11v1"), "Copy path");
        reset();
        button.addEventListener("click", () => {
            Promise.resolve()
                .then(() => navigator.clipboard.writeText(text))
                .then(
                    () => show(svg("M5 12l5 5 9-10"), "Copied"),
                    () => show(svg("M6 6l12 12M18 6 6 18"), "Copy failed"),
                )
                .finally(() => setTimeout(reset, 1500));
        });
        return button;
    };
    // Highlight where a clicked result leads, once navigation has shown it.
    let pending: { path: string; anchor: string } | undefined;
    let flashing: number | undefined;
    const flash = (target: { path: string; anchor: string }): void => {
        pending = target;
        clearInterval(flashing);
        let tries = 0;
        flashing = window.setInterval(() => {
            const element =
                currentPath() !== target.path
                    ? null
                    : target.anchor
                      ? document.getElementById(target.anchor)
                      : (document.querySelector(".resources-pane article") ??
                        document.querySelector(".preview-pane.active article") ??
                        document.querySelector("main article"));
            if (!element && ++tries < 50) return;
            clearInterval(flashing);
            pending = undefined;
            if (!element) return;
            element.classList.remove("search-flash");
            void (element as HTMLElement).offsetWidth; // Restart the animation on repeated jumps.
            element.classList.add("search-flash");
            setTimeout(() => element.classList.remove("search-flash"), 2600);
        }, 100);
    };
    const render = (): void => {
        const hits = search(index, input.value, currentPath());
        const words = [
            ...new Set(input.value.normalize("NFKC").toLowerCase().trim().split(/\s+/)),
        ].filter(Boolean);
        results.replaceChildren();
        dialog.classList.toggle("search-filled", input.value.length > 0);
        for (const [i, hit] of hits.slice(0, 60).entries()) {
            const link = document.createElement("a");
            link.id = `doc-search-result-${i}`;
            link.setAttribute("role", "option");
            link.tabIndex = -1;
            link.dataset.path = hit.path;
            link.dataset.anchor = hit.anchor;
            link.href = `${published ? "#" : ""}${hit.path}${!published && language ? `?lang=${encodeURIComponent(language)}` : ""}${hit.anchor ? `#${encodeURIComponent(hit.anchor)}` : ""}`;
            const meta = document.createElement("div");
            meta.className = "search-meta";
            const kind = document.createElement("span");
            kind.className = "search-kind";
            kind.innerHTML = kinds[hit.kind].icon;
            kind.title = t(kinds[hit.kind].label);
            kind.setAttribute("role", "img");
            kind.setAttribute("aria-label", kind.title);
            const path = document.createElement("small");
            path.className = "search-path";
            path.title = hit.file;
            // File hits match only the basename, so leave the folder part unmarked.
            const cut = hit.kind === "file" ? hit.file.lastIndexOf("/") + 1 : 0;
            path.append(hit.file.slice(0, cut));
            meta.append(kind, highlight(path, hit.file.slice(cut), words));
            link.append(meta);
            // Name-only hits list just the path; their content has nothing to do with the match.
            const named = hit.kind !== "text";
            if (!named) {
                const title = document.createElement("strong");
                link.append(
                    highlight(
                        title,
                        `${hit.title}${hit.heading ? ` › ${hit.heading}` : ""}`,
                        words,
                    ),
                );
            }
            if (!named && hit.snippet) {
                const snippet = document.createElement("span");
                snippet.className = "search-snippet";
                link.append(highlight(snippet, hit.snippet, words));
            }
            // The copy button sits beside the option, since buttons cannot nest inside links.
            const item = document.createElement("div");
            item.className = named ? "search-hit search-name" : "search-hit";
            item.setAttribute("role", "none");
            item.append(link);
            if (named) item.append(copyButton(hit.file));
            results.append(item);
        }
        status.textContent = !input.value.trim()
            ? ""
            : loading
              ? t("Searching…")
              : failed
                ? t("Could not load search. Press Ctrl+F to retry.")
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
        for (const control of dialog.querySelectorAll<HTMLElement>("[data-label]")) {
            control.title = t(control.dataset.label ?? "");
            control.setAttribute("aria-label", control.title);
        }
        render();
    };
    const minHeight = 44;
    // Dock between the document and editor; each mode keeps its own inline geometry.
    let docked = false;
    let other = "";
    const dockButton = dialog.querySelector(".search-dock") as HTMLButtonElement;
    const sidebar = document.getElementById("sidebar");
    const maxDockWidth = (): number =>
        innerWidth -
        (sidebar?.getBoundingClientRect().width ?? 0) -
        240 -
        (document.getElementById("panel") ? 320 : 0);
    const dock = (value: boolean): void => {
        dockButton.disabled = maxDockWidth() < 240;
        value = value && !dockButton.disabled;
        if (value !== docked) [dialog.style.cssText, other] = [other, dialog.style.cssText];
        docked = value;
        dialog.classList.toggle("search-docked", value);
        if (value)
            dialog.style.width = `${Math.min(Number.parseFloat(dialog.style.width) || 320, maxDockWidth())}px`;
        dockButton.innerHTML = svg(
            value ? "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" : "M4 5h16v14H4zM15 5v14",
        );
        dockButton.dataset.label = value ? "Float search" : "Move search to sidebar";
        dockButton.title = t(dockButton.dataset.label);
        dockButton.setAttribute("aria-label", dockButton.title);
    };
    dock(false);
    dockButton.addEventListener("click", () => {
        dock(!docked);
        input.focus();
    });
    const position = (rect: DOMRect, dx: number, dy: number, resize = false): void => {
        const clamp = (value: number, min: number, max: number): number =>
            Math.max(Math.min(min, max), Math.min(value, max));
        if (docked) {
            // As a sidebar only the left edge resizes the panel.
            if (resize && dx)
                dialog.style.width = `${clamp(rect.width + dx, 240, maxDockWidth())}px`;
            return;
        }
        const width = clamp(rect.width + (resize ? dx : 0), 280, innerWidth - 16);
        const height = clamp(rect.height + (resize ? dy : 0), minHeight, innerHeight - 16);
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
        // Width-only resizing keeps the height following the results.
        if ((resize && dy) || dialog.style.height) dialog.style.height = `${height}px`;
    };
    for (const handle of dialog.querySelectorAll<HTMLElement>(".search-grip, .search-resize")) {
        const axis = handle.dataset.axis ?? "";
        const resize = axis !== "";
        // The left edge ("w") grows the docked panel while moving left.
        const fx = axis === "w" ? -1 : !resize || axis.includes("x") ? 1 : 0;
        const fy = !resize || axis.includes("y") ? 1 : 0;
        let drag: { id: number; x: number; y: number; rect: DOMRect } | undefined;
        handle.addEventListener("pointerdown", (event) => {
            if (event.button !== 0 || drag) return;
            event.preventDefault();
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
                position(
                    drag.rect,
                    fx * (event.clientX - drag.x),
                    fy * (event.clientY - drag.y),
                    resize,
                );
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
                fx * (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0),
                fy * (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0),
                resize,
            );
        });
    }
    const fit = (): void => {
        dock(docked);
        if (dialog.open) position(dialog.getBoundingClientRect(), 0, 0);
    };
    window.addEventListener("resize", fit);
    if (sidebar) new ResizeObserver(fit).observe(sidebar);
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
            const response = await requestFile(
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
    document.addEventListener("dooc:workspace-changed", () => {
        revision++;
        index = [];
        dialog.close();
    });
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
        const link = (event.target as Element).closest<HTMLAnchorElement>("a");
        if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        flash({ path: link.dataset.path ?? "", anchor: link.dataset.anchor ?? "" });
    });
    // The window stays open across navigation and outside clicks; only these close it.
    dialog.querySelector(".search-close")?.addEventListener("click", () => dialog.close());
    dialog.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !event.isComposing) {
            event.preventDefault();
            dialog.close();
        }
    });
    document.addEventListener("docs:ui-language", localize);
    localize();
    // Full page loads (preview links, reloads) restore the open window for this browser tab.
    const key = "docs:search";
    let saved: {
        query?: string;
        style?: string;
        docked?: boolean;
        pending?: { path: string; anchor: string };
    } | null = null;
    try {
        saved = JSON.parse(sessionStorage.getItem(key) ?? "null");
    } catch {
        /* Persistence is optional. */
    }
    window.addEventListener("pagehide", () => {
        try {
            if (dialog.open)
                sessionStorage.setItem(
                    key,
                    JSON.stringify({
                        query: input.value,
                        style: dialog.style.cssText,
                        docked,
                        pending,
                    }),
                );
            else sessionStorage.removeItem(key);
        } catch {
            /* Persistence is optional. */
        }
    });
    if (saved?.query == null) return;
    if (saved.docked) dock(true);
    if (saved.style) dialog.style.cssText = saved.style;
    input.value = saved.query;
    void open();
    if (saved.pending) flash(saved.pending);
};
