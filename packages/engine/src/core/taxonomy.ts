// Vocabulary for semantic code fences, front-matter fields, and code languages.
// Both compiler validation and viewer insert-completion read this.

export const CODE_TEMPLATES: Readonly<Record<string, string>> = {
    csv: "```csv\n<value>,<value>\n```",
    tsv: "```tsv\n<value>\t<value>\n```",
    mermaid: "```mermaid\nflowchart LR\n  A[<start>] --> B[<end>]\n```",
    callouth: "```callouth <caption>\n- <item>\n```",
    schemath:
        "```schemath <caption>\n### <group>\n<table>:\n  id: pk\n  <field>: fk(<ref_table>)\n\n<ref_table>:\n  id: pk\n```",
    graphth:
        "```graphth <caption>\n[<id>]: <label>\n[<ref_id>]: <ref_label>\n\n[<id>] -> [<ref_id>]\n```",
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

/** Document metadata; the title comes from the manifest, never from the Markdown file. */
export interface Frontmatter {
    title: string;
    /** BCP 47 tag of the doc's language (language.ts). Omitted = the site default. */
    lang?: string;
}

/** Display name of a doc (nav / headings / listings). */
export const docDisplayName = (fm: Frontmatter | undefined, fallback: string): string =>
    fm?.title ?? fallback;
