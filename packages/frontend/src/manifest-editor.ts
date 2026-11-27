import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { isScalar, parseDocument } from "yaml";
import {
    flattenTree,
    migrateDocumentIcon,
    parseManifest,
} from "../../engine/src/core/content-metadata.js";
import { migrateCollections } from "../../engine/src/core/formats.js";
import { documentPathErrors } from "../../engine/src/core/routing.js";
import { pageWorkspace } from "../../workspace/src/client.js";

export const manifestErrors = (raw: string): string[] => {
    const document = parseDocument(raw);
    if (document.errors.length) return document.errors.map((error) => error.message);
    try {
        const manifest = parseManifest(document.toJS());
        return [...manifest.errors, ...documentPathErrors(flattenTree(manifest.tree))];
    } catch (error) {
        return [error instanceof Error ? error.message : String(error)];
    }
};

export const updateManifestSetting = (raw: string, path: string[], value: unknown): string => {
    const document = parseDocument(raw);
    if (document.errors.length) throw new Error(document.errors[0]?.message);
    migrateDocumentIcon(document);
    migrateCollections(document);
    if (path[0] === "document" && path[1] === "icon" && path.length === 3) {
        const icon = document.getIn(["document", "icon"], true);
        if (isScalar(icon) && typeof icon.value === "string")
            document.setIn(
                ["document", "icon"],
                document.createNode({ light: icon, dark: icon.clone() }),
            );
    }
    if (value === undefined) document.deleteIn(path);
    else {
        for (let length = 1; length < path.length; length++) {
            const parent = path.slice(0, length);
            if (document.hasIn(parent) && document.getIn(parent) == null)
                document.setIn(parent, document.createNode({}));
        }
        document.setIn(path, value);
    }
    return document.toString({ lineWidth: 0 });
};

export const manifestPathCompletion = async (
    context: CompletionContext,
    workspace: string,
): Promise<CompletionResult | null> => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    let match = /^\s*(?:url|schema|licence|icon|light|dark):\s*(["']?)([^"'\n]*)$/.exec(before);
    if (!match && /^\s*-\s/.test(before)) {
        const indent = before.search(/\S/);
        for (let n = line.number - 1; n > 0; n--) {
            const parent = context.state.doc.line(n).text;
            if (!parent.trim() || parent.trimStart().startsWith("#")) continue;
            if (parent.search(/\S/) >= indent) continue;
            if (/^\s*(?:files|folders|skills):\s*$/.test(parent))
                match = /^\s*-\s+(["']?)([^"'\n]*)$/.exec(before);
            break;
        }
    }
    if (!match) return null;
    const quote = match[1] ?? "";
    const prefix = match[2] ?? "";
    if (/[:#]/.test(prefix) || prefix.startsWith("/")) return null;
    try {
        const paths = await pageWorkspace(workspace).request<string[]>("files", {
            action: "complete",
            prefix,
        });
        if (context.aborted) return null;
        return {
            from: context.pos - prefix.length - quote.length,
            to: context.pos + Number(!!quote && line.text[context.pos - line.from] === quote),
            options: paths.map((path) => ({
                label: path,
                apply: JSON.stringify(path),
                type: path.endsWith("/") ? "namespace" : "text",
            })),
        };
    } catch {
        return null;
    }
};
