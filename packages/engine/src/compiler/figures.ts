import type { FigureEntry } from "../core/content-types.js";
import { escapeHtml } from "../core/escape-html.js";
import { extractMxfile, isDrawioSvg, normalizeDrawioSvg } from "./drawio.js";
import { dxfSvg } from "./dxf.js";
// figures/ = the SoT for HTML-based Figs (figures). Two formats:
//   - <name>.svg  : self-contained SVG (xmlns + viewBox + <title>Fig.<name></title> +
//                   optional <desc>description</desc>)
//   - <name>.html : self-contained HTML fragment (leading <!--fig title/desc --> meta comment,
//                   styles such as CSS animations bundled in <style>, no scripts)
// Both use var(--doc-*, fallback) for colors (follows the theme + works standalone). Content
// references them via `![alt text](figures/<file>)` (png / webp / jpeg become
// data-URI <img>s).
//
// Figures drawn in draw.io live in the same figures/. Two ways to place them; in both, name is
// the stem without the extension:
//   - <name>.drawio.svg : output of draw.io's File > Save as (Editable SVG). Carries an mxfile
//                         copy (content=), so **one file is both editing source and output**
//                         (open in draw.io and Save to update; no re-export needed). Error if
//                         there's no mxfile
//   - <name>.svg        : output of File > Export as > SVG (the editing source can live
//                         anywhere). isDrawioSvg tells whether it's from draw.io (it coexists
//                         with hand-written figures)
// Both go through drawio.ts normalization (stripping prolog / mxfile copy / external links,
// injecting title) before the same validation as hand-written SVGs. Colors stay in draw.io's
// scheme (see the top of drawio.ts).
import { basename, createHash, dirname, readdirSync, readFileSync } from "./host.js";
import { assertNotIgnored, ignoredFiles } from "./ignored-files.js";
import { textfilePath } from "./textfile.js";

const EXT_RE = /\.(drawio\.svg|svg|html|png|webp|gif|mp4|webm|jpe?g|pdf|dxf)$/i;
const FILE_RE = /^[a-z0-9][a-z0-9_-]*\.(drawio\.svg|svg|html|png|webp|gif|mp4|webm|jpe?g|pdf|dxf)$/;
const IMAGE_MIME: Record<string, string> = {
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
};

