import type { AnySchemaObject, ValidateFunction } from "ajv";
import { Ajv2020, MissingRefError } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { schemaObject } from "../core/schema-fields.js";
import { type SchemaContext, visitSchema } from "../core/schema-refs.js";
import { SUBFORMAT_SCHEMA_VERSION } from "../core/subformats.js";
import { fileURLToPath, pathToFileURL, realpathSync, relative } from "./host.js";
import { readTextfile, textfilePath } from "./textfile.js";

interface SchemaSource {
    root: string;
    file: string;
    domains?: readonly string[];
}
const cache = new Map<
    string,
    {
        schema: AnySchemaObject;
        validate: ValidateFunction;
        context: SchemaContext;
        dependencies: Map<string, string>;
    }
>();

export const compileSubformatSchema = (content: string, source?: SchemaSource) => {
    const uri = source
        ? pathToFileURL(textfilePath(source.root, source.file)).href
        : "file:///schema.json";
    const key = JSON.stringify([uri, source?.domains ?? [], content]);
    const read = (uri: string): string => {
        if (!source)
            throw new Error("A schema file path is required to resolve external references");
        try {
            const url = new URL(uri);
            if (url.protocol === "file:") {
                if (url.search) throw new Error("Local schema references cannot contain a query");
                return readTextfile(
                    source.root,
                    relative(realpathSync(source.root), fileURLToPath(url)).replaceAll("\\", "/"),
                );
            }
            if (!/^https?:$/.test(url.protocol))
                throw new Error("Schema references require a local file or HTTPS URL");
            return readTextfile(source.root, url.href, false, source.domains);
        } catch (error) {
            throw new Error(
                `Cannot load schema ${uri}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    };
    const cached = cache.get(key);
    if (cached && [...cached.dependencies].every(([uri, text]) => read(uri) === text))
        return cached;
    const schema = JSON.parse(content) as AnySchemaObject;
    if (!schemaObject(schema) || schema.$async)
        throw new Error("Use a synchronous JSON object schema");
    const context: SchemaContext = { uri, schemas: {} };
    const dependencies = new Map<string, string>();
    const ajv = new Ajv2020({ allErrors: true, strict: true, ownProperties: true });
    addFormats.default(ajv);
    // Ajv resolves anchors but omits their annotation keyword from the 2020-12 vocabulary.
    ajv.addKeyword({ keyword: "$anchor", schemaType: "string" });
    const add = (schema: unknown, uri: string): void => {
        if (typeof schema !== "boolean" && !schemaObject(schema))
            throw new Error("Expected a JSON schema object or boolean");
        visitSchema(schema, uri, (node, base) => {
            if (node.$async) throw new Error("Use a synchronous JSON object schema");
            if (node.$schema !== undefined && node.$schema !== SUBFORMAT_SCHEMA_VERSION)
                throw new Error(`Use JSON Schema 2020-12: ${SUBFORMAT_SCHEMA_VERSION}`);
            if (
                /^https?:/.test(uri) &&
                (new URL(base).protocol === "file:" ||
                    (typeof node.$ref === "string" &&
                        new URL(node.$ref, base).protocol === "file:"))
            )
                throw new Error("Remote schemas cannot reference local files");
        });
        context.schemas[uri] = schema;
        const compiled =
            schemaObject(schema) && typeof schema.$id === "string"
                ? { ...schema, $id: new URL(schema.$id, uri).href }
                : schema;
        ajv.addSchema(compiled, uri);
        if (schemaObject(schema) && typeof schema.$anchor === "string")
            ajv.addSchema(
                compiled,
                new URL(
                    `#${schema.$anchor}`,
                    schemaObject(compiled) && typeof compiled.$id === "string" ? compiled.$id : uri,
                ).href,
            );
    };
    add(schema, uri);
    let validate: ValidateFunction | undefined;
    for (;;) {
        try {
            validate = ajv.getSchema(uri);
            break;
        } catch (error) {
            if (!(error instanceof MissingRefError) || ajv.refs[error.missingSchema]) throw error;
            if (dependencies.size >= 64)
                throw new Error("A schema may reference at most 64 external files");
            const text = read(error.missingSchema);
            dependencies.set(error.missingSchema, text);
            add(JSON.parse(text), error.missingSchema);
        }
    }
    if (!validate) throw new Error("Schema could not be compiled");
    const result = { schema, validate, context, dependencies };
    if (cache.size >= 32) cache.clear();
    cache.set(key, result);
    return result;
};
