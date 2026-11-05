// Dialect parser + validator for content/*.md. Dialect = CommonMark/GFM + YAML front-matter +
// only a closed subset of generic directives (remark-directive syntax). 1:1 with the README.md
// spec. Rejects here, before publish, everything that would break consumers (unrenderable /
// degraded text for MCP).
import type { Heading, Image, Link, Node, Parent, Root } from "mdast";
import type { ContainerDirective, LeafDirective } from "mdast-util-directive";
import { SKIP, visit } from "unist-util-visit";
import { parse as parseYaml } from "yaml";
import type { TermEntry } from "../core/artifact-types.js";
import { parseFileEmbed } from "../core/file-embed.js";
import { isLangTag } from "../core/language.js";
import { parseMdast, standaloneImages } from "../core/markdown.js";
import type { PreviewSettings } from "../core/previewers.js";
import { parseSchemaSource } from "../core/schema-graph.js";
import {
    CONTAINER_DIRECTIVES,
    type DirectiveKind,
    directiveRawBody,
    FM_OPTIONAL,
    FM_REQUIRED,
    type Frontmatter,
    findDirective,
    LEAF_DIRECTIVES,
} from "../core/taxonomy.js";
import { parseTermReference } from "../core/term-reference.js";
import { parseTextfileRange } from "../core/textfile.js";
import { parseContentCode } from "./code-blocks.js";

export { parseMdast } from "../core/markdown.js";

export interface ParsedDoc {
    terms: TermEntry[];
    frontmatter: Frontmatter | undefined;
    /** Body text without the front-matter (becomes the manifest's body). */
    body: string;
    /** Source passed to parse; root position offsets use it. */
    source: string;
    root: Root;
    errors: string[];
}

// Closed set of mdast node types the dialect allows. Anything else (html / blockquote /
// emphasis / strong / thematicBreak / textDirective, etc.) is an error.
const ALLOWED_TYPES = new Set([
    "root",
    "yaml",
    "paragraph",
    "heading",
    "list",
    "listItem",
    "code",
    "inlineCode",
    "table",
    "tableRow",
    "tableCell",
    "text",
    "link",
    "image",
    "leafDirective",
    "containerDirective",
]);

const line = (n: Node): string => (n.position ? `L${n.position.start.line}` : "L?");

const checkFrontmatter = (raw: unknown, errors: string[]): Frontmatter | undefined => {
    if (typeof raw !== "object" || raw == null || Array.isArray(raw)) {
        errors.push("front-matter: a YAML object is required");
        return undefined;
    }
    const fm = raw as Record<string, unknown>;
    const required = FM_REQUIRED;
    const allowed: readonly string[] = [...FM_REQUIRED, ...FM_OPTIONAL];
    for (const key of Object.keys(fm)) {
        if (!allowed.includes(key)) {
            errors.push(`front-matter: unknown key "${key}" (allowed: ${allowed.join(", ")})`);
        }
    }
    for (const key of required) {
        if (typeof fm[key] !== "string" || fm[key] === "") {
            errors.push(`front-matter: "${key}" (string) is required`);
        }
    }
    if (fm.lang !== undefined && !(typeof fm.lang === "string" && isLangTag(fm.lang))) {
        errors.push(
            'front-matter: "lang" must be a BCP 47 language tag (e.g. "en", "ja", "pt-BR")',
        );
    }
    return errors.length === 0 ? (fm as unknown as Frontmatter) : undefined;
};

const checkHeading = (n: Heading, errors: string[]): void => {
    if (n.depth < 1 || n.depth > 3) {
        errors.push(`${line(n)}: only # / ## / ### headings are allowed (not h${n.depth})`);
    }
};

// A listItem may directly contain only paragraphs (+ nested lists), i.e. the shape that maps to
// ListItem (text + children).
const checkListItem = (n: Parent, errors: string[]): void => {
    for (const child of n.children) {
        if (child.type !== "paragraph" && child.type !== "list") {
            errors.push(
                `${line(child)}: ${child.type} is not allowed directly under listItem (paragraph / list only)`,
            );
        }
    }
};

const hasLabel = (n: LeafDirective | ContainerDirective): boolean =>
    n.type === "leafDirective"
        ? n.children.length > 0
        : n.children.some((c) => c.data != null && "directiveLabel" in c.data);