/** File relative to figures/ → the figure's registered name (stem without the extension). */
export const figureName = (file: string): string =>
    !FILE_RE.test(file.replace(/^figures\//, ""))
        ? `file-${createHash("sha256").update(file).digest("hex").slice(0, 24)}`
        : file.replace(/^figures\//, "").replace(EXT_RE, "");

/**
 * Original file name of a figure added from the editing UI → a name following the figures/
 * convention (svg / drawio.svg / html / raster). The stem is coerced to lowercase alphanumerics
 * and _-, or "figure" if nothing remains. Unsupported extensions yield undefined.
 */
export const figureUploadName = (raw: string): string | undefined => {
    const lower = raw.toLowerCase().split(/[\\/]/).pop() ?? "";
    const ext = EXT_RE.exec(lower)?.[1];
    if (ext == null) {
        return undefined;
    }
    const stem = lower
        .slice(0, -ext.length - 1)
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^[^a-z0-9]+|-+$/g, "");
    return `${stem || "figure"}.${ext}`;
};

export type { FigureEntry } from "../core/content-types.js";

const LIGHT_VARS =
    "--doc-bg:#ffffff;--doc-bg-2:#f6f8fb;--doc-bg-3:#eef2f7;--doc-panel:#ffffff;--doc-panel-2:#f1f5fa;--doc-rail:#f3f6fa;--doc-border:#dde3eb;--doc-border-2:#c4ccd8;--doc-fg:#000000;--doc-fg-2:#2a3140;--doc-fg-3:#5b6271;--doc-fg-4:#9099a8;--doc-accent:#1b4994;--doc-accent-2:#0277bd;--doc-accent-fg:#ffffff;--doc-ok:#1f7a32;--doc-ok-2:#2ea043;--doc-warn:#b97600;--doc-warn-2:#f59f00;--doc-danger:#b53030;--doc-danger-2:#f04848;--doc-info:#0277bd;--doc-info-2:#4a8bff;";
const DARK_VARS =
    "--doc-bg:#000000;--doc-bg-2:#0a0d12;--doc-bg-3:#11161c;--doc-panel:#161b22;--doc-panel-2:#1e2530;--doc-rail:#0d1117;--doc-border:#222831;--doc-border-2:#323a47;--doc-fg:#ffffff;--doc-fg-2:#c9d1d9;--doc-fg-3:#8b939e;--doc-fg-4:#525a66;--doc-accent:#4a8bff;--doc-accent-2:#1b4994;--doc-accent-fg:#ffffff;--doc-ok:#2ea043;--doc-ok-2:#56d364;--doc-warn:#f59f00;--doc-warn-2:#ffc14d;--doc-danger:#f04848;--doc-danger-2:#ff7a7a;--doc-info:#4a8bff;--doc-info-2:#79b0ff;";
const FIGURE_THEME_STYLE = `<style data-doc-figure-theme>[data-doc-figure]{color-scheme:light;${LIGHT_VARS}}@media (prefers-color-scheme: dark){[data-doc-figure]{color-scheme:dark;${DARK_VARS}}}:root[data-theme="light"] [data-doc-figure],[data-doc-theme="light"] [data-doc-figure],[data-doc-figure][data-doc-theme="light"]{color-scheme:light;${LIGHT_VARS}}:root[data-theme="dark"] [data-doc-figure],[data-doc-theme="dark"] [data-doc-figure],[data-doc-figure][data-doc-theme="dark"]{color-scheme:dark;${DARK_VARS}}</style>`;

const firstTag = (svg: string, tag: "title" | "desc"): string | undefined => {
    const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(svg);
    return m ? m[1]?.replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim() : undefined;
};

const HTML_META_RE = /^<!--fig\n([\s\S]*?)-->\n?/;

const normalizeHardcodedSurfaces = (markup: string): string =>
    markup
        .replace(
            /background-color:\s*#fff(?:fff)?(?=[;}])/gi,
            "background-color:var(--doc-panel, #ffffff)",
        )
        .replace(/background:\s*#fff(?:fff)?(?=[;}])/gi, "background:var(--doc-panel, #ffffff)");

const withSvgTheme = (markup: string): string => {
    const headEnd = markup.indexOf(">");
    if (headEnd < 0) {
        return markup;
    }
    const head = markup.slice(0, headEnd);
    const taggedHead = head.includes("data-doc-figure") ? head : `${head} data-doc-figure=""`;
    return `${taggedHead}>${FIGURE_THEME_STYLE}${markup.slice(headEnd + 1)}`;
};

const withHtmlTheme = (markup: string): string => {
    const themed = normalizeHardcodedSurfaces(markup);
    if (themed.includes("data-doc-figure") || !themed.startsWith("<")) {
        return themed;
    }
    // A fragment can start with <style>; keep the theme outside authored elements.
    return `<div data-doc-figure="">${FIGURE_THEME_STYLE}${themed}</div>`;
};

const parseSvg = (
    file: string,
    raw: string,
    errors: string[],
): Omit<FigureEntry, "name" | "file"> => {
    const markup = withSvgTheme(normalizeHardcodedSurfaces(raw.trim()));
    if (!markup.startsWith("<svg") || !markup.endsWith("</svg>")) {
        errors.push(`${file}: a single root <svg>…</svg> is required`);
    }
    const head = markup.slice(0, markup.indexOf(">"));
    if (!head.includes("xmlns=")) {
        errors.push(`${file}: root <svg> requires xmlns (for standalone publishing)`);
    }
    if (!head.includes("viewBox=")) {
        errors.push(`${file}: root <svg> requires viewBox (to scale with the width)`);
    }
    return {
        kind: "svg",
        markup,
        title: firstTag(markup, "title"),
        desc: firstTag(markup, "desc"),
    };
};

const parseHtml = (
    file: string,
    raw: string,
    errors: string[],
): Omit<FigureEntry, "name" | "file"> => {
    const m = HTML_META_RE.exec(raw);
    if (!m) {
        errors.push(`${file}: a <!--fig\\ntitle: ...\\n--> meta comment is required at the top`);
        return { kind: "html", markup: raw.trim() };
    }
    const meta = new Map(
        (m[1] ?? "")
            .split("\n")
            .filter((l) => l.includes(":"))
            .map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]),
    );
    const markup = withHtmlTheme(raw.slice(m[0].length).trim());
    if (!meta.get("title")) {
        errors.push(`${file}: the meta comment requires title:`);
    }
    if (!markup.startsWith("<")) {
        errors.push(`${file}: the meta comment must be followed by an HTML fragment`);
    }
    if (/<script/i.test(markup)) {
        errors.push(`${file}: <script> is not allowed (self-contained static fragments only)`);
    }
    return { kind: "html", markup, title: meta.get("title"), desc: meta.get("desc") };
};

export const loadFigures = (
    figuresDir: string,
    extraFiles: string[] = [],
): { figures: FigureEntry[]; errors: string[] } => {
    const errors: string[] = [];
    const figures: FigureEntry[] = [];
    const root = dirname(figuresDir);
    let files: string[] = [];
    try {
        files = readdirSync(textfilePath(root, basename(figuresDir)))
            .filter((f) => EXT_RE.test(f))
            .sort();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            errors.push(`figures/: ${error instanceof Error ? error.message : error}`);
    }
    files = [...new Set([...files.map((file) => `figures/${file}`), ...extraFiles])];
    const ignored = ignoredFiles(dirname(figuresDir), files);
    const keyframeOwner = new Map<string, { file: string; body: string }>();
    for (const file of files) {
        if (ignored.has(file)) continue;
        if (
            file.startsWith("figures/") &&
            !file.slice(8).includes("/") &&
            !FILE_RE.test(file.slice(8))
        ) {
            errors.push(
                `${file}: file name must be <name>.<extension> using [a-z0-9_-] and a supported image, html, video, pdf or dxf extension`,
            );
            continue;
        }
        const name = figureName(file);
        const dup = figures.find((f) => f.name === name);
        if (dup) {
            errors.push(`${file}: duplicate name "${name}" (also used by ${dup.file})`);
            continue;
        }
        let path: string;
        try {
            const relative = file.startsWith("figures/")
                ? `${basename(figuresDir)}/${file.slice(8)}`
                : file;
            path = textfilePath(root, relative);
            assertNotIgnored(root, relative);
        } catch (error) {
            errors.push(`${file}: ${error instanceof Error ? error.message : error}`);
            continue;
        }
        if (/\.(pdf|dxf)$/i.test(file)) {
            try {
                const data = readFileSync(path);
                if (/\.dxf$/i.test(file)) {
                    const raw = new TextDecoder("utf-8", { fatal: true }).decode(data);
                    figures.push({ name, file, ...parseSvg(file, dxfSvg(raw), errors) });
                } else {
                    if (data.subarray(0, 5).toString("ascii") !== "%PDF-")
                        throw new Error("Expected a PDF file beginning with %PDF-");
                    const uri = `data:application/pdf;base64,${data.toString("base64")}`;
                    const download = `<a href="${uri}" download="${escapeHtml(file.split("/").at(-1) ?? "document.pdf")}" data-i18n="Download PDF">Download PDF</a>`;
                    figures.push({
                        name,
                        file,
                        kind: "pdf",
                        markup: `<object type="application/pdf" data="${uri}" aria-label="PDF preview" style="display:block;width:100%;height:640px;max-height:80vh;min-height:320px">${download}</object>${download}`,
                    });
                }
            } catch (error) {
                errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
            }
            continue;
        }
        if (/\.(mp4|webm)$/i.test(file)) {
            const data = readFileSync(path);
            figures.push({
                name,
                file,
                kind: "video",
                markup: `<video data-dooc-video controls playsinline preload="metadata" aria-label="Video preview" src="data:video/${file.toLowerCase().endsWith(".mp4") ? "mp4" : "webm"};base64,${data.toString("base64")}"></video>`,
            });
            continue;
        }
        const mime = IMAGE_MIME[file.slice(file.lastIndexOf(".") + 1).toLowerCase()];
        if (mime != null) {
            // Rasters are inlined as data URIs; Markdown embeds supply their alternative text.
            const data = readFileSync(path).toString("base64");
            figures.push({
                name,
                file,
                kind: "image",
                markup: `<img src="data:${mime};base64,${data}" alt="${name}">`,
            });
            continue;
        }
        const raw = readFileSync(path, "utf8");
        // The point of .drawio.svg is "can be reopened in draw.io", so the mxfile copy is required
        // (rejects an Export as > SVG output without the copy that was merely renamed).
        const editable = file.toLowerCase().endsWith(".drawio.svg");
        if (editable && !extractMxfile(raw)) {
            errors.push(
                `${file}: .drawio.svg doubles as the editable source, so it requires a copy of the mxfile (content=) (save it as .drawio.svg via File > Save as in draw.io)`,
            );
        }
        const parsed = file.toLowerCase().endsWith(".svg")
            ? parseSvg(
                  file,
                  editable || isDrawioSvg(raw) ? normalizeDrawioSvg(name, raw).markup : raw,
                  errors,
              )
            : parseHtml(file, raw, errors);
        if (/var\(--doc-[a-z0-9-]+\)/.test(parsed.markup)) {
            errors.push(
                `${file}: contains var(--doc-*) without a fallback (use the var(--doc-x, #hex) form)`,
            );
        }
        // @keyframes names must not collide when several figures are inlined on one page.
        // The same name with an identical body is harmless (e.g. xyflow's dashdraw, present in
        // every capture figure), so that's allowed.
        for (const km of parsed.markup.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)\s*\{/g)) {
            const kname = km[1] ?? "";
            let depth = 1;
            let i = (km.index ?? 0) + km[0].length;
            while (i < parsed.markup.length && depth > 0) {
                const ch = parsed.markup[i];
                depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
                i += 1;
            }
            const body = parsed.markup.slice((km.index ?? 0) + km[0].length, i).replace(/\s+/g, "");
            const key = `${kname}`;
            const owner = keyframeOwner.get(key);
            if (owner && owner.file !== file && owner.body !== body) {
                errors.push(
                    `${file}: @keyframes "${kname}" conflicts with a different definition in ${owner.file}`,
                );
            }
            keyframeOwner.set(key, { file, body });
        }
        figures.push({
            name,
            file,
            ...parsed,
        });
    }
    return { figures, errors };
};
