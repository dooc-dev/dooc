// Entry for the script tag (an IIFE bundle with React / React Flow bundled in).
// Published artifact = `dist/flow.global.js` (the package.json build); for preview / edit,
// serve.ts bundles the same entry with esbuild on every request and serves it as
// `/assets/graph.js`. Just loading it makes the doc's schema graphs interactive; it is also
// exposed on window for manual mounting.
// The mount layer (`flow-css.ts`) injects the React Flow stylesheet, so this entry doesn't carry
// it (so the script-tag path and the React-embed path load the same CSS = a single SoT).
import { watchMermaid } from "./mermaid-mount.js";
import { mountSchemaGraphs, watchSchemaGraphs } from "./schema-graph-mount.js";

const start = (): void => {
    const root = document.querySelector("main") ?? document;
    watchSchemaGraphs(root);
    watchMermaid(root);
};

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
    start();
}

// For consumers that want manual control (re-mount / stop).
(
    window as unknown as {
        docsSchemaGraph?: { mount: typeof mountSchemaGraphs; watch: typeof watchSchemaGraphs };
    }
).docsSchemaGraph = { mount: mountSchemaGraphs, watch: watchSchemaGraphs };

export { mountSchemaGraphs, watchSchemaGraphs };
