// In-memory content used by the compiler and renderers (browser-safe).
import type { Block, TocEntry } from "./blocks.js";
import type { SubformatCollection } from "./subformats.js";
import type { Frontmatter } from "./taxonomy.js";

export interface TermEntry {
    /** Root-relative .termth path, or a document position for an inline definition. */
    id: string;
    name: string;
    description?: string;
    /** Definition text (plain text). */
    definition: string;
}

export interface FigureEntry {
    name: string;
    file: string;
    kind: "svg" | "html" | "image" | "video";
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

// The display name is resolved via docDisplayName (taxonomy.ts).
export type CompiledDoc = Frontmatter & {
    id: string;
    subformat?: SubformatCollection;
    /** Parent doc id (SoT: dooc.yaml). Omitted = top level. docs[] is in pre-order. */
    parent?: string;
    /** Project-relative Markdown source path, or subformat:<ext> for a display page. */
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
    /** Referenced figures and terms. */
    refs: { figures: string[]; terms: string[] };
};
