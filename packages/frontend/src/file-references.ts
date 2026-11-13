import type { Image } from "mdast";
import { visit } from "unist-util-visit";
import { parseFileEmbed } from "../../engine/src/core/file-embed.js";
import { contentLinks, embeddedImages, parseMdast } from "../../engine/src/core/markdown.js";
import type { PreviewSettings } from "../../engine/src/core/previewers.js";
import { parseTermReference } from "../../engine/src/core/term-reference.js";

export interface FileReference {
    line: number;
    file: string;
    kind: "textfile" | "figure" | "html" | "term";
}

/** Use the compiler's Markdown grammar so examples, escapes and URL encodings agree. */
export const fileReferences = (body: string, settings?: PreviewSettings): FileReference[] => {
    const root = parseMdast(body);
    const images = new Set(embeddedImages(root));
    const references: FileReference[] = [];
    for (const node of contentLinks(root)) {
        try {
            const file = parseTermReference(node.url);
            if (file) references.push({ line: node.position?.start.line ?? 1, file, kind: "term" });
        } catch {
            /* The compiler reports invalid paths. */
        }
    }
    visit(root, (node) => {
        if (node.type === "image" && images.has(node as Image)) {
            try {
                const { file, kind } = parseFileEmbed(node.url, settings);
                if (kind === "external") return;
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
    return references.sort((a, b) => a.line - b.line);
};

export interface FilePreview {
    state: "pending" | "loading" | "valid" | "error";
    message?: string;
}

/** An empty list means that this file compiled successfully. */
export type FilePreviewResults = Record<string, string[]>;
