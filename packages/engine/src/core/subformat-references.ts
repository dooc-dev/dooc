import type { Root } from "mdast";
import { visit } from "unist-util-visit";
import { localFile } from "./files.js";
import { parseMdast } from "./markdown.js";
import { parseFileReference } from "./textfile.js";

export const subformatReferences = (tree: Root): { file: string; line: number }[] => {
    const references: { file: string; line: number }[] = [];
    const definitions = new Map<string, string>();
    visit(tree, "definition", (node) => {
        definitions.set(node.identifier, node.url);
    });
    visit(tree, (node) => {
        if (node.type === "code" && node.lang?.toLowerCase() === "callouth") {
            for (const ref of subformatReferences(parseMdast(node.value)))
                references.push({ ...ref, line: ref.line + (node.position?.start.line ?? 1) });
        }
        const target =
            node.type === "link" || node.type === "image"
                ? node.url
                : node.type === "linkReference" || node.type === "imageReference"
                  ? definitions.get(node.identifier)
                  : undefined;
        if (!target || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) return;
        try {
            const file = parseFileReference(target).file.replace(/^(\.\/)+/, "");
            if (localFile(file)) references.push({ file, line: node.position?.start.line ?? 1 });
        } catch {
            // Invalid references are reported by the compiler.
        }
    });
    return references;
};
