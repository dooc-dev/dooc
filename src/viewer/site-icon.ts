import { existsSync } from "node:fs";
import { Document, isSeq, parseDocument } from "yaml";
import { ICONS_DIR, squareSvg } from "../compiler/icons.js";
import { parseManifestText } from "../compiler/manifest.js";
import { readTextfile, textfilePath, writeTextfile } from "../compiler/textfile.js";
import { MANIFEST_FILE } from "../core/content-metadata.js";
import { defaultFilePath } from "../core/files.js";

export const siteIconResponse = (
    root: string,
    input: Record<string, unknown> | undefined,
): { status: number; body: { icon: string } | { error: string } } => {
    const svg =
        typeof input?.data === "string"
            ? squareSvg(Buffer.from(input.data, "base64").toString("utf8"))
            : undefined;
    if (!svg)
        return {
            status: 400,
            body: { error: "specify an svg (viewBox or width / height required)" },
        };
    try {
        const raw = existsSync(textfilePath(root, MANIFEST_FILE))
            ? readTextfile(root, MANIFEST_FILE)
            : null;
        const manifest = parseManifestText(raw ?? "[]");
        if (manifest.errors.length)
            return { status: 409, body: { error: manifest.errors.join("\n") } };
        const theme = input?.theme ?? "light";
        if (theme !== "light" && theme !== "dark")
            throw new Error("Expected a light or dark theme");
        const file =
            (manifest.format === "nested" ? manifest.themeIcons?.[theme] : manifest.icon) ??
            (manifest.files?.defaultLayout !== false
                ? defaultFilePath(manifest.format === "nested" ? `_site-${theme}.svg` : "_site.svg")
                : `${ICONS_DIR}/_site${manifest.format === "nested" ? `-${theme}` : ""}.svg`);
        const configured =
            manifest.format === "nested" ? manifest.themeIcons?.[theme] : manifest.icon;
        if (!configured && existsSync(textfilePath(root, file)))
            return {
                status: 409,
                body: { error: `${file} already exists; set dooc.yaml's icon to use it` },
            };
        const base = existsSync(textfilePath(root, file)) ? readTextfile(root, file) : null;
        if (!writeTextfile(root, file, svg, base))
            return { status: 409, body: { error: "Icon changed externally. Try again." } };
        if (!configured) {
            const parsed = parseDocument(raw ?? "docs: []\n");
            const document =
                isSeq(parsed.contents) || parsed.contents == null
                    ? new Document({ docs: parsed.toJS() ?? [] })
                    : parsed;
            if (manifest.format === "nested") document.setIn(["left_sidebar", "icon", theme], file);
            else document.set("icon", file);
            if (!writeTextfile(root, MANIFEST_FILE, document.toString(), raw))
                return { status: 409, body: { error: "Manifest changed externally. Try again." } };
        }
        return {
            status: 200,
            body: { icon: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` },
        };
    } catch (error) {
        return {
            status: 400,
            body: { error: error instanceof Error ? error.message : String(error) },
        };
    }
};
