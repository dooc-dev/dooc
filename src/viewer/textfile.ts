import { readManifest } from "../compiler/manifest.js";
import { validateSubformatFile } from "../compiler/subformats.js";
import {
    readTextfile,
    readTextfileAsync,
    textfilePath,
    writeTextfile,
} from "../compiler/textfile.js";
import { TextfileUnavailable } from "../compiler/textfile-remote.js";
import { isRemoteTextfile } from "../core/textfile.js";

export const previewTextfiles = (root: string, input: unknown): ReadonlyMap<string, string> => {
    if (input === undefined) return new Map();
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("Expected text file drafts");
    const files = new Map<string, string>();
    for (const [file, content] of Object.entries(input)) {
        textfilePath(root, file);
        if (typeof content !== "string" || /[\0\uD800-\uDFFF]/u.test(content))
            throw new Error("Expected UTF-8 text file content");
        files.set(file.replace(/^(\.\/)+/, ""), content);
    }
    return files;
};

export const textfileResponse = async (
    root: string,
    input: Record<string, unknown> | undefined,
    domains: readonly string[] = [],
): Promise<{
    status: number;
    body: {
        content?: string | null;
        error?: string;
        gitBase?: string | null;
        language?: string;
        schema?: object;
        schemaDocument?: boolean;
    };
}> => {
    if (typeof input?.file !== "string" || !["read", "save"].includes(String(input.action)))
        return { status: 400, body: { error: "Invalid text file request" } };
    try {
        if (input.action === "save") {
            if (isRemoteTextfile(input.file))
                return { status: 400, body: { error: "Remote files are read-only" } };
            if (
                typeof input.content !== "string" ||
                (input.base !== null && typeof input.base !== "string")
            )
                return { status: 400, body: { error: "Content and original text are required" } };
            validateSubformatFile(root, input.file, input.content);
            if (!writeTextfile(root, input.file, input.content, input.base))
                return {
                    status: 409,
                    body: { error: "File changed externally. Reload it before saving." },
                };
            return { status: 200, body: { content: input.content } };
        }
        const configs = isRemoteTextfile(input.file) ? [] : (readManifest(root).subformats ?? []);
        const extension = input.file.split(".").at(-1);
        const format = configs.find((config) => config.ext === extension);
        return {
            status: 200,
            body: {
                content: await readTextfileAsync(root, input.file, true, domains),
                ...(format
                    ? {
                          language: format.format,
                          schema: JSON.parse(readTextfile(root, format.schema)),
                      }
                    : {}),
                ...(configs.some((config) => config.schema === input.file)
                    ? { schemaDocument: true }
                    : {}),
            },
        };
    } catch (error) {
        if (
            input.action === "read" &&
            ((error as NodeJS.ErrnoException).code === "ENOENT" ||
                (error instanceof TextfileUnavailable && error.reason === "missing"))
        )
            return { status: 200, body: { content: null } };
        return {
            status: 400,
            body: { error: error instanceof Error ? error.message : String(error) },
        };
    }
};
