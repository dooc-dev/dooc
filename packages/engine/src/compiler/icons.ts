// A doc's icon (1:1 SVG shown on its sidebar row). It lives at icons/<docId>.svg in the docs root.
// Separate from body-text figures (figures/): one per doc, following the doc's rename / deletion.

import type { ParsedManifest } from "../core/content-metadata.js";
import { docIconFile, type FileLayout } from "../core/files.js";
import { existsSync, readdirSync, readFileSync } from "./host.js";
import { assertNotIgnored, ignoredFiles } from "./ignored-files.js";
import { readTextfile, textfilePath } from "./textfile.js";

export const ICONS_DIR = "icons";

/** Only implicit, unshared icon files belong to a page's lifecycle. */
export const ownsDocIcon = (id: string, manifest: ParsedManifest): boolean => {
    const file = docIconFile(id, manifest.files);
    return (
        !Object.hasOwn(manifest.files?.icons ?? {}, id) &&
        ![
            manifest.icon,
            ...Object.values(manifest.themeIcons ?? {}),
            ...Object.values(manifest.files?.icons ?? {}),
        ].includes(file)
    );
};

const ROOT_SVG_RE = /<svg\b[^>]*>/i;
const num = (v: string | undefined): number | undefined => {
    const n = v == null ? Number.NaN : Number.parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * Normalize an SVG to 1:1 (padding is added automatically = the shorter side is widened, centered;
 * nothing is cropped). Builds a square viewBox from the root's viewBox (or width / height if it has
 * none) and removes fixed width / height (so it scales to the display box). Returns undefined for
 * SVGs whose dimensions can't be read.
 */
export const squareSvg = (svg: string): string | undefined => {
    const root = ROOT_SVG_RE.exec(svg)?.[0];
    if (!root) {
        return undefined;
    }
    const attr = (name: string): string | undefined =>
        new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(root)?.[1];
    const vb = attr("viewBox")
        ?.trim()
        .split(/[\s,]+/)
        .map(Number);
    let [x, y, w, h] =
        vb && vb.length === 4 && vb.every(Number.isFinite)
            ? vb
            : [0, 0, num(attr("width")), num(attr("height"))];
    if (x == null || y == null || w == null || h == null || w <= 0 || h <= 0) {
        return undefined;
    }
    const side = Math.max(w, h);
    x -= (side - w) / 2;
    y -= (side - h) / 2;
    const round = (n: number): number => Math.round(n * 1000) / 1000;
    // Rendered via <img> (data URI), so it won't draw without xmlns — add it if missing.
    const xmlns = /\sxmlns\s*=/.test(root) ? "" : ' xmlns="http://www.w3.org/2000/svg"';
    const next = root
        .replace(/\s(viewBox|width|height|preserveAspectRatio)\s*=\s*(["'])[^"']*\2/gi, "")
        .replace(
            /^<svg\b/i,
            `<svg${xmlns} viewBox="${[x, y, side, side].map(round).join(" ")}" preserveAspectRatio="xMidYMid meet"`,
        );
    return svg.replace(root, next);
};

/** Read icons/ (docId → svg markup). An icon with no doc is an error (missed rename / delete). */
export const loadIcons = (
    root: string,
    docIds: ReadonlySet<string>,
    siteIconFile?: string,
    layout?: FileLayout,
    siteIcons: readonly string[] = [],
): { icons: Map<string, string>; errors: string[] } => {
    const icons = new Map<string, string>();
    const errors: string[] = [];
    let files: string[] = [];
    try {
        const dir = textfilePath(root, ICONS_DIR);
        files = existsSync(dir) ? readdirSync(dir) : [];
    } catch (error) {
        errors.push(`${ICONS_DIR}: ${error}`);
    }
    const ignored = ignoredFiles(
        root,
        files.map((file) => `${ICONS_DIR}/${file}`),
    );
    for (const f of files) {
        if (ignored.has(`${ICONS_DIR}/${f}`)) continue;
        if (f.startsWith(".")) {
            continue;
        }
        const id = f.endsWith(".svg") ? f.slice(0, -4) : "";
        if (!docIds.has(id)) {
            if (siteIconFile?.replace(/^\.\//, "") === `${ICONS_DIR}/${f}`) continue;
            if (
                siteIcons.includes(`${ICONS_DIR}/${f}`) ||
                Object.values(layout?.icons ?? {}).includes(`${ICONS_DIR}/${f}`)
            )
                continue;
            errors.push(`${ICONS_DIR}/${f}: no matching doc (content/${id || f}.md)`);
            continue;
        }
        try {
            const svg = readTextfile(root, `${ICONS_DIR}/${f}`);
            if (!ROOT_SVG_RE.test(svg)) throw new Error("not an svg");
            icons.set(id, svg);
        } catch (error) {
            errors.push(`${ICONS_DIR}/${f}: ${error instanceof Error ? error.message : error}`);
        }
    }
    for (const id of docIds)
        if (layout?.icons?.[id]) {
            try {
                const file = textfilePath(root, docIconFile(id, layout));
                assertNotIgnored(root, docIconFile(id, layout));
                if (!existsSync(file)) continue;
                const svg = readFileSync(file, "utf8");
                if (!ROOT_SVG_RE.test(svg)) throw new Error("not an svg");
                icons.set(id, svg);
            } catch (error) {
                errors.push(`${docIconFile(id, layout)}: ${error}`);
            }
        }
    return { icons, errors };
};
