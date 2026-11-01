// Type contract for the distributed data (artifact/) (browser-safe, no node dependencies). The
// compiler generates it; consumers read what is served via runtime fetch.
//   - artifact/docs.json = DocsArtifact (body AST, terms, figure index; generation-stamped)
//   - artifact/figures/<name>.json = FigureEntry (one figure incl. markup, for lazy fetch)
// Runtime contract: docs-json-schema/<generation>.json; validate via the ./docs-json-schema export.
import type { Block, TocEntry } from "./blocks.js";
import type { Frontmatter } from "./taxonomy.js";

export interface TermEntry {
    /** Stable ID used by explicit :::term(id) references. */
    id: string;
    name: string;
    description?: string;
    /** Definition text (plain text). */
    definition: string;
}

export interface FigureEntry {
    name: string;
    file: string;
    kind: "svg" | "html" | "image";
    /**
     * Full figure content (SVG / HTML fragment / <img> data URI for rasters). Consumers render it
     * inline; MCP can pass it as text.
     */
    markup: string;
    /** By convention "Fig.<name>" (svg = <title>, html = `title:` in the meta comment). */
    title?: string;
    /** Figure description (used both for the displayed caption and as an explanation for LLMs). */
    desc?: string;
}

/** Figure index in docs.json (no markup). The content is lazy-fetched from figures/<name>.json. */
export type FigureIndexEntry = Omit<FigureEntry, "markup">;

// The display name is resolved via docDisplayName (taxonomy.ts).
export type ArtifactDoc = Frontmatter & {
    id: string;
    /** Parent doc id (SoT: manifest.yaml). Omitted = top level. docs[] is in pre-order. */
    parent?: string;
    /** `content/<id>.md`. */
    file: string;
    /** Resolved language (BCP 47): front-matter `lang`, else the site default (language.ts). */
    lang: string;
    /** Sidebar icon (full content of icons/<id>.svg, 1:1). Omitted if there is none. */
    icon?: string;
    /** Source md (excluding front-matter). For MCP / copy; rendering uses blocks. */
    body: string;
    /** Normalized Block AST (the blocks.ts contract). Consumers just map it to rendering. */
    blocks: Block[];
    toc: TocEntry[];
    /** Names of referenced figures (the set to lazy-fetch). */
    refs: { figures: string[]; terms: string[] };
};

export interface DocsArtifact {
    /** Site title declared in manifest.yaml. */
    title?: string;
    /**
     * Dialect / contract generation (generation.ts). Consumers check it directionally with
     * canRenderGeneration.
     */
    generation: number;
    /** Display order (manifest pre-order). The hierarchy is expressed by each doc's parent. */
    docs: ArtifactDoc[];
    /**
     * Terms defined by :::term(id) in content. Only explicit references become links.
     */
    terms: TermEntry[];
    figures: FigureIndexEntry[];
}
