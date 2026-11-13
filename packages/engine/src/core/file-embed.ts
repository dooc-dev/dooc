import { localFile } from "./files.js";
import { type PreviewSettings, resolvePreviewer } from "./previewers.js";
import { parseFileReference } from "./textfile.js";

/** Local visual links share the same asset catalog as image embeds. */
export const parseFigureLink = (source: string): { file: string; fragment: string } | undefined => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(source)) return undefined;
    const path = decodeURIComponent(source.split(/[?#]/)[0] ?? "");
    if (!/\.(svg|html|png|webp|gif|mp4|webm|jpe?g|pdf|dxf)$/i.test(path)) return undefined;
    const ref = parseFileReference(source);
    const file = ref.file.replace(/^(\.\/)+/, "");
    if (!localFile(file)) throw new Error("Figure links require a file inside the docs root");
    return { file, fragment: ref.range?.slice(1) ?? "" };
};

/** Line fragments show source code; visual assets use the existing figures/ catalog. */
export const parseFileEmbed = (
    source: string,
    settings?: PreviewSettings,
): {
    file: string;
    range?: string;
    tableMode?: "header";
    kind: "textfile" | "figure" | "html" | "external";
} => {
    if (/^https?:\/\//i.test(source)) {
        const url = new URL(source);
        if (url.username || url.password)
            throw new Error("Embed URLs must not contain credentials");
        return { file: source, kind: "external" };
    }
    const ref = parseFileReference(source);
    const previewer = resolvePreviewer(source, settings);
    if (ref.range === "#H") {
        if (previewer !== "table") throw new Error("#H requires a CSV or TSV file");
        return {
            file: ref.file,
            tableMode: "header",
            kind: "textfile",
        };
    }
    if (
        ref.range !== undefined ||
        (previewer !== "image" &&
            previewer !== "html" &&
            previewer !== "video" &&
            previewer !== "pdf" &&
            previewer !== "dxf")
    )
        return { ...ref, kind: "textfile" };
    const file = ref.file.replace(/^(\.\/)+/, "");
    if (!localFile(file))
        throw new Error("Visual previews require a local file inside the docs root");
    return { file, kind: previewer === "html" ? "html" : "figure" };
};
