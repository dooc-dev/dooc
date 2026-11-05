import { localFile } from "./files.js";
import { type PreviewSettings, resolvePreviewer } from "./previewers.js";
import { parseFileReference } from "./textfile.js";

/** Line fragments show source code; visual assets use the existing figures/ catalog. */
export const parseFileEmbed = (
    source: string,
    settings?: PreviewSettings,
): {
    file: string;
    range?: string;
    kind: "textfile" | "figure" | "html";
} => {
    const ref = parseFileReference(source);
    const previewer = resolvePreviewer(source, settings);
    if (ref.range !== undefined || (previewer !== "image" && previewer !== "html"))
        return { ...ref, kind: "textfile" };
    const file = ref.file.replace(/^(\.\/)+/, "");
    if (!localFile(file))
        throw new Error("Image and HTML previews require a local file inside the docs root");
    return { file, kind: previewer === "html" ? "html" : "figure" };
};
