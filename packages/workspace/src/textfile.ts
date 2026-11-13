import { readManifest } from "../../engine/src/compiler/manifest.js";
import {
    compileSubformatSchema,
    isSubformatSchemaFile,
    validateSubformatFile,
} from "../../engine/src/compiler/subformats.js";
import {
    readTextfile,
    readTextfileAsync,
    textfilePath,
    writeTextfile,
} from "../../engine/src/compiler/textfile.js";
import { TextfileUnavailable } from "../../engine/src/compiler/textfile-remote.js";
import type { SchemaContext } from "../../engine/src/core/schema-refs.js";
import { isRemoteTextfile } from "../../engine/src/core/textfile.js";

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
        schemaContext?: SchemaContext;
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
            validateSubformatFile(root, input.file, input.content, domains);
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
        const compiled = format
            ? compileSubformatSchema(readTextfile(root, format.schema), {
                  root,
                  file: format.schema,
                  domains,
              })
            : undefined;
        const content = await readTextfileAsync(root, input.file, true, domains).catch((error) => {
            if (
                (error as NodeJS.ErrnoException).code === "ENOENT" ||
                (error instanceof TextfileUnavailable && error.reason === "missing")
            )
                return null;
            throw error;
        });
        return {
            status: 200,
            body: {
                content,
                ...(format
                    ? {
                          language: format.format,
                          schema: compiled?.schema,
                          schemaContext: compiled?.context,
                      }
                    : {}),
                ...(!isRemoteTextfile(input.file) &&
                isSubformatSchemaFile(root, input.file, domains)
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
