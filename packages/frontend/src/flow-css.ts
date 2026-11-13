// Layer that lets the mount layer inject the schema graph (React Flow) stylesheet itself.
// Without its plain CSS, React Flow loses both the absolute positioning of nodes and the
// placement of Controls / MiniMap (the figure collapses to just the dotted background), so
// consumers importing the `./flow` subpath aren't asked to ship the CSS (React embedding meets
// the same conditions as the global bundle).
//
// Only **base.css (structure only)** is included; React Flow's default theme (style.css) is not
// used: this repo's convention is that colors come from the `--doc-*` variables the consumer
// injects (same as `var(--doc-*)` in figures). Including the default theme would mix light-only
// chrome into dark-theme docs and clash with the caller's palette.
// Only what inline styles can't reach (the Controls buttons = plain `<button>`) is patched,
// scoped under `.doc-sg-flow` so that a React Flow the consumer uses separately isn't affected.
import { XYFLOW_BASE_CSS } from "./flow-base-css.generated.js";

export const FLOW_STYLE_ID = "doc-sg-flow-css";

const THEME_CSS = `
.doc-sg-flow .react-flow__controls {
    border-radius: 6px;
    overflow: hidden;
    box-shadow: 0 1px 3px color-mix(in srgb, var(--doc-fg, #000000) 14%, transparent);
}
.doc-sg-flow .react-flow__controls-button {
    border: none;
    border-bottom: 1px solid var(--doc-border, #dde3eb);
    background: var(--doc-panel, #ffffff);
    color: var(--doc-fg-3, #5b6271);
    cursor: pointer;
}
.doc-sg-flow .react-flow__controls-button:last-child {
    border-bottom: none;
}
.doc-sg-flow .react-flow__controls-button:hover {
    background: color-mix(in srgb, var(--doc-fg, #000000) 7%, var(--doc-panel, #ffffff));
    color: var(--doc-fg, #000000);
}
.doc-sg-flow .react-flow__controls-button:disabled {
    opacity: 0.45;
}
`;

/** Full text of the injected stylesheet (base.css + extra rules that map onto `--doc-*`). */
export const SCHEMA_GRAPH_FLOW_CSS = `${XYFLOW_BASE_CSS}${THEME_CSS}`;

/**
 * Injected once, when a graph is first mounted (no-op if already present).
 * Placed at the start of head = laid down as a base layer weaker than the consumer's
 * stylesheets, so it doesn't override the caller's CSS (theme / its own React Flow usage).
 */
export const injectSchemaGraphCss = (doc: Document): void => {
    if (doc.getElementById(FLOW_STYLE_ID) != null) {
        return;
    }
    const style = doc.createElement("style");
    style.id = FLOW_STYLE_ID;
    style.textContent = SCHEMA_GRAPH_FLOW_CSS;
    doc.head.prepend(style);
};
