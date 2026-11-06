// Vocabulary for semantic code fences, front-matter fields, and code languages.
// Both compiler validation and viewer insert-completion read this.

export const CODE_TEMPLATES: Readonly<Record<string, string>> = {
    callouth: "```callouth <caption>\n- <item>\n```",
    schemath:
        "```schemath <caption>\n### <group>\n<table>:\n  id: pk\n  <field>: fk(<ref_table>)\n\n<ref_table>:\n  id: pk\n```",
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

// Front-matter schema (the hierarchy's SoT is dooc.yaml, so it is not written in
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
