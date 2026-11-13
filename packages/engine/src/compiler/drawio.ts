// Normalization of SVGs exported from draw.io = this module is the SoT.
//
// Two ways to place them (see also the top of figures.ts):
//   - figures/<name>.drawio.svg = File > Save as (Editable SVG). Carries a copy of the mxfile, so
//              one file is both the editing source and the output (open in draw.io and Save to
//              update it). Recommended
//   - figures/<name>.svg = File > Export as > SVG (the editing source can live anywhere).
//              Drift between the two (only the svg is stale) is handled by people re-exporting;
//              the build doesn't verify the relationship (= no machinery beyond "make draw.io
//              easy to work with locally")
// figures.ts passes .drawio.svg through here unconditionally, and .svg only when it comes from
// draw.io (`isDrawioSvg`), then feeds it to the same parseSvg as hand-written SVGs.
//
// **Colors stay in draw.io's scheme (not mapped to the var(--doc-*) of hand-written figures).**
// Because draw.io itself emits both light and dark values via CSS light-dark() on export:
//     stroke: light-dark(rgb(0,0,0), rgb(255,255,255))
//     fill:   light-dark(rgb(218,232,252), rgb(29,41,59))   ← auto dark version of chosen color
//     --ge-adaptive-bg: light-dark(#ffffff, var(--ge-dark-color, #121212))
// Figures are fully self-contained in terms of color. Mapping them onto the docs palette (=
// erroring on colors not in the table) is rejected: it takes away drawing freedom and would
// duplicate draw.io's own dark support. Some mismatch with the docs color scheme is acceptable.
//
// Only four things happen here:
//   1. Drop the XML prolog / DOCTYPE (figures.ts requires a single root <svg>; if left in, the
//      theme injection breaks the prolog)
//   2. Drop the content attribute (the mxfile copy) from rendered output — it's editing data, not
//      needed for distribution. Works whether "include a copy of the diagram" is ON or OFF at
//      export
//   3. Drop the trailing "Text is not SVG - cannot display" fallback — it embeds an external
//      link to drawio.com, and shipped figures shouldn't keep needless external links
//   4. Adjust the root's inline style so resolving light-dark() is left to the docs (below)
//
// What 4 does = hand only the "control over switching" light/dark to the docs:
//   - draw.io writes `color-scheme: light dark` inline on the root. Inline beats the
//     [data-doc-figure] style injected by figures.ts, so as-is the figure alone would follow the
//     **OS setting** for light/dark and not the docs theme toggle (data-theme="dark"). So only
//     the root's color-scheme declaration is removed, leaving it to figures.ts's theme injection.
//   - For the background, point `--ge-dark-color` (the variable draw.io uses for dark surfaces)
//     at the docs panel color. draw.io reads it through the variable, so this is a "stable
//     override point".
//
// title / desc follow the hand-written figure convention: title is fixed to `Fig.<name>`
// (injected mechanically); desc = the figure description comes from the mxfile's <diagram name>
// (= the draw.io page name) — only available when "include a copy of the diagram" was ON at
// export. If OFF, there's no desc (not an error).

/** Unescape XML entities, numeric ones included (to extract the mxfile from content). */
const unescapeXml = (s: string): string =>
    s
        .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) =>
            String.fromCodePoint(Number.parseInt(h, 16)),
        )
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");

/** draw.io's default page names — meaningless as a description, so not turned into <desc>. */
const DEFAULT_PAGE_NAMES = new Set(["page-1", "ページ-1", "page 1", "untitled", ""]);

// The content attribute is "one long attribute carrying the mxfile".
const CONTENT_ATTR = /\scontent="(?:[^"\\]|\\.)*"/;

const rootHead = (raw: string): string | undefined => {
    const start = raw.indexOf("<svg");
    if (start < 0) {
        return undefined;
    }
    const end = raw.indexOf(">", start);
    return raw.slice(start, end < 0 ? undefined : end + 1);
};

/**
 * Extract the mxfile XML from the root <svg>'s content attribute.
 * A prolog / DOCTYPE may precede it, so cut the start tag from the `<svg` position (the first `>`
 * belongs to the prolog).
 */
export const extractMxfile = (raw: string): string | undefined => {
    const head = rootHead(raw);
    const m = head ? /\scontent="([^"]*)"/.exec(head) : null;
    const xml = m?.[1] ? unescapeXml(m[1]) : undefined;
    return xml?.includes("<mxfile") || xml?.includes("<mxGraphModel") ? xml : undefined;
};

/** The mxfile's first <diagram name="..."> = the draw.io page name (= figure description). */
export const mxfilePageName = (mxfile: string): string | undefined => {
    const m = /<diagram[^>]*\sname="([^"]*)"/.exec(mxfile);
    const name = m?.[1] ? unescapeXml(m[1]).trim() : "";
    return name ? name : undefined;
};

/**
 * Whether an svg in figures/ was exported by draw.io. To avoid catching hand-written figures, it
 * checks for traces only draw.io emits: the mxfile copy (content attribute) / the drawio.com
 * fallback <switch> / draw.io CSS variables (`--ge-*`) / an inline `color-scheme` on the root.
 */
