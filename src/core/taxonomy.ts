// Vocabulary SoT for the content dialect (directive catalog / front-matter schema / code langs).
// Both compiler validation and viewer insert-completion read this.

// Default syntax-highlighting languages; additional grammars live in .document-system/code-languages/.
export const CODE_LANGS = [
    "javascript",
    "typescript",
    "jsx",
    "tsx",
    "python",
    "java",
    "c",
    "cpp",
    "csharp",
    "go",
    "rust",
    "ruby",
    "php",
    "swift",
    "kotlin",
    "bash",
    "powershell",
    "html",
    "css",
    "json",
    "yaml",
    "toml",
    "sql",
    "markdown",
    "dockerfile",
    "diff",
    "graphql",
    "terraform",
] as const;
// Unknown fence labels remain valid and render as plain text until a grammar is registered.
export type CodeLang = string;

// ── directive vocabulary (SoT for the dialect's custom syntax) ─────────────────────
// Name / caption support / sample are held in one place, and both validation (dialect.ts) and
// the editor's insert-completion (`:::` palette / `/` palette) derive from here (no duplicate
// declarations). The actual figures and listings live in figures/ and terms data; content
// only references them by name.

/**
 * Directive kind — both are written with `:::`. leaf = the one-line
 * `:::name(<file>)[caption]` (no closing), container = `:::name[caption]` … `:::`.
 */
export type DirectiveKind = "leaf" | "container";

/** Spec of a single directive. */
export interface Directive {
    name: string;
    kind: DirectiveKind;
    /** One-line description for listings / completion. */
    summary: string;
    /** Whether it takes a `[caption]`. */
    caption: boolean;
    /** The leaf's `(<file>)` = a file relative to figures/. Allowed extensions (without `.`). */
    exts?: readonly string[];
    /**
     * Whether this is a container whose body is not interpreted as markdown (a custom DSL is
     * written directly). For a true directive, neither validation (`dialect.ts`) nor Block
     * conversion (`from-mdast.ts`) walks its descendants; the raw text extracted by
     * `directiveRawBody` is passed to that DSL's parser.
     */
    raw?: boolean;
    /**
     * Minimal sample that can be written as-is. `<...>` marks a spot the author fills in
     * (the editor turns these into input fields = snippet fields on insert).
     */
    sample: string;
}

export const DIRECTIVES: readonly Directive[] = [
    {
        name: "figure",
        kind: "leaf",
        summary:
            "Place a figure from figures/ (svg / drawio.svg / png / webp / jpeg) (build checks that it exists)",
        caption: true,
        exts: ["svg", "png", "webp", "jpg", "jpeg"],
        sample: ":::figure(<file>.svg)[<caption>]",
    },
    {
        name: "html",
        kind: "leaf",
        summary: "Place an HTML fragment from figures/ (build checks that it exists)",
        caption: false,
        exts: ["html"],
        sample: ":::html(<file>.html)",
    },
    {
        name: "textfile",
        kind: "leaf",
        summary:
            "Show a UTF-8 file relative to the docs root, with its filename and code highlighting",
        caption: false,
        sample: ":::textfile(<filepath>)",
    },
    {
        name: "callout",
        kind: "container",
        summary: "Boxed callout — body is paragraphs / bullet lists",
        caption: true,
        sample: ":::callout[<caption>]\n- <item>\n:::",
    },
    {
        name: "schema",
        kind: "container",
        // Body is raw table-DSL text, not markdown. The parse / layout SoT is schema-graph.ts.
        raw: true,
        summary:
            "Draw an ER diagram (schema graph) from the table DSL (body is not treated as markdown)",
        caption: true,
        // DSL table / field names are alphanumerics and `_` only, so placeholders take the same
        // form (the referenced table is written out too, so the filled-in template validates).
        sample: ":::schema[<caption>]\n### <group>\n<table>:\n  id: pk\n  <field>: fk(<ref_table>)\n\n<ref_table>:\n  id: pk\n:::",
    },
    {
        name: "graph",
        kind: "container",
        // Body is raw node / edge DSL text, not markdown. The parse / layout SoT is graph.ts.
        raw: true,
        summary:
            "Draw a relationship diagram from the node / edge DSL (body is not treated as markdown)",
        caption: true,
        // Node ids are always wrapped in `[...]` (so hyphenated real names can be written as-is);
        // a region is a single tag attached to a node (no declaration line needed).
        sample: ":::graph[<caption>]\n[<id>]: <label> @<region>\n[<ref_id>]: <label> @<region>\n\n[<id>] -> [<ref_id>]\n:::",
    },
    {
        name: "term",
        kind: "container",
        raw: true,
        summary: "Define a term by ID; reference it in prose with :::term(id)",
        caption: false,
        sample: ':::term(<id>)\nname: "<name>"\ndefinition: "<definition>"\n:::',
    },
];

/** Look up a directive by kind + name (unknown = undefined). Shared by validation / completion. */
export const findDirective = (kind: DirectiveKind, name: string): Directive | undefined =>
    DIRECTIVES.find((d) => d.kind === kind && d.name === name);

