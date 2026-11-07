import { escapeHtml } from "../core/html.js";
import { type PluginView, validatePluginView } from "../plugins/view.js";

/** Authored HTML cannot run scripts; auto height permits only a nonce-protected reporter. */
export const pluginViewHtml = (input: PluginView): string => {
    const view = validatePluginView(input);
    if (view.format === "html") {
        const auto = view.height === "auto";
        const nonce = auto ? crypto.randomUUID() : "";
        const script = auto
            ? `<script nonce="${nonce}">(()=>{const report=()=>parent.postMessage({doocPluginHeight:Math.ceil(document.body.getBoundingClientRect().height)},"*");new ResizeObserver(report).observe(document.body);report();})()</script>`
            : "";
        const source = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';${auto ? ` script-src 'nonce-${nonce}';` : ""} base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><style>html,body{margin:0}body{display:flow-root}</style></head><body>${view.html}${script}</body></html>`;
        return `<iframe title="Plugin content" sandbox="${auto ? "allow-scripts" : ""}"${auto ? ' data-plugin-auto-height=""' : ""} referrerpolicy="no-referrer" srcdoc="${escapeHtml(source)}" style="width:100%;height:${auto ? 120 : (view.height ?? 240)}px;border:0"></iframe>`;
    }
    switch (view.preset) {
        case "card":
            return `<article class="plugin-card"><strong>${escapeHtml(view.title)}</strong><p>${escapeHtml(view.text)}</p></article>`;
        case "list":
            return `<ul>${view.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
        case "table":
            return `<table><thead><tr>${view.headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${view.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell === null ? "" : String(cell))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
        case "code":
            return `<pre><code>${escapeHtml(JSON.stringify(view.value, null, 2))}</code></pre>`;
    }
};
