export const PLUGIN_BLOCK_CSS = `
.plugin-content :is(th, td) { padding: 6px 8px; text-align: start; border-bottom: 1px solid var(--doc-border, #dde3eb); }
.plugin-content th { background: var(--doc-bg-2, #f6f8fb); color: var(--doc-fg-2, #2a3140); font-size: 12px; font-weight: 600; }
.plugin-content tr:last-child td { border-bottom: 0; }
.plugin-blocks { font: inherit; font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
.plugin-blocks > :first-child, .plugin-block-columns > div > :first-child { margin-top: 0; }
.plugin-blocks .plugin-block-heading { margin: 0 0 8px; padding: 0; border: 0; font: inherit; font-size: 17px; font-weight: 600; line-height: 1.4; color: var(--doc-fg, #000000); }
.plugin-block-text { margin: 8px 0; white-space: pre-wrap; }
.plugin-block-text:has(p, pre, ul, ol) { white-space: normal; }
.plugin-blocks p { margin: 4px 0; white-space: pre-wrap; }
.plugin-blocks :is(ul, ol) { margin: 6px 0; padding-left: 22px; }
.plugin-blocks > :last-child { margin-bottom: 0; }
.plugin-blocks strong { font-weight: 600; }
.plugin-blocks a { color: var(--doc-accent, #1b4994); text-underline-offset: 3px; }
.plugin-blocks code { font-family: var(--doc-mono, ui-monospace, monospace); }
.plugin-block-context { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; margin: 6px 0; color: var(--doc-fg-3, #5b6271); font-size: 11px; }
.plugin-block-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 6px 16px; margin: 8px 0; }
.plugin-block-fields > div { min-width: 0; }
.plugin-block-fields dt { color: var(--doc-fg-3, #5b6271); font-size: 10px; margin-bottom: 1px; }
.plugin-block-fields dd { margin: 0; min-height: 20px; font-size: 12px; }
.plugin-block-columns { display: grid; grid-template-columns: minmax(0, 1fr) 180px; gap: 16px; }
.plugin-block-columns > div, .plugin-block-columns aside { min-width: 0; }
.plugin-block-columns aside { border-left: 1px solid var(--doc-border, #dde3eb); padding-left: 12px; }
.plugin-block-columns aside .plugin-block-fields { grid-template-columns: 1fr; margin-top: 0; }
.plugin-block-section { border-top: 1px solid var(--doc-border, #dde3eb); padding-top: 6px; margin: 10px 0 0; min-width: 0; }
.plugin-block-section > summary { cursor: pointer; font-size: 12px; font-weight: 600; color: var(--doc-fg-2, #2a3140); padding: 4px 0; }
.plugin-block-note { color: var(--doc-warn, #b97600); font-size: 11px; border-left: 2px solid currentColor; padding-left: 10px; }
.plugin-block-table { overflow: auto; width: 100%; margin: 8px 0; }
.plugin-block-table table { width: 100%; border-collapse: collapse; font-size: 12px; }
.plugin-block-table :is(th, td) { padding: 5px 8px; min-width: 72px; max-width: 320px; vertical-align: top; }
.plugin-blocks .plugin-block-code { font: 12px/1.65 var(--doc-mono, ui-monospace, monospace); padding: 12px; margin: 10px 0; border: 1px solid var(--doc-border, #dde3eb); border-radius: 6px; max-height: 400px; overflow: auto; white-space: pre-wrap; }
.plugin-block-diff code > span { display: inline-block; min-width: 100%; }
.plugin-block-diff [data-tone="success"] { color: var(--doc-ok, #1f7a32); background: color-mix(in srgb, var(--doc-ok, #1f7a32) 8%, transparent); }
.plugin-block-diff [data-tone="danger"] { color: var(--doc-danger, #b53030); background: color-mix(in srgb, var(--doc-danger, #b53030) 8%, transparent); }
.plugin-block-message { padding: 8px 0; border-bottom: 1px solid var(--doc-border, #dde3eb); }
.plugin-block-message:last-child { border-bottom: 0; }
.plugin-message-byline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.plugin-message-byline > span:not(.plugin-avatar, .plugin-message-actions) { color: var(--doc-fg-3, #5b6271); font-size: 10px; }
.plugin-avatar { display: grid; place-items: center; width: 24px; height: 24px; flex: none; border-radius: 7px; color: var(--doc-accent, #1b4994); background: color-mix(in srgb, var(--doc-accent, #1b4994) 12%, var(--doc-bg, #ffffff)); font-size: 10px; }
.plugin-task { display: flex; align-items: baseline; gap: 8px; list-style: none; }
.plugin-message-actions svg { display: block; width: 14px; height: 14px; }
.plugin-message-actions .plugin-block-button { padding: 4px; border: 0; color: var(--doc-fg-3, #5b6271); }
.plugin-message-actions { margin-left: auto; display: flex; gap: 4px; }
.plugin-message-body, .plugin-reactions { margin: 4px 0 0 32px; }
.plugin-reactions { display: flex; flex-wrap: wrap; gap: 5px; font-size: 11px; }
.plugin-reactions button { font: inherit; padding: 2px 8px; border: 1px solid var(--doc-border, #dde3eb); border-radius: 12px; background: transparent; color: var(--doc-fg-2, #2a3140); cursor: pointer; }
.plugin-reactions [aria-pressed="true"] { border-color: var(--doc-accent, #1b4994); color: var(--doc-accent, #1b4994); background: color-mix(in srgb, var(--doc-accent, #1b4994) 8%, transparent); }
.plugin-badge { display: inline-flex; padding: 1px 7px; border-radius: 5px; font-size: 11px; color: var(--doc-fg-2, #2a3140); background: var(--doc-bg-2, #f6f8fb); }
.plugin-badge[data-tone="accent"] { color: var(--doc-accent, #1b4994); background: color-mix(in srgb, var(--doc-accent, #1b4994) 10%, var(--doc-bg, #ffffff)); }
.plugin-badge[data-tone="success"] { color: var(--doc-ok, #1f7a32); background: color-mix(in srgb, var(--doc-ok, #1f7a32) 10%, var(--doc-bg, #ffffff)); }
.plugin-badge[data-tone="warning"] { color: var(--doc-warn, #b97600); background: color-mix(in srgb, var(--doc-warn, #b97600) 10%, var(--doc-bg, #ffffff)); }
.plugin-badge[data-tone="danger"] { color: var(--doc-danger, #b53030); background: color-mix(in srgb, var(--doc-danger, #b53030) 10%, var(--doc-bg, #ffffff)); }
.plugin-copy-value { display: inline-flex; align-items: center; gap: 3px; max-width: 100%; }
.plugin-copy { width: 22px; height: 22px; padding: 3px; border: 0; background: transparent; color: var(--doc-fg-3, #5b6271); cursor: pointer; flex: none; }
.plugin-copy svg { width: 14px; height: 14px; }
.plugin-block-progress { display: flex; align-items: center; gap: 10px; font-size: 11px; color: var(--doc-fg-3, #5b6271); margin: 12px 0; }
.plugin-block-progress progress { flex: 1; width: 0; height: 6px; accent-color: var(--doc-accent, #1b4994); }
.plugin-block-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
.plugin-block-actions:has([data-block-composer]) { display: block; }
.plugin-block-button { font: inherit; font-size: 12px; padding: 5px 10px; border: 1px solid var(--doc-border, #dde3eb); border-radius: 5px; color: var(--doc-fg, #000000); background: transparent; cursor: pointer; }
.plugin-block-button:hover { background: var(--doc-bg-2, #f6f8fb); }
.plugin-block-button:disabled { opacity: .5; cursor: wait; }
.plugin-action[aria-pressed="true"] { color: var(--doc-accent, #1b4994); background: var(--doc-bg-2, #f6f8fb); }
.plugin-danger { color: var(--doc-danger, #b53030); }
.plugin [data-plugin-edit-trigger]:focus-visible, .plugin :is(button, summary, input, select, textarea):focus-visible, .plugin-block-table:focus-visible { outline: 2px solid var(--doc-accent, #1b4994); outline-offset: 2px; }
.plugin-editor { display: grid; gap: 6px; margin: 0; padding: 0; border: 0; font: inherit; font-size: 12px; line-height: 1.5; color: var(--doc-fg, #000000); background: var(--doc-bg, #ffffff); min-width: 0; }
.plugin-editor label { display: grid; gap: 0; font-size: 0; }
.plugin-editor :is(input, textarea, select) { box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%; padding: 3px 6px; border: 1px solid var(--doc-border, #dde3eb); border-radius: 4px; color: var(--doc-fg, #000000); background: var(--doc-bg, #ffffff); font: inherit; font-size: 12px; line-height: 1.5; }
.plugin-editor textarea { resize: vertical; min-height: 54px; max-height: 40vh; }
.plugin-editor .plugin-submit { background: var(--doc-accent, #1b4994); color: var(--doc-accent-fg, #ffffff); border-color: transparent; }
.plugin-editor-notice { color: var(--doc-danger, #b53030); font-size: 11px; }
.plugin-editor-notice:empty { display: none; }
.plugin [hidden] { display: none !important; }
@container (max-width: 600px) {
  .plugin-block-columns { grid-template-columns: minmax(0, 1fr); gap: 14px; }
  .plugin-block-columns aside { border-left: 0; border-top: 1px solid var(--doc-border, #dde3eb); padding: 14px 0 0; }
  .plugin-block-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .plugin-heading-context { display: none; }
  .plugin-blocks .plugin-block-heading { font-size: 16px; }
  .plugin-message-body, .plugin-reactions { margin-left: 0; }
}
`;
