// Vocabulary SoT for the content dialect (directive catalog / front-matter schema / code langs).
// Both compiler validation and viewer insert-completion read this.

export const CODE_TEMPLATES: Readonly<Record<string, string>> = {
    grapth: "```grapth <caption>\n[<id>]: <label>\n[<ref_id>]: <ref_label>\n\n[<id>] -> [<ref_id>]\n```",
    termth: '```termth\nname: "<name>"\ndefinition: "<definition>"\n```',
};

// Default syntax-highlighting languages; additional grammars live in .dooc/code-languages/.
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
    ...Object.keys(CODE_TEMPLATES),
] as const;
// Unknown fence labels remain valid and render as plain text until a grammar is registered.
export type CodeLang = string;

// ── directive vocabulary (SoT for the dialect's custom syntax) ─────────────────────
// Name / caption support / sample are held in one place, and both validation (dialect.ts) and
// the editor's insert-completion (`:::` palette / `/` palette) derive from here (no duplicate
// declarations). The actual figures and listings live in figures/ and terms data; content
// only references them by name.

/**
 * Markdown directives are containers (`:::name[caption]` … `:::`).
 * The parser also recognizes leaf directives, which dooc rejects.
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
];

/** Look up a directive by kind + name (unknown = undefined). Shared by validation / completion. */
export const findDirective = (kind: DirectiveKind, name: string): Directive | undefined =>
    DIRECTIVES.find((d) => d.kind === kind && d.name === name);

const directiveNames = (kind: DirectiveKind): string[] =>
    DIRECTIVES.filter((d) => d.kind === kind).map((d) => d.name);

/** No leaf directives remain in the content dialect. */
export const LEAF_DIRECTIVES: readonly string[] = directiveNames("leaf");

/** Names of the container directives (`:::name ... :::`). */
export const CONTAINER_DIRECTIVES: readonly string[] = directiveNames("container");

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
export const FM_OPTIONAL = ["lang"] as const;

export interface Frontmatter {
    title: string;
    /** BCP 47 tag of the doc's language (language.ts). Omitted = the site default. */
    lang?: string;
}

/** Display name of a doc (nav / headings / listings). Falls back if front-matter is broken. */
export const docDisplayName = (fm: Frontmatter | undefined, fallback: string): string =>
    fm?.title ?? fallback;
