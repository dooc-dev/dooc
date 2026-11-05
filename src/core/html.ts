// Normalized Block AST → HTML (renderer for the local preview). The preview goes through the same
// "just map blocks + inline segments to output" pipeline as consumers (= prevents rendering
// semantics from drifting). Headings and body text share the same weight (headings are also
// font-weight 400).
import type { FigureEntry, TermEntry } from "./artifact-types.js";
import type { Block, ListItem, TocEntry } from "./blocks.js";
import { figureFrameHtml } from "./figure-frame.js";
import {
    GRAPH_LAYOUT_MARGIN,
    GRAPH_LEGEND,
    type GraphLayoutNode,
    graphUid,
    layoutGraph,
} from "./graph.js";
import { inlineSegmenter, termMap } from "./inline.js";
import { type LanguageAdapter, termComparator } from "./language.js";
import { parseDocLink } from "./routing.js";
import {
    layoutSchemaGraph,
    SCHEMA_LAYOUT_MARGIN,
    type SchemaLayoutTable,
    schemaGraphClientData,
    schemaGraphUid,
} from "./schema-graph.js";
import { docDisplayName, type Frontmatter } from "./taxonomy.js";
import { termAnchor } from "./term-reference.js";
import { textfileName } from "./textfile.js";

export interface RenderCtx {
    /** Figures including their markup (name → entry). */
    figures: ReadonlyMap<string, FigureEntry>;
    terms: readonly TermEntry[];
    termLinks?: ReadonlyMap<string, string>;
    /**
     * Link target for `Fig. <name>` references = the doc holding the `::figures` list
     * (figureIndexRoute). If absent, references aren't linked.
     */
    figureIndex?: string;
    /** The doc's language tag (BCP 47), emitted as `<article lang>`. */
    lang?: string;
    /** Localized in-page table of contents title. Default: Contents. */
    tocTitle?: string;
    /** Document URL for the viewer's section-copy buttons. */
    sectionUrl?: string;
    /**
     * Adapter for the doc's language (term ordering). Default: generic
     * Unicode rules (language.ts).
     */
    language?: LanguageAdapter;
}

/** Route of the first doc containing `::figures` (the figure list); Fig. references link here. */
export const figureIndexRoute = (
    docs: readonly { id: string; blocks: readonly Block[] }[],
): string | undefined => docs.find((d) => d.blocks.some((b) => b.type === "figures"))?.id;

export const emptyCtx: RenderCtx = { figures: new Map(), terms: [] };

export const escapeHtml = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type Segmenter = (text: string) => ReturnType<ReturnType<typeof inlineSegmenter>>;

// inline segment → html. Figure reference = link to the anchor on the figure page + the figure
// itself on hover (popup only for svg; html fragments get just the link to avoid duplicate ids).
// Term reference = definition tooltip on hover.
const segmentsHtml = (text: string, ctx: RenderCtx, seg: Segmenter): string =>
    seg(text)
        .map((s) => {
            switch (s.kind) {
                case "text":
                    return escapeHtml(s.text);
                case "code":
                    return `<code>${escapeHtml(s.text)}</code>`;
                case "link": {
                    // doc: links are resolved to `/<docId>` via routing.
                    const id = parseDocLink(s.url);
                    const href = id ? `/${id}` : s.url;
                    return `<a href="${escapeHtml(href)}">${escapeHtml(s.text)}</a>`;
                }
                case "figref": {
                    const fig = ctx.figures.get(s.name);
                    const pop =
                        fig && fig.kind === "svg"
                            ? `<span class="figpop">${figureFrameHtml(fig, "fig-frame figpop-frame")}</span>`
                            : "";
                    if (!ctx.figureIndex) {
                        return `<span class="figref">${escapeHtml(s.text)}${pop}</span>`;
                    }
                    const href = `/${ctx.figureIndex}#${s.name}`;
                    return `<a class="figref" href="${href}">${escapeHtml(s.text)}${pop}</a>`;
                }
                case "term": {
                    const entry = termMap(ctx.terms).get(s.id);
                    if (!entry) return escapeHtml(s.text);
                    const href =
                        ctx.termLinks?.get(s.id) ??
                        `/_files/terms#${encodeURIComponent(termAnchor(s.id))}`;
                    return `<a class="dictref" href="${escapeHtml(href)}">${escapeHtml(s.text)}<span class="dictpop">${escapeHtml(entry.definition)}${entry.description ? `<span class="dictpop-description">${escapeHtml(entry.description)}</span>` : ""}</span></a>`;
                }
                default:
                    return "";
            }
        })
        .join("");

