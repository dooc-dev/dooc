// Package entry = core only (docs.json types + the logic that maps it to rendering). No data is
// bundled. Consumers read the artifact/ emitted by the compiler and just map it to rendering
// with the resolution logic + types here.
export type * from "./core/artifact-types.js";
export * from "./core/blocks.js";
export * from "./core/content-metadata.js";
// Isolated figure rendering (sandboxed iframe) and its parent-side mount (theme following /
// html figure height).
export * from "./core/figure-frame.js";
export * from "./core/generation.js";
// node / edge DSL (`:::graph`): parse / graph model / deterministic layout via Dagre.
// graph-common.js is the SoT for the geometry parts shared with the schema graph (text width
// estimation / orthogonal routing / uid).
export * from "./core/graph.js";
export * from "./core/graph-common.js";
// Block AST → HTML renderer (browser-safe, pure). Exported so consumers render the artifact
// they fetch with the same pipeline as the viewer (= prevents rendering-semantics drift).
export * from "./core/html.js";
export * from "./core/inline.js";
// Language socket: the adapter interface + generic rules, and the built-in Japanese adapter
// (browser-safe part; its prose lint is Node-only and lives in the viewer).
export * from "./core/language.js";
export * from "./core/languages/ja.js";
export * from "./core/routing.js";
// table DSL (`:::schema`): parse / graph model / deterministic layout. html.ts uses it for
// rendering, and it also serves as the model source when consumers build their own UI
// (interactive graphs etc.).
export * from "./core/schema-graph.js";
// The schema graph's interactive UI (React Flow) requires react, so it is imported not from
// this react-free entry but from the subpath export `./flow` (dist/core/schema-graph-mount.js)
// and, for script tags, `./flow.global.js`.
export * from "./core/taxonomy.js";
export * from "./core/terms-ui.js";
