// Dialect parser + validator for content/*.md. Dialect = CommonMark/GFM + YAML front-matter +
// only a closed subset of generic directives (remark-directive syntax). 1:1 with the README.md
// spec. Rejects here, before publish, everything that would break consumers (unrenderable /
// degraded text for MCP).
import type { Heading, Link, Node, Parent, Root } from "mdast";
import type { ContainerDirective, LeafDirective } from "mdast-util-directive";
import remarkDirective from "remark-directive";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { SKIP, visit } from "unist-util-visit";
import { parse as parseYaml } from "yaml";
import type { TermEntry } from "../core/artifact-types.js";
import { parseGraphSource } from "../core/graph.js";
import { inlineSegmenter, TERM_ID_RE } from "../core/inline.js";
import { isLangTag } from "../core/language.js";
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
    normalizeLeafDirectives,
} from "../core/taxonomy.js";
import { parseTermSource } from "./terms.js";

const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter)
    .use(remarkGfm)
    .use(remarkDirective);

export const parseMdast = (raw: string): Root => processor.parse(raw);

export interface ParsedDoc {
    terms: TermEntry[];
    frontmatter: Frontmatter | undefined;
    /** Body text without the front-matter (becomes the manifest's body). */
    body: string;
    /** Source passed to parse (one-line leaf syntax rewritten); root position offsets use it. */
    source: string;
    root: Root;
    errors: string[];
}

// Closed set of mdast node types the dialect allows. Anything else (html / blockquote / image /
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
    if (fm.description !== undefined && typeof fm.description !== "string") {
        errors.push('front-matter: "description" must be a string');
    }
    if (
        fm.tags !== undefined &&
        !(Array.isArray(fm.tags) && fm.tags.every((t) => typeof t === "string"))
    ) {
        errors.push('front-matter: "tags" must be a string[]');
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
    if (kind === "leaf") {
        // A normalized leaf has exactly one attribute, src. Anything else is malformed.
        const src = n.attributes?.src;
        if (keys.length !== 1 || src == null) {
            errors.push(`${line(n)}: :::${n.name} must be written as ${spec.sample}`);
            return true;
        }
        const ext = /\.([a-z]+)$/.exec(src)?.[1] ?? "";
        if (!spec.exts?.includes(ext)) {
            errors.push(
                `${line(n)}: :::${n.name}(${src}) has an unsupported extension (only ${spec.exts?.join(" / ")})`,
            );
        }
    } else if (n.name === "term") {
        if (keys.length !== 1 || !TERM_ID_RE.test(n.attributes?.id ?? ""))
            errors.push(
                `${line(n)}: use :::term(id) with a lowercase alphanumeric ID (hyphens and underscores allowed)`,
            );
    } else if (keys.length > 0) {
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
        // Raw-text directives (schema / graph) have non-markdown content, so checkRawDirective
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
    graph: { parse: parseGraphSource, hint: "write node / edge lines directly" },
};

// The content of :::schema / :::graph is raw DSL text, not markdown. Slice it from raw and only
// run DSL validation (= `###` / indented lines inside aren't interpreted as markdown; the caller
// doesn't walk descendants).
const checkRawDirective = (n: ContainerDirective, raw: string, errors: string[]): void => {
    checkDirectiveAttrs(n, "container", errors);
    const parser =
        n.name === "term"
            ? {
                  parse: (source: string) => parseTermSource(n.attributes?.id ?? "", source),
                  hint: "write name and definition as YAML",
              }
            : RAW_PARSERS[n.name];
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
    if (n.name === "term" && !/\n[ \t]*:::[ \t]*$/.test(slice.trimEnd()))
        errors.push(`${line(n)}: :::term definition must close with :::`);
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
    if (n.url === "") {
        errors.push(`${line(n)}: link with an empty URL`);
    }
};

export const parseDoc = (input: string): ParsedDoc => {
    const errors: string[] = [];
    const { source: raw, badLines } = normalizeLeafDirectives(input);
    for (const l of badLines) {
        errors.push(
            `L${l}: leaf directives must be written as :::name(<file>)[caption] (file without spaces / parentheses / ")`,
        );
    }
    const root = parseMdast(raw);
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

    visit(root, (node) => {
        // Raw-text directives (`raw: true` = :::schema / :::graph) have non-markdown content, so
        // validation is completed here and descendants aren't walked (SKIP).
        if (
            node.type === "containerDirective" &&
            findDirective("container", (node as ContainerDirective).name)?.raw === true
        ) {
            checkRawDirective(node as ContainerDirective, raw, errors);
            const d = node as ContainerDirective;
            if (d.name === "term") {
                const start = d.position?.start.offset;
                const end = d.position?.end.offset;
                if (start != null && end != null)
                    terms.push(
                        ...parseTermSource(
                            d.attributes?.id ?? "",
                            directiveRawBody(raw.slice(start, end)),
                        ).entries,
                    );
            }
            return SKIP;
        }
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
 * Collect the figures a doc references (:::figure / :::html files, relative to figures/), for
 * cross-checking against figures/.
 */
export const collectRefs = (root: Root): { figures: string[]; terms: string[] } => {
    const figures: string[] = [];
    const terms: string[] = [];
    const segments = inlineSegmenter();
    visit(root, (node) => {
        if (
            node.type === "containerDirective" &&
            findDirective("container", (node as ContainerDirective).name)?.raw
        )
            return SKIP;
        if (node.type === "link" || node.type === "code" || node.type === "inlineCode") return SKIP;
        if (node.type === "text")
            for (const segment of segments(node.value))
                if (segment.kind === "term") terms.push(segment.id);
        if (node.type === "leafDirective") {
            const src = (node as LeafDirective).attributes?.src;
            if (src) figures.push(src);
        }
    });
    return { figures, terms: [...new Set(terms)] };
};
