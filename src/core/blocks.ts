import type { TermEntry } from "./artifact-types.js";
// Normalized Block AST = the contract for body-text structure baked into the distributed data
// (artifact/docs.json) (browser-safe, no dependencies). It is converted from the dialect mdast at
// build time (from-mdast.ts), so consumers (preview / MCP etc.) don't parse md and just map this
// JSON to rendering.
// Inline text is a string that keeps the mini syntax (`code` / [text](url)); inline.ts splits it.
import type { GraphModel } from "./graph.js";
import type { SchemaModel } from "./schema-graph.js";
import type { CodeLang } from "./taxonomy.js";

/** Nestable list item. string = leaf, object = has children. ordered = whether the children are
 * numbered (irrelevant for childless leaves). */
export type ListItem = string | { text: string; children: ListItem[]; ordered?: boolean };

/** One element of a callout body. Paragraphs / lists can be mixed in any order. */
export type CalloutItem =
    | { type: "p"; text: string }
    | { type: "list"; items: ListItem[]; ordered?: boolean };

export type Block =
    | { type: "p"; text: string }
    // slug is derived from the heading text and filled in by the build (shared with the TOC, no
    // duplicate declaration). Level 1 (`#` in body text) is a separate heading independent of the
    // frontmatter title's h1 (multiple h1s are allowed in body text).
    | { type: "h"; level: 1 | 2 | 3; text: string; slug: string }
    // ordered omitted/false = bulleted list (`<ul>`), true = numbered (`<ol>`, md `1.` syntax).
    | { type: "list"; items: ListItem[]; ordered?: boolean }
    | {
          type: "code";
          lines: string[];
          lang?: CodeLang;
          filename?: string;
          range?: string;
          alt?: string;
          unavailable?: "missing" | "unreachable";
      }
    | {
          type: "table";
          headers: string[];
          rows: string[][];
          caption?: string;
          collapsible?: boolean;
      }
    | { type: "callout"; title?: string; body: CalloutItem[] }
    // Inline placement of a figure (figures/<name>). The markup is looked up in
    // artifact/figures/<name>.json. caption = `![caption](figures/...)` in content (falling back
    // to the figure's own title).
    | { type: "figureRef"; name: string; caption?: string }
    | { type: "term"; entry: TermEntry }
    // Listing of all figure entries (data = the artifact's figures index).
    | { type: "figures" }
    // Schema graph (ER diagram) derived from the table DSL (`:::schema`). The data is baked into
    // the artifact (the build stores the parsed model), and html.ts renders it to SVG with a
    // deterministic layout (consumers carry neither parsing nor layout). `source` is the DSL as
    // written, kept so the interactive UI's source viewer can show the "raw table" verbatim
    // (rebuilding from the model would lose the original order / notes / blank lines, so the
    // original is carried rather than derived). Optional (if absent, the viewer shows no button).
    | { type: "schemaGraph"; caption?: string; graph: SchemaModel; source?: string }
    // Relationship diagram derived from the node / edge DSL (`grapth`). Like schemaGraph, the
    // parsed model is baked into the artifact and html.ts renders it to SVG with a deterministic
    // layout. `source` is the DSL as written (not derived, since rebuilding it from the model
    // loses notes / blank lines / order).
    | { type: "graph"; caption?: string; graph: GraphModel; source?: string };

export interface TocEntry {
    /** heading depth (1 = `#`, 2 = `##`, 3 = `###`) */
    depth: 1 | 2 | 3;
    text: string;
    slug: string;
}

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
