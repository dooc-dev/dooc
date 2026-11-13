import { francAll } from "franc";
import type { Root } from "mdast";
import { visit } from "unist-util-visit";
import { parseMdast } from "../core/markdown.js";
import type { CheckDiagnostic } from "./check-types.js";
import { parseContentSource } from "./code-blocks.js";

export interface ProseSegment {
    text: string;
    line: number;
    column: number;
}

/** Extract rendered prose, leaving code examples, and URLs out. */
export const markdownProse = (root: Root, lineOffset = 0): ProseSegment[] => {
    const segments: ProseSegment[] = [];
    visit(root, (node) => {
        const line = (node.position?.start.line ?? 1) + lineOffset;
        const column = node.position?.start.column ?? 1;
        if (["paragraph", "heading", "tableCell"].includes(node.type)) {
            const parts: string[] = [];
            visit(node, (child, _index, parent) => {
                if (child.type === "text") {
                    if (parent?.type === "link" && child.value === parent.url) return;
                    parts.push(child.value);
                }
                if (child.type === "image" && child.alt) parts.push(child.alt);
            });
            if (parts.length) segments.push({ text: parts.join(" "), line, column });
        }
        if (node.type !== "code") return;
        if (node.lang === "callouth") {
            if (node.meta) segments.push({ text: node.meta, line, column });
            segments.push(...markdownProse(parseMdast(node.value), line));
            return;
        }
        const parsed = parseContentSource(node.lang ?? "", node.value, "check");
        if (parsed && node.meta) segments.push({ text: node.meta, line, column });
        for (const block of parsed?.blocks ?? []) {
            const parts: string[] = [];
            if (block.type === "term")
                parts.push(block.entry.name, block.entry.definition, block.entry.description ?? "");
            if (block.type === "graph")
                parts.push(
                    ...block.graph.nodes.map((n) => (n.label === n.id ? "" : n.label)),
                    ...block.graph.edges.map((edge) => edge.label ?? ""),
                    ...block.graph.regions.map((region) => region.label ?? ""),
                );
            if (block.type === "schemaGraph")
                parts.push(
                    ...block.graph.groups.map((group) => group.label ?? ""),
                    ...block.graph.tables.flatMap((table) => table.notes),
                );
            if (parts.length) segments.push({ text: parts.join(" "), line: line + 1, column: 1 });
        }
    });
    return segments;
};

export const assetProse = (file: string, raw: string): ProseSegment[] | undefined => {
    if (/\.(md|callouth)$/.test(file)) return markdownProse(parseMdast(raw));
    const language = /\.(termth|graphth|schemath)$/.exec(file)?.[1];
    if (language) return markdownProse(parseMdast(`\`\`\`${language}\n${raw}\n\`\`\``), -1);
    if (/\.(txt|html|svg)$/.test(file)) {
        // shortcut: markup text is heuristic, use an XML/HTML parser if exact element ranges are needed.
        const text = file.endsWith(".txt")
            ? raw
            : raw
                  .replace(/<!--[\s\S]*?-->/g, " ")
                  .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
                  .replace(/<[^>]*>/g, " ")
                  .replace(/&(?:#\d+|#x[\da-f]+|[a-z]+);/gi, " ");
        return [{ text, line: 1, column: 1 }];
    }
    return undefined;
};

// Franc reports individual languages for several commonly configured macrolanguages.
const macroLanguages: Record<string, string> = {
    cmn: "zho",
    arb: "ara",
    pes: "fas",
    ekk: "est",
    swh: "swa",
    azj: "aze",
    uzn: "uzb",
    pbu: "pus",
    npi: "nep",
    khk: "mon",
    lvs: "lav",
};

export const checkProse = (
    segments: ProseSegment[],
    language: string,
): Omit<CheckDiagnostic, "file" | "check">[] => {
    const findings: Omit<CheckDiagnostic, "file" | "check">[] = [];
    let checked = 0;
    const inspect = ({ text, line, column }: ProseSegment): void => {
        const clean = text
            .replace(/https?:\/\/\S+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        const letters = clean.match(/\p{L}/gu)?.length ?? 0;
        const minimum =
            /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(clean)
                ? 10
                : 40;
        if (letters < minimum) return;
        const ranked = francAll(clean, { minLength: minimum });
        const detected = ranked[0]?.[0];
        if (!detected || detected === "und") return;
        checked++;
        const matches = (code: string) => code === language || macroLanguages[code] === language;
        if (matches(detected)) return;
        // Distance scores are relative rankings, not probabilities; near ties are inconclusive.
        if (ranked.some(([code, score]) => matches(code) && score >= 0.9)) return;
        findings.push({
            code: "LANGUAGE_SUSPECT",
            severity: "warning",
            message: `Prose appears to be ${macroLanguages[detected] ?? detected}; expected ${language}. Language detection is heuristic.`,
            line,
            column,
            language,
            detectedLanguage: macroLanguages[detected] ?? detected,
        });
    };
    const sentences = new Intl.Segmenter(undefined, { granularity: "sentence" });
    // Franc samples at most 2048 characters; bounded chunks also check the end of long prose.
    for (const segment of segments)
        for (const sentence of sentences.segment(segment.text))
            for (const text of sentence.segment.match(/[\s\S]{1,1024}/g) ?? [])
                inspect({ ...segment, text });
    if (!checked && segments.length)
        inspect({
            text: segments.map((s) => s.text).join(" "),
            line: segments[0]?.line ?? 1,
            column: 1,
        });
    if (!checked)
        findings.push({
            code: "LANGUAGE_UNDETERMINED",
            severity: "info",
            message: "Not enough identifiable prose to check the language.",
            language,
        });
    return findings;
};
