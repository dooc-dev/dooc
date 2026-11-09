import { Document, isSeq, parseDocument } from "yaml";
import { parseManifestText } from "../compiler/manifest.js";
import { readTextfile, writeTextfile } from "../compiler/textfile.js";
import { MANIFEST_FILE } from "../core/content-metadata.js";

export const siteTitleResponse = (root: string, input: Record<string, unknown> | undefined) => {
    if (
        typeof input?.title !== "string" ||
        !input.title.trim() ||
        input.title.length > 256 ||
        [...input.title].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
        (input.baseTitle !== null && typeof input.baseTitle !== "string")
    )
        return { status: 400, body: { error: "Enter a site title (1–256 characters)" } };
    try {
        const raw = readTextfile(root, MANIFEST_FILE);
        const manifest = parseManifestText(raw);
        if (manifest.errors.length)
            return { status: 409, body: { error: manifest.errors.join("\n") } };
        if ((manifest.title ?? null) !== input.baseTitle)
            return { status: 409, body: { error: "Site title changed externally. Try again." } };
        const parsed = parseDocument(raw);
        const document =
            isSeq(parsed.contents) || parsed.contents == null
                ? new Document({ docs: parsed.toJS() ?? [] })
                : parsed;
        if (document !== parsed) document.commentBefore = parsed.commentBefore;
        const title = input.title.trim();
        document.set("title", title);
        if (!writeTextfile(root, MANIFEST_FILE, document.toString(), raw))
            return { status: 409, body: { error: "Manifest changed externally. Try again." } };
        return { status: 200, body: { title } };
    } catch (error) {
        return {
            status: 400,
            body: { error: error instanceof Error ? error.message : String(error) },
        };
    }
};