const listHtml = (items: ListItem[], ctx: RenderCtx, seg: Segmenter, ordered = false): string => {
    const tag = ordered ? "ol" : "ul";
    const lis = items
        .map((it) => {
            const text = typeof it === "string" ? it : it.text;
            const children =
                typeof it === "string" || it.children.length === 0
                    ? ""
                    : listHtml(it.children, ctx, seg, it.ordered === true);
            return `<li>${segmentsHtml(text, ctx, seg)}${children}</li>`;
        })
        .join("");
    return `<${tag}>${lis}</${tag}>`;
};

// caption: line 1 = the label "Fig.<name>", then a newline and the description (.cap keeps it via
// pre-line). The figure content is figure-frame.ts's sandboxed iframe (fully isolates svg / html;
// raster images use <img>).
const figureHtml = (fig: FigureEntry, withLabel = true, caption?: string): string => {
    const label = caption ?? fig.title ?? `Fig.${fig.name}`;
    const cap = [withLabel ? label : undefined, fig.desc].filter(Boolean).join("\n");
    return `<figure class="fig">${figureFrameHtml(fig, "fig-frame", caption)}${
        cap ? `<figcaption class="cap">${escapeHtml(cap)}</figcaption>` : ""
    }</figure>`;
};

const tableHtml = (
    b: Extract<Block, { type: "table" }>,
    ctx: RenderCtx,
    seg: Segmenter,
): string => {
    const th = b.headers.map((h) => `<th>${segmentsHtml(h, ctx, seg)}</th>`).join("");
    const trs = b.rows
        .map((r) => `<tr>${r.map((c) => `<td>${segmentsHtml(c, ctx, seg)}</td>`).join("")}</tr>`)
        .join("");
    const table = `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
    if (b.collapsible) {
        return `<details><summary>${escapeHtml(b.caption ?? "table")}</summary>${table}</details>`;
    }
    return `${table}${b.caption ? `<div class="cap">${escapeHtml(b.caption)}</div>` : ""}`;
};

// Numbers are rounded to one decimal place (keeps the SVG stable and short).
const n1 = (v: number): string => String(Math.round(v * 10) / 10);

// One table box: header (rounded top edge) + field rows + note rows + transparent rects for hover
// hit-testing.
const schemaBoxHtml = (t: SchemaLayoutTable): string => {
    const r = t.radius;
    const head = [
        `M${n1(t.x)},${n1(t.y + r)}`,
        `a${r},${r} 0 0 1 ${r},-${r}`,
        `h${n1(t.w - r * 2)}`,
        `a${r},${r} 0 0 1 ${r},${r}`,
        `v${n1(t.headerH - r)}`,
        `h-${n1(t.w)}`,
        "z",
    ].join(" ");
    const rows = t.rows
        .map((row) => {
            if (row.kind === "note") {
                return `<text class="sg-note" x="${n1(row.x)}" y="${n1(row.baseline)}">${escapeHtml(row.name)}</text>`;
            }
            const typeCls = row.kind === "pk" ? " sg-key" : row.kind === "scalar" ? "" : " sg-ref";
            return [
                `<text class="sg-fname" x="${n1(row.x)}" y="${n1(row.baseline)}">${escapeHtml(row.name)}</text>`,
                `<text class="sg-ftype${typeCls}" x="${n1(row.typeX)}" y="${n1(row.baseline)}" text-anchor="end">${escapeHtml(row.type)}</text>`,
            ].join("");
        })
        .join("");
    // Hover targets = the whole box (table) + fk rows (field). Field targets come last so they sit
    // on top.
    const hits = t.rows
        .filter((row) => row.fieldIndex != null && (row.kind === "fk" || row.kind === "fkList"))
        .map(
            (row) =>
                `<rect class="sg-hit sg-hf${t.index}-${row.fieldIndex}" x="${n1(t.x)}" y="${n1(row.y - 9.5)}" width="${n1(t.w)}" height="19"></rect>`,
        )
        .join("");
    // data-sg-t = key the interaction layer (schema-graph-client.ts) uses to look up drag targets.
    return [
        `<g class="sg-g" data-sg-t="${t.index}">`,
        `<rect class="sg-box sg-b${t.index}" x="${n1(t.x)}" y="${n1(t.y)}" width="${n1(t.w)}" height="${n1(t.h)}" rx="${r}"></rect>`,
        `<path class="sg-head" d="${head}"></path>`,
        `<text class="sg-tname" x="${n1(t.rows[0]?.x ?? t.x)}" y="${n1(t.headerBaseline)}">${escapeHtml(t.name)}</text>`,
        rows,
        `<rect class="sg-hit sg-h${t.index}" x="${n1(t.x)}" y="${n1(t.y)}" width="${n1(t.w)}" height="${n1(t.h)}"></rect>`,
        hits,
        "</g>",
    ].join("");
};

// schema graph (`:::schema`) → self-contained SVG. Geometry comes from schema-graph.ts
// (deterministic layout); this is markup only. Colors reference `var(--doc-*, fallback)` like
// figures, and linked hover (highlighting related edges) is done entirely with CSS :has() (no JS =
// same behavior on every consumer). Classes / marker ids are namespaced by the model hash, so
// multiple graphs on the same page don't collide.
const schemaGraphHtml = (b: Extract<Block, { type: "schemaGraph" }>): string => {
    if (b.graph.tables.length === 0) {
        return `<div class="ph">schema graph<span> — no tables declared</span></div>`;
    }
    const layout = layoutSchemaGraph(b.graph);
    const cls = `sg-${schemaGraphUid(b.graph)}`;
    const arrow = `${cls}-arw`;
    const accent = "var(--doc-accent-2, #0277bd)";
    const rules = [
        `.${cls}{width:100%;max-width:${layout.width}px;height:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}`,
        `.${cls} .sg-frame{fill:color-mix(in srgb, var(--doc-fg, #000000) 3%, transparent);stroke:var(--doc-border, #dde3eb);stroke-width:1;stroke-dasharray:5 4}`,
        `.${cls} .sg-glabel{font-size:11.5px;fill:var(--doc-fg-3, #5b6271)}`,
        `.${cls} .sg-box{fill:var(--doc-panel, #ffffff);stroke:var(--doc-border, #dde3eb);stroke-width:1}`,
        `.${cls} .sg-head{fill:color-mix(in srgb, ${accent} 10%, transparent)}`,
        `.${cls} .sg-tname{font-size:12.5px;fill:var(--doc-fg, #000000)}`,
        `.${cls} .sg-fname{font-size:11.5px;fill:var(--doc-fg-2, #2a3140)}`,
        `.${cls} .sg-ftype{font-size:10.5px;fill:var(--doc-fg-3, #5b6271)}`,
        `.${cls} .sg-key{fill:${accent}}`,
        `.${cls} .sg-ref{fill:var(--doc-accent, #1b4994)}`,
        `.${cls} .sg-note{font-size:10.5px;fill:var(--doc-fg-4, #9099a8)}`,
        `.${cls} .sg-e{fill:none;stroke:color-mix(in srgb, var(--doc-fg, #000000) 26%, transparent);stroke-width:1.2}`,
        `.${cls} .sg-list{stroke-dasharray:5 4}`,
        `.${cls} .sg-hit{fill:transparent}`,
        `.${cls} .sg-legend{font-size:10.5px;fill:var(--doc-fg-3, #5b6271)}`,
        // Classes added by the interaction layer (schema-graph-client.ts). Where JS doesn't run
        // they never appear, so the SVG stays static (= progressive enhancement).
        `.${cls}.sg-live{touch-action:none}`,
        `.${cls}.sg-live .sg-g{cursor:grab}`,
        `.${cls}.sg-grabbing .sg-g{cursor:grabbing}`,
        `.${cls} .sg-tool{opacity:0.35;transition:opacity .12s}`,
        `.${cls}:hover .sg-tool,.${cls}.sg-expanded .sg-tool{opacity:1}`,
        `.${cls} .sg-btn{cursor:pointer}`,
        `.${cls} .sg-btn-bg{fill:var(--doc-panel, #ffffff);stroke:var(--doc-border, #dde3eb);stroke-width:1}`,
        `.${cls} .sg-btn:hover .sg-btn-bg{stroke:${accent}}`,
        `.${cls} .sg-btn-t{font-size:12px;fill:var(--doc-fg-2, #2a3140)}`,
    ];
    // Table hover = highlight every edge connected to that table (dimming the rest); fk row hover =
    // strongest highlight on that one edge.
    for (const t of layout.tables) {
        rules.push(
            `.${cls}:has(.sg-h${t.index}:hover) .sg-e{opacity:0.12}`,
            `.${cls}:has(.sg-h${t.index}:hover) .sg-et${t.index}{opacity:1;stroke:${accent};stroke-width:1.8}`,
            `.${cls}:has(.sg-h${t.index}:hover) .sg-b${t.index}{stroke:${accent}}`,
        );
    }
    for (const e of layout.edges) {
        rules.push(
            `.${cls}:has(.sg-hf${e.from}-${e.fieldIndex}:hover) .sg-ef${e.from}-${e.fieldIndex}{opacity:1;stroke:${accent};stroke-width:2.4}`,
        );
    }
    const frames = layout.groups
        .map(
            (g) =>
                `<rect class="sg-frame" x="${n1(g.x)}" y="${n1(g.y)}" width="${n1(g.w)}" height="${n1(g.h)}" rx="14"></rect><text class="sg-glabel" x="${n1(g.x + 4)}" y="${n1(g.y - 7)}">${escapeHtml(g.label)}</text>`,
        )
        .join("");
    // data-sg-e = index the interaction layer uses to replace d after a drag (in lockstep with
    // layout.edges).
    const edges = layout.edges
        .map(
            (e, i) =>
                `<path class="sg-e sg-et${e.from} sg-et${e.to} sg-ef${e.from}-${e.fieldIndex}${e.list ? " sg-list" : ""}" data-sg-e="${i}" d="${e.d}" marker-end="url(#${arrow})"></path>`,
        )
        .join("");
    const legend =
        layout.legendY == null
            ? ""
            : `<text class="sg-legend" x="${SCHEMA_LAYOUT_MARGIN}" y="${n1(layout.legendY)}">Solid = fk (1:1) / dashed = fk[] (1:N) / hover to highlight related references</text>`;
    const desc = `${b.graph.tables.length} tables, ${b.graph.edges.length} references: ${b.graph.tables
        .map((t) => t.name)
        .join(", ")}`;
    // Data read by the interactive UI (React Flow). It starts from the same model / same initial
    // placement, so the picture doesn't jump when switching from static SVG → interactive graph
    // (before mount / without JS, this SVG is the fallback as-is).
    const clientData = schemaGraphClientData(cls, b.graph, layout, b.source);
    const svg = [
        `<svg xmlns="http://www.w3.org/2000/svg" class="${cls}" viewBox="0 0 ${layout.width} ${layout.height}" role="img" data-sg-layout="${escapeHtml(JSON.stringify(clientData))}">`,
        `<title>${escapeHtml(b.caption ?? "schema graph")}</title>`,
        `<desc>${escapeHtml(desc)}</desc>`,
        `<defs><marker id="${arrow}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill:context-stroke"></path></marker></defs>`,
        `<style>${rules.join("\n")}</style>`,
        // sg-view = target of zoom / pan (the toolbar band and legend stay in screen coordinates).
        '<g class="sg-view">',
        frames,
        edges,
        layout.tables.map(schemaBoxHtml).join(""),
        "</g>",
        legend,
        "</svg>",
    ].join("");
    return `<figure class="fig">${svg}${
        b.caption ? `<figcaption class="cap">${escapeHtml(b.caption)}</figcaption>` : ""
    }</figure>`;
};

// One node box (rounded rect + centered label + transparent rect for hover hit-testing).
const graphBoxHtml = (n: GraphLayoutNode): string =>
    [
        `<g class="gr-g" data-gr-n="${n.index}">`,
        `<rect class="gr-box gr-b${n.index}" x="${n1(n.x)}" y="${n1(n.y)}" width="${n1(n.w)}" height="${n1(n.h)}" rx="${n.radius}"></rect>`,
        `<text class="gr-nlabel" x="${n1(n.textX)}" y="${n1(n.baseline)}" text-anchor="middle">${escapeHtml(n.label)}</text>`,
        `<rect class="gr-hit gr-h${n.index}" x="${n1(n.x)}" y="${n1(n.y)}" width="${n1(n.w)}" height="${n1(n.h)}"></rect>`,
        "</g>",
    ].join("");

// Relationship graph (`grapth`) → self-contained SVG. Geometry comes from graph.ts
// (deterministic layout); this is markup only. Colors reference `var(--doc-*, fallback)` like
// figures / schema graph, and linked hover (highlighting related edges) is done entirely with CSS
// :has() (no JS = same behavior on every consumer). Classes / marker ids are namespaced by the
// model hash, so multiple graphs on the same page don't collide.
const graphHtml = (b: Extract<Block, { type: "graph" }>): string => {
    if (b.graph.nodes.length === 0) {
        return `<div class="ph">graph<span> — no nodes declared</span></div>`;
    }
    const layout = layoutGraph(b.graph);
    const cls = `gr-${graphUid(b.graph)}`;
    const arrow = `${cls}-arw`;
    const accent = "var(--doc-accent-2, #0277bd)";
    const rules = [
        `.${cls}{width:100%;max-width:${layout.width}px;height:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}`,
        `.${cls} .gr-frame{fill:color-mix(in srgb, var(--doc-fg, #000000) 3%, transparent);stroke:var(--doc-border, #dde3eb);stroke-width:1;stroke-dasharray:5 4}`,
        `.${cls} .gr-glabel{font-size:11.5px;fill:var(--doc-fg-3, #5b6271)}`,
        `.${cls} .gr-box{fill:var(--doc-panel, #ffffff);stroke:var(--doc-border, #dde3eb);stroke-width:1}`,
        `.${cls} .gr-nlabel{font-size:12.5px;fill:var(--doc-fg, #000000)}`,
        `.${cls} .gr-e{fill:none;stroke:color-mix(in srgb, var(--doc-fg, #000000) 26%, transparent);stroke-width:1.2}`,
        `.${cls} .gr-dashed{stroke-dasharray:5 4}`,
        `.${cls} .gr-elabel{font-size:10.5px;fill:var(--doc-fg-3, #5b6271)}`,
        `.${cls} .gr-hit{fill:transparent}`,
        `.${cls} .gr-legend{font-size:10.5px;fill:var(--doc-fg-3, #5b6271)}`,
    ];
    // Node hover = highlight every edge connected to that node (dimming the rest).
    for (const n of layout.nodes) {
        rules.push(
            `.${cls}:has(.gr-h${n.index}:hover) .gr-e{opacity:0.12}`,
            `.${cls}:has(.gr-h${n.index}:hover) .gr-et${n.index}{opacity:1;stroke:${accent};stroke-width:1.8}`,
            `.${cls}:has(.gr-h${n.index}:hover) .gr-b${n.index}{stroke:${accent}}`,
        );
    }
    const frames = layout.regions
        .map(
            (g) =>
                `<rect class="gr-frame" x="${n1(g.x)}" y="${n1(g.y)}" width="${n1(g.w)}" height="${n1(g.h)}" rx="14"></rect><text class="gr-glabel" x="${n1(g.x + 4)}" y="${n1(g.y - 7)}">${escapeHtml(g.label)}</text>`,
        )
        .join("");
    const edges = layout.edges
        .map((e, i) => {
            const marker = e.kind === "undirected" ? "" : ` marker-end="url(#${arrow})"`;
            const dash = e.kind === "dashed" ? " gr-dashed" : "";
            const path = `<path class="gr-e gr-et${e.from} gr-et${e.to}${dash}" data-gr-e="${i}" d="${e.d}"${marker}></path>`;
            if (e.label == null) {
                return path;
            }
            return `${path}<text class="gr-elabel" x="${n1(e.labelX ?? 0)}" y="${n1(e.labelY ?? 0)}" text-anchor="${e.labelAnchor === "middle" ? "middle" : "start"}">${escapeHtml(e.label)}</text>`;
        })
        .join("");
    const legend =
        layout.legendY == null
            ? ""
            : `<text class="gr-legend" x="${GRAPH_LAYOUT_MARGIN}" y="${n1(layout.legendY)}">${escapeHtml(GRAPH_LEGEND)}</text>`;
    const desc = `${b.graph.nodes.length} nodes, ${b.graph.edges.length} edges: ${b.graph.nodes
        .map((n) => n.label)
        .join(", ")}`;
    const svg = [
        `<svg xmlns="http://www.w3.org/2000/svg" class="${cls}" viewBox="0 0 ${layout.width} ${layout.height}" role="img">`,
        `<title>${escapeHtml(b.caption ?? "graph")}</title>`,
        `<desc>${escapeHtml(desc)}</desc>`,
        `<defs><marker id="${arrow}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill:context-stroke"></path></marker></defs>`,
        `<style>${rules.join("\n")}</style>`,
        frames,
        edges,
        layout.nodes.map(graphBoxHtml).join(""),
        legend,
        "</svg>",
    ].join("");
    return `<figure class="fig">${svg}${
        b.caption ? `<figcaption class="cap">${escapeHtml(b.caption)}</figcaption>` : ""
    }</figure>`;
};

const TERM_ICON =
    '<svg class="term-icon" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3h11v14H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm-2 12a2 2 0 0 1 2-2h11M7 10l2-5 2 5M8 8h2"/></svg>';

/** Shared dictionary entries for definitions and the Resources list. */
export const termsHtml = (
    terms: readonly TermEntry[],
    language?: LanguageAdapter,
    sortable = false,
): string => {
    const entries = terms
        .map((entry, sourceOrder) => ({ ...entry, sourceOrder }))
        .sort(termComparator(language));
    return `<section class="terms" aria-label="Terms">${sortable ? `<div class="dict-toolbar"><span>${entries.length} terms</span><label>Sort <select data-dict-sort><option value="asc">Name A → Z</option><option value="desc">Name Z → A</option><option value="source">Source order</option></select></label></div>` : ""}<div class="dict">${entries
        .map(
            (e, i) =>
                `<fieldset class="dict-card" data-source-order="${e.sourceOrder}" data-sort-order="${i}" data-term="${escapeHtml(e.id)}"><legend id="${termAnchor(e.id)}">${TERM_ICON}<a class="term-name" href="/_files/terms#${encodeURIComponent(termAnchor(e.id))}"${e.description ? ` aria-describedby="term-description-${encodeURIComponent(e.id)}"` : ""}>${escapeHtml(e.name)}${e.description ? `<span class="term-description" role="tooltip" id="term-description-${encodeURIComponent(e.id)}">${escapeHtml(e.description)}</span>` : ""}</a></legend><p class="term-definition">${escapeHtml(e.definition)}</p></fieldset>`,
        )
        .join("")}</div></section>`;
};

const blockHtml = (b: Block, ctx: RenderCtx, seg: Segmenter): string => {
    switch (b.type) {
        case "h":
            // id = slug (a single-doc page, so no namespace is needed).
            return `<h${b.level} id="${escapeHtml(b.slug)}">${segmentsHtml(b.text, ctx, seg)}${ctx.sectionUrl === undefined ? "" : `<button class="section-copy" type="button" data-section-url="${escapeHtml(ctx.sectionUrl)}#${encodeURIComponent(b.slug)}" title="Copy section URL" aria-label="Copy section URL" data-i18n-title="Copy section URL" data-i18n-aria-label="Copy section URL"><svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="m8 12 4-4m-5 2-2 2a3 3 0 0 0 4 4l2-2m-2-8 2-2a3 3 0 0 1 4 4l-2 2"/></svg></button>`}</h${b.level}>`;
        case "p":
            return `<p>${segmentsHtml(b.text, ctx, seg)}</p>`;
        case "list":
            return listHtml(b.items, ctx, seg, b.ordered === true);
        case "code": {
            const filename = b.filename ? textfileName(b.filename) : "";
            const lang = b.filename ? /^.+(\.[^.]+)$/.exec(filename)?.[1] : (b.lang ?? "text");
            const langLabel = lang ? `<span class="codeblk-lang">${escapeHtml(lang)}</span>` : "";
            const filenameLabel = filename
                ? `<span class="codeblk-filename">${escapeHtml(filename)}</span>`
                : "";
            const title = b.filename
                ? ` title="${escapeHtml(`${b.filename}${b.range ?? ""}`)}"${b.alt ? ` role="region" aria-label="${escapeHtml(b.alt)}"` : ""}`
                : "";
            if (b.filename && b.unavailable) {
                const message =
                    b.unavailable === "missing" ? "File not found" : "File could not be loaded";
                return `<div class="codeblk textfile unavailable"${title}><span class="codeblk-head">${langLabel}${filenameLabel}</span><p class="textfile-unavailable" role="status" data-i18n="${message}">${message}</p></div>`;
            }
            // Copy/fold behavior and border-label styling are shared by the page shell.
            return `<div class="codeblk${b.filename ? " textfile" : ""}" data-lang="${escapeHtml(b.lang ?? "text")}"${title}><span class="codeblk-head">${langLabel}${filenameLabel}<button class="codecopy" type="button" title="copy" aria-label="copy code"><svg class="ic-copy" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg><svg class="ic-ok" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></button><button class="codefold" type="button" aria-expanded="true" aria-label="Collapse code" title="Collapse code" data-i18n-aria-label="Collapse code" data-i18n-title="Collapse code"><svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 7.5 5 5 5-5"/></svg></button></span><pre><code>${escapeHtml(b.lines.join("\n"))}</code></pre></div>`;
        }
        case "table":
            return tableHtml(b, ctx, seg);
        case "callout": {
            const title = b.title ? `<div class="cap">${escapeHtml(b.title)}</div>` : "";
            const body = b.body
                .map((it) =>
                    it.type === "p"
                        ? `<p>${segmentsHtml(it.text, ctx, seg)}</p>`
                        : listHtml(it.items, ctx, seg, it.ordered === true),
                )
                .join("");
            return `<aside class="callout">${title}${body}</aside>`;
        }
        case "figureRef": {
            const fig = ctx.figures.get(b.name);
            if (fig) {
                return figureHtml(fig, true, b.caption);
            }
            return `<div class="ph">${escapeHtml(`Fig. ${b.name}`)}<span> — not found in figures/</span></div>`;
        }
        case "term":
            return termsHtml([b.entry], ctx.language);
        case "figures":
            // Figure list. The h2 doubles as the label, so captions omit it. h2 id = fig name
            // (anchor).
            return [...ctx.figures.values()]
                .map(
                    (f) =>
                        `<h2 id="${escapeHtml(f.name)}">${escapeHtml(f.title ?? f.name)}</h2>${figureHtml(f, false)}`,
                )
                .join("\n");
        case "schemaGraph":
            // table DSL → ER diagram. The model baked into the artifact is turned into SVG with a
            // deterministic layout, so every consumer gets the same picture (no references outside
            // the data).
            return schemaGraphHtml(b);
        case "graph":
            // node / edge DSL → relationship graph. Like schemaGraph: model → deterministic layout
            // → SVG.
            return graphHtml(b);
        default:
            // Unknown block (= data generation newer than this logic) — degrade to a placeholder
            // instead of emitting "undefined".
            return `<div class="ph">${escapeHtml(`Unknown block (${(b as { type: string }).type})`)}<span> — docs viewer needs an update</span></div>`;
    }
};

export const blocksHtml = (blocks: Block[], ctx: RenderCtx = emptyCtx): string => {
    const seg = inlineSegmenter({
        figureNames: [...ctx.figures.keys()],
        terms: ctx.terms,
    });
    return blocks
        .map((b) => blockHtml(b, ctx, seg))
        .filter((h) => h !== "")
        .join("\n");
};

// In-page table of contents at the top of the body text. Separate from the nav one (.nav-toc), it
// gives an overview of the heading structure as soon as the page is opened (docs without
// headings = render nothing).
const inPageTocHtml = (toc: TocEntry[], title = "Contents"): string => {
    if (toc.length === 0) {
        return "";
    }
    const items = toc
        .map(
            (t) =>
                `<li class="lvl${t.depth}"><a href="#${escapeHtml(t.slug)}">${escapeHtml(t.text)}</a></li>`,
        )
        .join("");
    return `<nav class="in-toc" aria-label="${escapeHtml(title)}"><div class="in-toc-title">${escapeHtml(title)}</div><ul>${items}</ul></nav>`;
};

export const docHtml = (
    fm: Frontmatter,
    blocks: Block[],
    errors: string[],
    ctx: RenderCtx = emptyCtx,
    toc: TocEntry[] = [],
): string => {
    const errBox =
        errors.length > 0
            ? `<div class="errors">${errors.map((e) => `<div>${escapeHtml(e)}</div>`).join("")}</div>`
            : "";
    const lang = ctx.lang ? ` lang="${escapeHtml(ctx.lang)}"` : "";
    return `<article${lang}>${errBox}<h1>${escapeHtml(docDisplayName(fm, ""))}</h1>${inPageTocHtml(toc, ctx.tocTitle)}${blocksHtml(blocks, ctx)}</article>`;
};
