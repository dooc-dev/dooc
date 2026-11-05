import { Document, isSeq, parseDocument } from "yaml";
import { parseManifestText } from "../compiler/manifest.js";
import { readTextfile, writeTextfile } from "../compiler/textfile.js";
import { MANIFEST_FILE } from "../core/content-metadata.js";
import {
    defaultPreviewSettings,
    type PreviewSettings,
    parsePreviewSettings,
} from "../core/previewers.js";

export interface PreviewSettingsSnapshot {
    settings: PreviewSettings;
    base: string | null;
}

export const previewSettingsResponse = (
    root: string,
    input: Record<string, unknown> | undefined,
): {
    status: number;
    body: PreviewSettingsSnapshot | { error: string };
} => {
    if (input?.action !== "read" && input?.action !== "save")
        return { status: 400, body: { error: "Invalid preview settings request" } };
    try {
        let raw: string | null = null;
        try {
            raw = readTextfile(root, MANIFEST_FILE);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const manifest = parseManifestText(raw ?? "[]");
        if (manifest.errors.length)
            return { status: 409, body: { error: manifest.errors.join("\n") } };
        if (input.action === "read")
            return {
                status: 200,
                body: { settings: manifest.previews ?? defaultPreviewSettings(), base: raw },
            };
        if (input.base !== null && typeof input.base !== "string")
            throw new Error("Original manifest is required");
        if (raw !== input.base)
            return {
                status: 409,
                body: { error: "Settings changed externally. Reload before saving." },
            };
        const settings = parsePreviewSettings(input.settings);
        const parsed = parseDocument(raw ?? "docs: []\n");
        const document =
            isSeq(parsed.contents) || parsed.contents == null
                ? new Document({ docs: parsed.toJS() ?? [] })
                : parsed;
        document.set("previews", settings);
        const next = document.toString();
        if (!writeTextfile(root, MANIFEST_FILE, next, raw))
            return {
                status: 409,
                body: { error: "Settings changed externally. Reload before saving." },
            };
        return { status: 200, body: { settings, base: next } };
    } catch (error) {
        return {
            status: 400,
            body: { error: error instanceof Error ? error.message : String(error) },
        };
    }
};
