import type { TermEntry } from "./content-types.js";
// Browser-safe rendering model, converted from Markdown by from-mdast.ts.
// Inline strings retain standard Markdown; inline.ts parses them for rendering.
import type { GraphModel } from "./graph.js";
import type { SchemaModel } from "./schema-graph.js";
import type { CodeLang } from "./taxonomy.js";

/** Nestable list item. string = leaf, object = has children. ordered = whether the children are
 * numbered (irrelevant for childless leaves). */
export type ListItem =
    | string
    | { text: string; children: ListItem[]; ordered?: boolean }
    | { blocks: Block[] };

/** One element of a callout body. Paragraphs / lists can be mixed in any order. */
export type CalloutItem =
    | { type: "p"; text: string }
    | { type: "list"; items: ListItem[]; ordered?: boolean };

export type Block = { sourceFile?: string } & (
    | { type: "themeVariants"; default: Block; variants: Record<string, Block> }
    | { type: "external"; url: string; alt?: string }
    | { type: "p"; text: string }
    | { type: "quote"; blocks: Block[] }
    // slug is derived from the heading text and filled in by the build (shared with the TOC, no
    // duplicate declaration). Level 1 (`#` in body text) is a separate heading independent of the
    // manifest title's h1 (multiple h1s are allowed in body text).
    | { type: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string; slug: string }
    // ordered omitted/false = bulleted list (`<ul>`), true = numbered (`<ol>`, md `1.` syntax).
    | { type: "list"; items: ListItem[]; ordered?: boolean }
    | {
          type: "code";
          lines: string[];
          lang?: CodeLang;
          filename?: string;
          range?: string;
          tableMode?: "header";
          alt?: string;
          unavailable?: "missing" | "unreachable";
      }
    | {
          type: "table";
          dataSource?: string;
          tableMode?: "header";
          headers: string[];
          rows: string[][];
          alt?: string;
          caption?: string;
          collapsible?: boolean;
      }
    | { type: "callout"; title?: string; alt?: string; body: CalloutItem[] }
    // Markdown embeds supply alt text; explicit captions belong to programmatic figures.
    | { type: "figureRef"; name: string; alt?: string; caption?: string }
    | { type: "term"; entry: TermEntry }
    // Listing of all figures in the render context.
    | { type: "figures" }
    // Parsed schemath model. Keep the original source for the interactive source viewer.
    | { type: "schemaGraph"; alt?: string; caption?: string; graph: SchemaModel; source?: string }
    // Parsed graphth model, with the original source preserving notes and ordering.
    | { type: "graph"; alt?: string; caption?: string; graph: GraphModel; source?: string }
);

export interface TocEntry {
    /** heading depth (1 = `#` … 6 = `######`) */
    depth: 1 | 2 | 3 | 4 | 5 | 6;
    text: string;
    slug: string;
}

export const walkBlocks = (blocks: readonly Block[]): Block[] => {
    const listBlocks = (items: ListItem[]): Block[] =>
        items.flatMap((item) =>
            typeof item === "string"
                ? []
                : "blocks" in item
                  ? walkBlocks(item.blocks)
                  : listBlocks(item.children),
        );
    return blocks.flatMap((block) => [
        block,
        ...(block.type === "themeVariants"
            ? walkBlocks([block.default, ...Object.values(block.variants)])
            : block.type === "quote"
              ? walkBlocks(block.blocks)
              : block.type === "list"
                ? listBlocks(block.items)
                : []),
    ]);
};

// Slug for heading / term anchors: always ASCII, whatever the doc language (slugs are not part
// of the language socket). Like github-slugger for ASCII text (lowercase / strip symbols /
// whitespace → hyphen); accents are folded (`café` → `cafe`) and any other non-ASCII text is
// dropped, so the result may be "" — callers supply a fallback (e.g. `section-N`). Used together
// with routing.headingAnchor, which namespaces heading anchors (`<docId>__<slug>`).
export const slugify = (text: string): string =>
    text
        .normalize("NFKD")
        .toLowerCase()
        .replace(/[^a-z0-9_\- ]/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .replace(/^-+|-+$/g, "");
