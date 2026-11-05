import type { Image } from "mdast";
import { SKIP, visit } from "unist-util-visit";
import { parseFileEmbed } from "../core/file-embed.js";
import { parseMdast, standaloneImages } from "../core/markdown.js";
import type { PreviewSettings } from "../core/previewers.js";
import { findDirective } from "../core/taxonomy.js";
import { parseTermReference } from "../core/term-reference.js";

export interface FileReference {
    line: number;
    file: string;
    kind: "textfile" | "figure" | "html" | "term";
}

/** Use the compiler's Markdown grammar so examples, escapes and URL encodings agree. */
export const fileReferences = (body: string, settings?: PreviewSettings): FileReference[] => {
    const root = parseMdast(body);
    const images = new Set(root.children.flatMap(standaloneImages));
    const references: FileReference[] = [];
    visit(root, (node) => {
        if (node.type === "containerDirective" && findDirective("container", node.name)?.raw)
            return SKIP;
        if (node.type === "link") {
            try {
                const file = parseTermReference(node.url);
                if (file)
                    references.push({ line: node.position?.start.line ?? 1, file, kind: "term" });
            } catch {
                /* The compiler reports invalid paths. */
            }
        }
        if (node.type === "image" && images.has(node as Image)) {
            try {
                const { file, kind } = parseFileEmbed(node.url, settings);
                references.push({
                    line: node.position?.start.line ?? 1,
                    file: file.replace(/^(\.\/)+/, ""),
                    kind,
                });
            } catch {
                // The compiler reports invalid URLs; no editor should open for them.
            }
        }
    });
    return references;
};

export interface FilePreview {
    state: "pending" | "loading" | "valid" | "error";
    message?: string;
}

/** An empty list means that this file compiled successfully. */
export type FilePreviewResults = Record<string, string[]>;
