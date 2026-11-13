import { type Entities, Helper } from "dxf";
import { escapeHtml } from "../core/escape-html.js";
import { runInNewContext } from "./host.js";

export const dxfSvg = (source: string): string => {
    source = source.replace(/\r\n?/g, "\n").trim();
    if (
        source.includes("\0") ||
        !/^\s*0\s*\nSECTION\s*$/m.test(source) ||
        !/\n\s*0\s*\nEOF$/.test(source)
    )
        throw new Error("Expected an ASCII DXF file");
    // Bound conversion time so malformed geometry cannot stall the synchronous compiler.
    const output: { svg: string; texts: Entities.Text[] } = runInNewContext(
        "render()",
        {
            render: () => {
                const helper = new Helper(source);
                return {
                    svg: helper.toSVG(),
                    texts: helper.parsed?.entities.filter((entity) => entity.type === "TEXT") ?? [],
                };
            },
        },
        { timeout: 2000 },
    );
    const svg = output.svg.replace(/^<\?xml[^>]*>\s*/, "");
    const bounds = /viewBox="([^"]+)"/.exec(svg)?.[1]?.split(/\s+/).map(Number);
    if (
        !bounds ||
        bounds.length !== 4 ||
        !bounds.every(Number.isFinite) ||
        /NaN|Infinity/.test(svg)
    )
        throw new Error("DXF contains no supported 2D geometry");
    const [x = 0, y = 0, width = 0, height = 0] = bounds;
    const geometry = /<(?:path|circle|ellipse)\b/.test(svg);
    let minX = geometry ? x : Number.POSITIVE_INFINITY;
    let minY = geometry ? y : Number.POSITIVE_INFINITY;
    let maxX = geometry ? x + width : Number.NEGATIVE_INFINITY;
    let maxY = geometry ? y + height : Number.NEGATIVE_INFINITY;
    const labels: string[] = [];
    // shortcut: top-level TEXT uses a generic font; use a CAD renderer for block text, MTEXT and native dimensions.
    for (const text of output.texts) {
        if (!text.string || text.visible === false) continue;
        const aligned = text.hAlign || text.vAlign;
        const tx = (aligned ? text.x2 : text.x) ?? text.x ?? 0;
        const ty = -((aligned ? text.y2 : text.y) ?? text.y ?? 0);
        const size = text.textHeight ?? 2.5;
        const rotation = -(text.rotation ?? 0);
        const scale = text.relScaleX ?? 1;
        if (![tx, ty, size, rotation, scale].every(Number.isFinite) || size <= 0 || scale <= 0)
            throw new Error(
                "DXF text requires finite coordinates and a positive height and width scale",
            );
        const value = text.string.replace(/%%c/gi, "⌀").replace(/%%d/gi, "°").replace(/%%p/gi, "±");
        const anchor = text.hAlign === 1 ? "middle" : text.hAlign === 2 ? "end" : "start";
        const baseline =
            ["auto", "text-after-edge", "central", "text-before-edge"][text.vAlign ?? 0] ?? "auto";
        const span = value.length * size * scale;
        const left = anchor === "middle" ? -span / 2 : anchor === "end" ? -span : 0;
        const angle = (rotation / 180) * Math.PI;
        for (const dx of [left, left + span]) {
            for (const dy of [-size, size]) {
                const px = tx + dx * Math.cos(angle) - dy * Math.sin(angle);
                const py = ty + dx * Math.sin(angle) + dy * Math.cos(angle);
                minX = Math.min(minX, px);
                minY = Math.min(minY, py);
                maxX = Math.max(maxX, px);
                maxY = Math.max(maxY, py);
            }
        }
        labels.push(
            `<text transform="translate(${tx} ${ty}) rotate(${rotation}) scale(${scale} 1)" font-family="sans-serif" font-size="${size}" text-anchor="${anchor}" dominant-baseline="${baseline}" fill="var(--doc-fg, #000000)">${escapeHtml(value)}</text>`,
        );
    }
    if (!geometry && !labels.length)
        throw new Error("DXF contains no supported 2D geometry or text");
    const padding = Math.max(maxX - minX, maxY - minY, 1) * 0.04;
    const viewBox = [
        minX - padding,
        minY - padding,
        maxX - minX + padding * 2,
        maxY - minY + padding * 2,
    ];
    if (!viewBox.every(Number.isFinite)) throw new Error("DXF text exceeds finite preview bounds");
    return svg
        .replace(/viewBox="[^"]+"/, `viewBox="${viewBox.join(" ")}"`)
        .replace('width="100%"', 'width="800"')
        .replace(
            /<(path|circle|ellipse)\b/g,
            '<$1 vector-effect="non-scaling-stroke" stroke-width="1.25"',
        )
        .replace(/stroke="(?:#000000|rgb\(0, 0, 0\))"/g, 'stroke="var(--doc-fg, #000000)"')
        .replace("</svg>", () => `${labels.join("")}</svg>`);
};