const directiveNames = (kind: DirectiveKind): string[] =>
    DIRECTIVES.filter((d) => d.kind === kind).map((d) => d.name);

/** Names of the leaf directives (`:::name(<file>)`). */
export const LEAF_DIRECTIVES: readonly string[] = directiveNames("leaf");

/** Names of the container directives (`:::name ... :::`). */
export const CONTAINER_DIRECTIVES: readonly string[] = directiveNames("container");

// The leaf one-line syntax `:::name(<file>)[caption]` is not a form remark-directive knows, so
// before parsing it is rewritten in place to the leaf directive `::name[caption]{src="<file>"}`
// (line numbers unchanged).
const LEAF_LINE_RE = new RegExp(`^(\\s*):::(${LEAF_DIRECTIVES.join("|")})\\(`);
const LEAF_FULL_RE = /^(\s*):::([\w-]+)\(([^()"\s]+)\)(\[[^\]\n]*\])?\s*$/;
export const TEXTFILE_LINE_RE =
    /^([ \t]*):::textfile\(([^()"\r\n]+)\)[ \t]*(\[[^\r\n]*\])?[ \t]*\r?$/;

/**
 * Returns the source with the leaf one-line syntax rewritten to remark-directive's leaf form,
 * plus the line numbers (1-indexed) of leaf lines that couldn't be rewritten (= malformed).
 * Fenced code is left untouched.
 */
export const normalizeLeafDirectives = (raw: string): { source: string; badLines: number[] } => {
    const badLines: number[] = [];
    let fence: string | undefined;
    let rawBody = false;
    const input = raw.split("\n");
    const lines = input.map((l, i) => {
        if (rawBody) {
            if (/^\s*:::\s*$/.test(l)) rawBody = false;
            return l;
        }
        const f = /^\s*(`{3,}|~{3,})/.exec(l)?.[1];
        if (f != null && (fence == null || f.startsWith(fence))) {
            fence = fence == null ? f : undefined;
            return l;
        }
        if (fence != null) return l;
        if (/^\s*:::textfile\(/.test(l)) {
            const file = TEXTFILE_LINE_RE.exec(l);
            if (!file?.[2]?.trim()) {
                badLines.push(i + 1);
                return l;
            }
            const escapeAttribute = (value: string): string =>
                value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("\\", "&#92;");
            return `${file[1]}::textfile{src="${escapeAttribute(file[2].trim())}"${file[3] ? ` range="${escapeAttribute(file[3])}"` : ""}}`;
        }
        const term = /^(\s*):::term\(\s*([^()"\n]*?)\s*\)\s*$/.exec(l);
        if (term) {
            const rest = input.slice(i + 1);
            const next = rest.find((line) => line.trim());
            if (/^\s*[\w-]+\s*:(?:[ \t]|$)/.test(next ?? "")) {
                rawBody = true;
                return `${term[1]}:::term{id="${term[2]?.trim()}"}`;
            }
        }
        const container = /^\s*:::([\w-]+)/.exec(l)?.[1];
        if (container && container !== "term" && findDirective("container", container)?.raw)
            rawBody = true;
        if (!LEAF_LINE_RE.test(l)) {
            return l;
        }
        const m = LEAF_FULL_RE.exec(l);
        if (m == null) {
            badLines.push(i + 1);
            return l;
        }
        return `${m[1]}::${m[2]}${m[4] ?? ""}{src="${m[3]}"}`;
    });
    return { source: lines.join("\n"), badLines };
};

/**
 * Body of a raw-text directive (`raw: true`): the DSL source with the opening line
 * `:::name[...]` and the closing line `:::` dropped and the common indent removed. The body is
 * not interpreted as markdown (so the DSL can be written directly). Line index i of the returned
 * text corresponds to doc line `directive start line + 1 + i`, so DSL error lines map straight
 * onto doc line numbers.
 */
export const directiveRawBody = (slice: string): string => {
    const lines = slice.split("\n").slice(1);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const text = lines[i]?.trim() ?? "";
        if (text === "") {
            continue;
        }
        if (text === ":::") {
            lines.splice(i, 1);
        }
        break;
    }
    const indents = lines
        .filter((l) => l.trim() !== "")
        .map((l) => /^[ \t]*/.exec(l)?.[0].length ?? 0);
    const dedent = indents.length === 0 ? 0 : Math.min(...indents);
    return lines.map((l) => (l.trim() === "" ? "" : l.slice(dedent))).join("\n");
};

// Front-matter schema (the hierarchy's SoT is manifest.yaml, so it is not written in
// front-matter; writing it there is an unknown-key error).
export const FM_REQUIRED = ["title"] as const;
export const FM_OPTIONAL = ["tags", "description", "lang"] as const;

export interface Frontmatter {
    title: string;
    tags?: string[];
    description?: string;
    /** BCP 47 tag of the doc's language (language.ts). Omitted = the site default. */
    lang?: string;
}

/** Display name of a doc (nav / headings / listings). Falls back if front-matter is broken. */
export const docDisplayName = (fm: Frontmatter | undefined, fallback: string): string =>
    fm?.title ?? fallback;