// The vocabulary catalog (taxonomy.DIRECTIVES) is the SoT for the closed sets of names, caption
// allowance and extensions. Each check* only adds the content shape (callout children / DSL).
// Returns whether the directive is known.
const checkDirectiveAttrs = (
    n: LeafDirective | ContainerDirective,
    kind: DirectiveKind,
    errors: string[],
): boolean => {
    const spec = findDirective(kind, n.name);
    if (spec == null) {
        const known = kind === "leaf" ? LEAF_DIRECTIVES : CONTAINER_DIRECTIVES;
        errors.push(
            `${line(n)}: unknown ${kind} directive :::${n.name} (allowed: ${known.join(", ")})`,
        );
        return false;
    }
    const keys = Object.keys(n.attributes ?? {});
    if (keys.length > 0) {
        errors.push(
            `${line(n)}: :::${n.name}{...} attributes are not allowed (${spec.caption ? `for a caption, use :::${n.name}[caption]` : "it takes no attributes"})`,
        );
    }
    if (!spec.caption && hasLabel(n)) {
        errors.push(`${line(n)}: :::${n.name} does not take a [caption]`);
    }
    return true;
};

const checkContainerDirective = (n: ContainerDirective, errors: string[]): void => {
    if (!checkDirectiveAttrs(n, "container", errors)) {
        return;
    }
    switch (n.name) {
        case "callout": {
            // The directive label line (:::callout[...]) comes in as a paragraph
            // (data.directiveLabel), so exclude it.
            const children = n.children.filter((c) => !(c.data && "directiveLabel" in c.data));
            if (
                children.length === 0 ||
                !children.every((c) => c.type === "paragraph" || c.type === "list")
            ) {
                errors.push(`${line(n)}: :::callout may only contain paragraphs / lists`);
            }
            break;
        }
        // Raw-text directives (schema) have non-markdown content, so checkRawDirective
        // handles them separately (not walked).
        default:
            break;
    }
};

// DSL parsers for raw-text directives (taxonomy `raw: true`). Their content isn't markdown, so
// it isn't walked; the source sliced from raw is passed here instead.
const RAW_PARSERS: Record<
    string,
    { parse: (source: string) => { errors: { line: number; message: string }[] }; hint: string }
> = {
    schema: { parse: parseSchemaSource, hint: "write the table DSL directly" },
};

// The content of :::schema is raw DSL text, not markdown. Slice it from raw and only
// run DSL validation (= `###` / indented lines inside aren't interpreted as markdown; the caller
// doesn't walk descendants).
const checkRawDirective = (n: ContainerDirective, raw: string, errors: string[]): void => {
    checkDirectiveAttrs(n, "container", errors);
    const parser = RAW_PARSERS[n.name];
    if (parser == null) {
        return;
    }
    const start = n.position?.start.offset;
    const end = n.position?.end.offset;
    if (start == null || end == null) {
        errors.push(`${line(n)}: cannot determine the extent of :::${n.name}`);
        return;
    }
    const slice = raw.slice(start, end);
    const body = directiveRawBody(slice);
    if (body.trim() === "") {
        errors.push(`${line(n)}: :::${n.name} is empty (${parser.hint})`);
        return;
    }
    // DSL error line (relative to the directive) → doc line number
    // (directive start line + 1 + relative line).
    const base = n.position?.start.line ?? 0;
    for (const e of parser.parse(body).errors) {
        errors.push(`L${base + 1 + e.line}: :::${n.name} ${e.message}`);
    }
};

const checkLink = (n: Link, errors: string[]): void => {
    try {
        parseTermReference(n.url);
    } catch (error) {
        errors.push(`${line(n)}: ${error instanceof Error ? error.message : error}`);
    }
    if (n.url === "") {
        errors.push(`${line(n)}: link with an empty URL`);
    }
};

