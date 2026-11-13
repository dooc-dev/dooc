import type { Root, RootContent } from "mdast";
import {
    type PluginBlock,
    type PluginEdit,
    type PluginInline,
    pluginLink,
} from "../../../plugins/src/blocks.js";
import { escapeHtml } from "../../engine/src/core/escape-html.js";
import { parseMdast } from "../../engine/src/core/markdown.js";

const link = (url: string, html: string) =>
    pluginLink(url)
        ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${html}</a>`
        : html;
const markdownNode = (node: Root | RootContent): string => {
    const children =
        "children" in node
            ? node.children.map((child) => markdownNode(child as RootContent)).join("")
            : "";
    switch (node.type) {
        case "root":
            return children;
        case "text":
        case "html":
            return escapeHtml(node.value);
        case "paragraph":
            return `<p>${children}</p>`;
        case "heading":
            return `<strong class="plugin-markdown-heading">${children}</strong>`;
        case "strong":
            return `<strong>${children}</strong>`;
        case "emphasis":
            return `<em>${children}</em>`;
        case "delete":
            return `<del>${children}</del>`;
        case "inlineCode":
            return `<code>${escapeHtml(node.value)}</code>`;
        case "code":
            return `<pre><code>${escapeHtml(node.value)}</code></pre>`;
        case "link":
            return link(node.url, children);
        case "image":
            return escapeHtml(node.alt ?? "");
        case "list":
            return node.ordered ? `<ol>${children}</ol>` : `<ul>${children}</ul>`;
        case "listItem": {
            const body = node.children
                .map((child) =>
                    child.type === "paragraph"
                        ? child.children.map(markdownNode).join("")
                        : markdownNode(child),
                )
                .join("");
            return node.checked === null || node.checked === undefined
                ? `<li>${body}</li>`
                : `<li class="plugin-task"><span aria-label="${node.checked ? "Completed" : "Incomplete"}">${node.checked ? "☑" : "☐"}</span><div>${body}</div></li>`;
        }
        case "blockquote":
            return `<blockquote>${children}</blockquote>`;
        case "break":
            return "<br>";
        case "thematicBreak":
            return "<hr>";
        default:
            return children;
    }
};
export const pluginMarkdown = (text: string): string => markdownNode(parseMdast(text));
const binding = (edit?: PluginEdit) =>
    edit ? ` data-block-edit="${escapeHtml(JSON.stringify(edit))}"` : "";
const inline = (value: PluginInline): string => {
    if (typeof value === "string") return `<span>${escapeHtml(value)}</span>`;
    let html = escapeHtml(value.text);
    if (value.code) html = `<code>${html}</code>`;
    if (value.strong) html = `<strong>${html}</strong>`;
    if (value.url) html = link(value.url, html);
    if (value.tone) html = `<span class="plugin-badge" data-tone="${value.tone}">${html}</span>`;
    if (value.copy !== undefined)
        html = `<span class="plugin-copy-value">${html}<button type="button" class="plugin-copy" data-block-copy="${escapeHtml(value.copy)}" aria-label="Copy" title="Copy" data-i18n-aria-label="Copy" data-i18n-title="Copy"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M13 4V3H3v10h1"/></svg></button></span>`;
    return html;
};
const inlines = (items: PluginInline[]) => items.map(inline).join(" ");
const actions = (ids: string[], composer = false) =>
    ids
        .map(
            (id) =>
                `<span data-block-action="${escapeHtml(id)}"${composer ? ' data-block-composer=""' : ""}></span>`,
        )
        .join("");

export const pluginBlocksHtml = (blocks: PluginBlock[]): string =>
    blocks
        .map((block) => {
            switch (block.type) {
                case "heading":
                    return `<h3 class="plugin-block-heading"${binding(block.edit)}>${escapeHtml(block.text)}</h3>`;
                case "text":
                    return `<div class="plugin-block-text"${binding(block.edit)}>${block.markdown ? pluginMarkdown(block.text) : escapeHtml(block.text) || "—"}</div>`;
                case "context":
                    return `<div class="plugin-block-context">${inlines(block.items)}</div>`;
                case "fields":
                    return `<dl class="plugin-block-fields">${block.items.map((item) => `<div><dt>${escapeHtml(item.label)}</dt><dd${binding(item.edit)}>${inlines(item.items) || "—"}</dd></div>`).join("")}</dl>`;
                case "columns":
                    return `<div class="plugin-block-columns"><div>${pluginBlocksHtml(block.main)}</div><aside>${pluginBlocksHtml(block.aside)}</aside></div>`;
                case "section":
                    return `<details class="plugin-block-section"${block.collapsed ? "" : " open"}><summary>${escapeHtml(block.title)}</summary>${block.note ? `<p class="plugin-block-note">${escapeHtml(block.note)}</p>` : ""}${pluginBlocksHtml(block.blocks)}</details>`;
                case "table":
                    return `<div class="plugin-block-table" tabindex="0" role="region" aria-label="Table" data-i18n-aria-label="Table"><table><thead><tr>${block.headers.map((h) => `<th scope="col">${escapeHtml(h)}</th>`).join("")}${block.rows.some((r) => r.actions?.length) ? '<th scope="col" aria-label="Actions" data-i18n-aria-label="Actions"></th>' : ""}</tr></thead><tbody>${block.rows.map((row) => `<tr>${row.cells.map((c) => `<td${binding(c.edit)}>${inlines(c.items) || "—"}</td>`).join("")}${block.rows.some((r) => r.actions?.length) ? `<td>${actions(row.actions ?? [])}</td>` : ""}</tr>`).join("")}</tbody></table></div>`;
                case "code":
                    return `<div${binding(block.edit)}><pre class="plugin-block-code${block.diff ? " plugin-block-diff" : ""}"><code>${
                        block.diff
                            ? block.text
                                  .split("\n")
                                  .map(
                                      (line) =>
                                          `<span data-tone="${line.startsWith("+") ? "success" : line.startsWith("-") ? "danger" : "neutral"}">${escapeHtml(line)}</span>`,
                                  )
                                  .join("\n")
                            : escapeHtml(block.text)
                    }</code></pre></div>`;
                case "message":
                    return `<div class="plugin-block-message"><div class="plugin-message-byline"><span class="plugin-avatar" aria-hidden="true">${escapeHtml(block.author.slice(0, 2).toUpperCase())}</span><strong>${escapeHtml(block.author)}</strong>${block.time ? `<span>${escapeHtml(block.time)}</span>` : ""}<span class="plugin-message-actions">${actions(block.actions ?? [])}</span></div><div class="plugin-message-body"${binding(block.edit)}>${pluginMarkdown(block.text) || "—"}</div>${block.reactions?.length ? `<div class="plugin-reactions">${block.reactions.map((r) => (r.action ? `<button type="button" data-block-action="${escapeHtml(r.action)}" data-block-values="${escapeHtml(JSON.stringify(r.values ?? {}))}" aria-pressed="${!!r.active}" title="${escapeHtml(r.label)}">${escapeHtml(r.label)} ${r.count}</button>` : `<span>${escapeHtml(r.label)} ${r.count}</span>`)).join("")}</div>` : ""}</div>`;
                case "actions":
                    return `<div class="plugin-block-actions">${actions(block.ids, block.composer)}</div>`;
                case "progress":
                    return `<div class="plugin-block-progress"><progress max="100" value="${block.value}" aria-label="${escapeHtml(block.label)}"></progress><span>${escapeHtml(block.label)} ${block.value}%</span></div>`;
                case "divider":
                    return "<hr>";
                default:
                    throw new Error("Invalid plugin block");
            }
        })
        .join("");