export const isDrawioSvg = (raw: string): boolean => {
    if (extractMxfile(raw)) {
        return true;
    }
    if (raw.includes("Text is not SVG - cannot display") || raw.includes("--ge-")) {
        return true;
    }
    const head = rootHead(raw);
    return !!head && /\sstyle="[^"]*color-scheme\s*:/.test(head);
};

// Strip the whole leading prolog. draw.io emits `<?xml?>` → `<!-- Do not edit this file with
// editors other than draw.io -->` → `<!DOCTYPE>` in that order (the .drawio.svg Save format inserts
// the comment), so peel items off until the root <svg> comes first, without assuming kind or order.
const PROLOG_ITEM = /^\s*(?:<\?xml[^>]*\?>|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?>|<!--[\s\S]*?-->)\s*/i;
const stripProlog = (s: string): string => {
    let out = s.replace(/^\uFEFF/, "");
    for (let m = PROLOG_ITEM.exec(out); m; m = PROLOG_ITEM.exec(out)) {
        out = out.slice(m[0].length);
    }
    return out.trim();
};

// For renderers that can't draw foreignObject, draw.io appends a <switch> embedding an <a> link
// to drawio.com. Drop it so shipped figures don't keep a needless external link.
const stripFallbackLink = (s: string): string =>
    s.replace(
        /<switch>\s*<g\s+requiredFeatures="[^"]*"\s*\/>\s*<a\b[^>]*>[\s\S]*?<\/a>\s*<\/switch>/g,
        "",
    );

/** Background the docs side can override (the variable draw.io uses for dark surfaces). */
const DARK_SURFACE = "--ge-dark-color: var(--doc-panel, #161b22)";

/**
 * Remove the `color-scheme` declaration from the root <svg>'s inline style and point only the
 * dark surface color at the docs. If color-scheme stayed, its inline strength would beat
 * figures.ts's theme injection and the figure alone would follow the OS light/dark setting
 * (= not follow the docs theme toggle).
 */
const adaptRootStyle = (markup: string): string => {
    const open = markup.indexOf(">");
    if (!markup.startsWith("<svg") || open < 0) {
        return markup;
    }
    const head = markup.slice(0, open);
    const rest = markup.slice(open);
    const m = /\sstyle="([^"]*)"/.exec(head);
    if (!m) {
        return `${head} style="${DARK_SURFACE}"${rest}`;
    }
    const decls = (m[1] ?? "")
        .split(";")
        .map((d) => d.trim())
        .filter((d) => d && !/^color-scheme\s*:/i.test(d));
    decls.push(DARK_SURFACE);
    return `${head.slice(0, m.index)} style="${decls.join("; ")}"${head.slice(m.index + m[0].length)}${rest}`;
};

export interface DrawioNormalized {
    markup: string;
    /** draw.io page name = figure description (for <desc>). Absent if exported without the copy. */
    desc?: string;
}

/**
 * Normalize a draw.io-exported SVG into an SVG figures.ts can handle. `name` is the figure's name
 * (= the name in figures/<name>.svg, used for <title>Fig.<name></title>).
 * The returned markup is still a raw <svg>…</svg> string; figures.ts goes on to do the theme
 * injection and structural validation.
 */
export const normalizeDrawioSvg = (name: string, raw: string): DrawioNormalized => {
    const mxfile = extractMxfile(raw);

    let markup = stripProlog(raw);
    // Drop the content attribute — editing data doesn't go into the rendered output.
    const headEnd = markup.indexOf(">");
    if (headEnd >= 0) {
        markup = markup.slice(0, headEnd).replace(CONTENT_ATTR, "") + markup.slice(headEnd);
    }
    markup = stripFallbackLink(markup).trim();
    markup = adaptRootStyle(markup);

    // Follow the same convention as hand-written figures: <title> fixed to Fig.<name>, <desc> is
    // the description. The description is the draw.io page name (tab name) — only available from
    // the mxfile copy included in the export.
    //
    // A default page name / no copy is **not an error**. <desc> is optional for figures/*.svg too
    // (parseSvg accepts it missing); a figure without one just falls back to a caption of
    // "Fig.<name>" and still renders = it isn't "unshippable".
    const page = mxfile ? mxfilePageName(mxfile) : undefined;
    const desc = page && !DEFAULT_PAGE_NAMES.has(page.toLowerCase()) ? page : undefined;
    const esc = (v: string): string =>
        v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const open = markup.indexOf(">");
    if (open >= 0) {
        // draw.io doesn't write <title>/<desc>, but drop any existing ones to avoid duplicates.
        const body = markup
            .slice(open + 1)
            .replace(/^\s*<title[^>]*>[\s\S]*?<\/title>/, "")
            .replace(/^\s*<desc[^>]*>[\s\S]*?<\/desc>/, "");
        const meta = `<title>Fig.${esc(name)}</title>${desc ? `<desc>${esc(desc)}</desc>` : ""}`;
        markup = `${markup.slice(0, open + 1)}${meta}${body}`;
    }
    return { markup, desc };
};