export const parseDoc = (input: string, settings?: PreviewSettings, file?: string): ParsedDoc => {
    const errors: string[] = [];
    const raw = input;
    const root = parseMdast(raw);
    const embeds = new Set(root.children.flatMap(standaloneImages));
    const terms: TermEntry[] = [];

    const yamlNode = root.children[0];
    let frontmatter: Frontmatter | undefined;
    let body = input;
    if (yamlNode?.type === "yaml") {
        try {
            frontmatter = checkFrontmatter(parseYaml(yamlNode.value), errors);
        } catch (e) {
            errors.push(`front-matter: YAML parse failed (${e instanceof Error ? e.message : e})`);
        }
        const end = yamlNode.position?.end.offset;
        body = end != null ? input.slice(end).replace(/^\n+/, "") : raw;
    } else {
        errors.push("front-matter (---) is required at the top");
    }

    visit(root, (node, _index, parent) => {
        // Raw-text directives (`raw: true` = :::schema) have non-markdown content, so
        // validation is completed here and descendants aren't walked (SKIP).
        if (
            node.type === "containerDirective" &&
            findDirective("container", (node as ContainerDirective).name)?.raw === true
        ) {
            checkRawDirective(node as ContainerDirective, raw, errors);
            return SKIP;
        }
        if (
            node.type === "text" &&
            /:::(?:textfile|figure|html|graph|term)\b/.test(
                raw.slice(node.position?.start.offset, node.position?.end.offset),
            )
        )
            errors.push(
                `${line(node)}: removed directive; use Markdown file embeds, grapth / termth code fences, or links to .termth files`,
            );
        if (!ALLOWED_TYPES.has(node.type)) {
            const hint =
                node.type === "textDirective"
                    ? ' (escape ":word" in plain text with "\\:")'
                    : node.type === "html"
                      ? ' (put "<" inside backticks or escape it as "\\<")'
                      : node.type === "strong" || node.type === "emphasis"
                        ? " (bold / italic are not supported)"
                        : "";
            errors.push(`${line(node)}: ${node.type} is outside the dialect${hint}`);
            return;
        }
        switch (node.type) {
            case "code": {
                const parsed = parseContentCode(node, raw, file);
                if (!parsed) break;
                if (parent?.type !== "root") {
                    errors.push(`${line(node)}: ${node.lang} must be a top-level code block`);
                    break;
                }
                for (const error of parsed.errors)
                    errors.push(
                        `L${(node.position?.start.line ?? 0) + 1 + error.line}: ${node.lang} ${error.message}`,
                    );
                for (const block of parsed.blocks)
                    if (block.type === "term") terms.push(block.entry);
                break;
            }
            case "image": {
                if (!embeds.has(node as Image)) {
                    errors.push(`${line(node)}: file previews must occupy a standalone paragraph`);
                    break;
                }
                try {
                    const { range } = parseFileEmbed((node as Image).url, settings);
                    if (range !== undefined) parseTextfileRange(range);
                } catch (error) {
                    errors.push(`${line(node)}: ${error instanceof Error ? error.message : error}`);
                }
                break;
            }
            case "heading":
                checkHeading(node as Heading, errors);
                break;
            case "listItem":
                checkListItem(node as Parent, errors);
                break;
            case "leafDirective":
                checkDirectiveAttrs(node as LeafDirective, "leaf", errors);
                break;
            case "containerDirective":
                checkContainerDirective(node as ContainerDirective, errors);
                break;
            case "link":
                checkLink(node as Link, errors);
                break;
            default:
                break;
        }
    });

    return { frontmatter, body, source: raw, root, errors, terms };
};

/**
 * Collect the files and terms referenced by Markdown embeds and term references, for
 * cross-checking against figures/.
 */
export const collectRefs = (
    root: Root,
    settings?: PreviewSettings,
): { figures: string[]; terms: string[]; textfiles: string[] } => {
    const figures: string[] = [];
    const terms: string[] = [];
    const textfiles: string[] = [];
    for (const image of root.children.flatMap(standaloneImages)) {
        try {
            const { file, kind } = parseFileEmbed(image.url, settings);
            if (kind === "textfile") textfiles.push(file);
            else figures.push(file);
        } catch {
            // Invalid references are reported by parseDoc and must not reach file I/O.
        }
    }
    visit(root, (node) => {
        if (
            node.type === "containerDirective" &&
            findDirective("container", (node as ContainerDirective).name)?.raw
        )
            return SKIP;
        if (node.type === "link") {
            try {
                const file = parseTermReference(node.url);
                if (file) terms.push(file);
            } catch {
                /* Validation reports invalid term paths. */
            }
        }
    });
    return { figures, terms: [...new Set(terms)], textfiles: [...new Set(textfiles)] };
};
