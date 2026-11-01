import type { Frontmatter } from "../core/taxonomy.js";

// Serializes front-matter in hand-written style (double-quoted scalars / flow sequences). A
// generic YAML stringify isn't used because it changes quote/sequence style and pollutes git
// diffs against existing files. Key order is title / tags / description / lang. The key set is
// taxonomy's closed set, and a JSON string is a valid YAML double-quoted scalar.
const serializeFrontmatter = (fm: Frontmatter): string => {
    const lines = [`title: ${JSON.stringify(fm.title)}`];
    if (fm.tags && fm.tags.length > 0) {
        lines.push(`tags: [${fm.tags.map((t) => JSON.stringify(t)).join(", ")}]`);
    }
    if (fm.description) {
        lines.push(`description: ${JSON.stringify(fm.description)}`);
    }
    if (fm.lang) {
        lines.push(`lang: ${JSON.stringify(fm.lang)}`);
    }
    return `---\n${lines.join("\n")}\n---\n`;
};

/** Form frontmatter + body md → full file text (normalized to one trailing newline). */
export const assembleDoc = (fm: Frontmatter, body: string): string => {
    const b = body.replace(/\n+$/, "");
    return serializeFrontmatter(fm) + (b === "" ? "" : `\n${b}\n`);
};
