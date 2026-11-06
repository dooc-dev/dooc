// Browser-safe content types, parsers and rendering helpers. No project data is bundled.

export * from "./core/blocks.js";
export * from "./core/content-metadata.js";
export type * from "./core/content-types.js";
// Isolated figure rendering (sandboxed iframe) and its parent-side mount (theme following /
// html figure height).
export * from "./core/figure-frame.js";
// node / edge DSL (`grapth`): parse / graph model / deterministic layout via Dagre.
// graph-common.js is the SoT for the geometry parts shared with the schema graph (text width
// estimation / orthogonal routing / uid).
export * from "./core/graph.js";
export * from "./core/graph-common.js";
// Block AST → HTML renderer, shared with the viewer.
export * from "./core/html.js";
export * from "./core/inline.js";
// Language socket: the adapter interface + generic rules, and the built-in Japanese adapter
// (browser-safe part; its prose lint is Node-only and lives in the viewer).
export * from "./core/language.js";
export * from "./core/languages/ja.js";
export * from "./core/previewers.js";
export * from "./core/routing.js";
// table DSL (`schemath`): parse / graph model / deterministic layout. html.ts uses it for
// rendering, and it also serves as the model source when consumers build their own UI
// (interactive graphs etc.).
export * from "./core/schema-graph.js";
// The schema graph's interactive UI (React Flow) requires react, so it is imported not from
// this react-free entry but from the subpath export `./flow` (dist/core/schema-graph-mount.js)
// and, for script tags, `./flow.global.js`.
export * from "./core/taxonomy.js";
export * from "./core/terms-ui.js";
