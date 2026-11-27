import { type Document, isMap, isScalar, isSeq } from "yaml";
import { fileExtension, localFile } from "./files.js";

export const REFERENCE_LIBRARIES = ["urls", "url-previews"] as const;
export type ReferenceLibrary = (typeof REFERENCE_LIBRARIES)[number];
export interface FormatSources {
    folders?: string[];
    files?: string[];
    codeblock?: boolean;
}
export type FormatSettings = Record<string, FormatSources>;

export const isFormat = (value: unknown): value is string =>
    typeof value === "string" && /^[a-z0-9][a-z0-9_+#-]*$/.test(value);
export const isReferenceLibrary = (value: unknown): value is ReferenceLibrary =>
    REFERENCE_LIBRARIES.some((view) => view === value);

const fenceExtensions: Record<string, string> = {
    javascript: "js",
    typescript: "ts",
    python: "py",
    ruby: "rb",
    rust: "rs",
    csharp: "cs",
    "c#": "cs",
    "c++": "cpp",
    kotlin: "kt",
    powershell: "ps1",
    bash: "sh",
    shell: "sh",
    markdown: "md",
    plaintext: "text",
    plain: "text",
};
export const fenceFormat = (language: string): string =>
    (fenceExtensions[language.toLowerCase()] ?? language.toLowerCase()) || "text";
export const fileFormat = (file: string): string => {
    const extension = fileExtension(file);
    return (file.split("/").at(-1) ?? "").includes(".") ? extension : "text";
};

const object = (value: unknown, name: string): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${name} must be an object`);
    return value as Record<string, unknown>;
};
const paths = (value: unknown, name: string, folders = false): string[] => {
    if (!Array.isArray(value) || value.some((path) => typeof path !== "string"))
        throw new Error(`${name} must be a list of unique local paths`);
    const result = (value as string[]).map((path) => (folders ? path.replace(/\/+$/, "") : path));
    if (
        result.some(
            (path) =>
                !(folders && path === ".") &&
                (!localFile(path) || !path.trim() || path.includes("*")),
        ) ||
        new Set(result).size !== result.length
    )
        throw new Error(`${name} must be a list of unique local paths`);
    return result;
};

export const parseCollections = (
    system: Record<string, unknown>,
): {
    libraries?: ReferenceLibrary[];
    formats?: FormatSettings;
} => {
    const formats: FormatSettings = {};
    if (system.format !== undefined) {
        for (const [format, input] of Object.entries(object(system.format, "system.format"))) {
            if (!isFormat(format))
                throw new Error("system.format keys must be extensions without a dot");
            const value = object(input, `system.format.${format}`);
            if (Object.keys(value).some((key) => !["files", "folders", "codeblock"].includes(key)))
                throw new Error(`Unknown system.format.${format} field`);
            if (value.codeblock !== undefined && typeof value.codeblock !== "boolean")
                throw new Error(`system.format.${format}.codeblock must be a boolean`);
            formats[format] = {
                ...(value.codeblock === undefined ? {} : { codeblock: value.codeblock as boolean }),
                ...(value.folders === undefined
                    ? {}
                    : { folders: paths(value.folders, `system.format.${format}.folders`, true) }),
                ...(value.files === undefined
                    ? {}
                    : { files: paths(value.files, `system.format.${format}.files`) }),
            };
            if (formats[format]?.files?.some((file) => fileFormat(file) !== format))
                throw new Error(`system.format.${format}.files must use the ${format} extension`);
        }
    }
    let libraries: ReferenceLibrary[] | undefined;
    if (system.library !== undefined) {
        if (Array.isArray(system.library)) {
            if (
                system.library.some((view) => !isReferenceLibrary(view)) ||
                new Set(system.library).size !== system.library.length
            )
                throw new Error(
                    "system.library must list unique reference views: urls, url-previews",
                );
            libraries = system.library as ReferenceLibrary[];
        } else {
            const legacy = object(system.library, "system.library");
            if (Object.keys(legacy).some((key) => key !== "files"))
                throw new Error("Unknown system.library field");
            for (const file of legacy.files === undefined
                ? []
                : paths(legacy.files, "system.library.files")) {
                const format = fileFormat(file);
                if (!isFormat(format)) throw new Error(`Unsupported format extension: ${format}`);
                if (system.format && Object.hasOwn(system.format, format))
                    throw new Error(
                        `Move system.library.files into system.format.${format}.files; both definitions are present`,
                    );
                if (!Object.hasOwn(formats, format)) formats[format] = {};
                const sources: FormatSources = formats[format] ?? {};
                sources.files ??= [];
                sources.files.push(file);
            }
        }
    }
    return {
        ...(libraries === undefined ? {} : { libraries }),
        ...(system.format !== undefined || Object.keys(formats).length ? { formats } : {}),
    };
};

/** Move YAML nodes so comments and authored page names survive collection migration. */
export const migrateCollections = (document: Document): boolean => {
    let changed = false;
    const system = document.get("system", true);
    if (isMap(system)) {
        const library = system.get("library", true);
        if (isMap(library)) {
            parseCollections(system.toJSON() as Record<string, unknown>);
            const files = library.get("files", true);
            if (isSeq(files)) {
                for (const item of files.items) {
                    if (!isScalar(item) || typeof item.value !== "string") continue;
                    const path = ["system", "format", fileFormat(item.value), "files"];
                    if (!document.hasIn(path)) document.setIn(path, document.createNode([]));
                    const target = document.getIn(path, true);
                    if (isSeq(target)) {
                        target.commentBefore ??= files.commentBefore ?? library.commentBefore;
                        target.comment ??= files.comment ?? library.comment;
                        target.add(item);
                    }
                }
            }
            system.delete("library");
            changed = true;
        }
    }
    const walk = (node: unknown): void => {
        if (isSeq(node)) for (const child of node.items) walk(child);
        else if (isMap(node)) {
            const library = node.get("library", true);
            if (
                isScalar(library) &&
                typeof library.value === "string" &&
                !isReferenceLibrary(library.value)
            ) {
                if (node.has("format"))
                    throw new Error("A page cannot define both library and format");
                const pair = node.items.find(
                    (pair) => isScalar(pair.key) && pair.key.value === "library",
                );
                if (pair && isScalar(pair.key)) pair.key.value = "format";
                changed = true;
            }
            for (const key of ["document", "children"]) walk(node.get(key, true));
        }
    };
    walk(document.get("docs", true));
    walk(document.get("document", true));
    walk(document.get("center_contents", true));
    return changed;
};
