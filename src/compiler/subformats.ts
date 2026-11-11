import { existsSync } from "node:fs";
import type { AnySchemaObject, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { stringify as stringifyToml } from "smol-toml";
import { Document, isSeq, parseDocument, stringify as stringifyYaml } from "yaml";
import { MANIFEST_FILE } from "../core/content-metadata.js";
import { fileExtension } from "../core/files.js";
import { parseSubformatRecord, setSubformatValue } from "../core/subformat-record.js";
import {
    parseSubformats,
    SUBFORMAT_SCHEMA_TEMPLATE,
    SUBFORMAT_SCHEMA_VERSION,
    type Subformat,
    type SubformatCollection,
    type SubformatField,
} from "../core/subformats.js";
import { filesSnapshot, managedFile } from "./files.js";
import { parseManifestText, readManifest } from "./manifest.js";
import { readTextfile, textfilePath, writeTextfile } from "./textfile.js";

export interface LoadedSubformat extends Subformat {
    fields: SubformatField[];
    template: string;
    validate: ValidateFunction;
}

export const compileSubformatSchema = (content: string) => {
    const schema = JSON.parse(content) as AnySchemaObject;
    if (!schema || typeof schema !== "object" || Array.isArray(schema) || schema.$async)
        throw new Error("Use a synchronous JSON object schema");
    if (schema.$schema !== undefined && schema.$schema !== SUBFORMAT_SCHEMA_VERSION)
        throw new Error(`Use JSON Schema 2020-12: ${SUBFORMAT_SCHEMA_VERSION}`);
    const ajv = new Ajv2020({ allErrors: true, strict: true, ownProperties: true });
    addFormats.default(ajv);
    const validate = ajv.compile(schema);
    return { schema, validate };
};

const schemaCache = new Map<string, ReturnType<typeof compileSubformatSchema>>();

export const loadSubformat = (root: string, config: Subformat): LoadedSubformat => {
    const content = readTextfile(root, config.schema);
    let compiled = schemaCache.get(content);
    if (!compiled) {
        compiled = compileSubformatSchema(content);
        // Bound retained validators when schemas are edited repeatedly.
        if (schemaCache.size >= 32) schemaCache.clear();
        schemaCache.set(content, compiled);
    }
    const { schema, validate } = compiled;
    const resolve = (value: AnySchemaObject): AnySchemaObject => {
        const seen = new Set<string>();
        while (typeof value.$ref === "string" && value.$ref.startsWith("#/")) {
            if (seen.has(value.$ref)) break;
            seen.add(value.$ref);
            const target = value.$ref
                .slice(2)
                .split("/")
                .reduce((node: AnySchemaObject | undefined, key: string) => {
                    const property = key.replaceAll("~1", "/").replaceAll("~0", "~");
                    return node && Object.hasOwn(node, property) ? node[property] : undefined;
                }, schema);
            if (!target || typeof target !== "object") break;
            const { $ref: _ref, ...siblings } = value;
            value = { ...target, ...siblings };
        }
        return value;
    };
    // shortcut: controls use top-level properties and local refs, extend extraction for composed schemas.
    const fields: SubformatField[] = Object.entries(resolve(schema).properties ?? {}).flatMap(
        ([name, definition]) => {
            if (!definition || typeof definition !== "object") return [];
            const property = resolve(definition);
            const values = property.enum;
            return [
                {
                    name,
                    title: typeof property.title === "string" ? property.title : name,
                    ...(["string", "number", "integer", "boolean"].includes(property.type)
                        ? { type: property.type }
                        : {}),
                    ...(Array.isArray(values) &&
                    values.every(
                        (value) =>
                            value === null ||
                            ["string", "number", "boolean"].includes(typeof value),
                    )
                        ? { enum: values }
                        : {}),
                    ...(["date", "date-time"].includes(property.format)
                        ? { format: property.format }
                        : {}),
                    ...(property.readOnly === true ? { readOnly: true } : {}),
                },
            ];
        },
    );
    const object = resolve(schema);
    const initial =
        object.default ??
        object.examples?.[0] ??
        Object.fromEntries(
            Object.entries(object.properties ?? {}).flatMap(([name, definition]) => {
                if (!definition || typeof definition !== "object") return [];
                const property = resolve(definition);
                if (!object.required?.includes(name) && property.default === undefined) return [];
                const value =
                    property.default ??
                    property.const ??
                    property.enum?.[0] ??
                    (property.type === "boolean"
                        ? false
                        : ["number", "integer"].includes(property.type)
                          ? (property.minimum ?? 0)
                          : property.type === "object"
                            ? {}
                            : property.type === "array"
                              ? []
                              : property.format === "date"
                                ? new Date().toISOString().slice(0, 10)
                                : property.format === "date-time"
                                  ? new Date().toISOString()
                                  : "");
                return [[name, value]];
            }),
        );
    let template = "";
    try {
        template =
            config.format === "json"
                ? `${JSON.stringify(initial, null, 2)}\n`
                : config.format === "yaml"
                  ? stringifyYaml(initial)
                  : stringifyToml(initial);
    } catch {
        // A schema example may contain values the configured format cannot represent.
    }
    return { ...config, fields, template, validate };
};

export const validateSubformatRecord = (
    format: LoadedSubformat,
    data: Record<string, unknown>,
): void => {
    if (!format.validate(data))
        throw new Error(
            (format.validate.errors ?? [])
                .map((error) => `${error.instancePath || "/"} ${error.message}`)
                .join("; "),
        );
};

export const validateSubformatFile = (root: string, file: string, content: string): void => {
    const configs = readManifest(root).subformats;
    if (configs?.some((format) => format.schema === file.replace(/^(\.\/)+/, "")))
        compileSubformatSchema(content);
    const config = configs?.find((format) => format.ext === fileExtension(file));
    if (!config) return;
    if (!filesSnapshot(root).files.some((file) => file.path === config.schema))
        throw new Error("Subformat schema is not available in the workspace");
    try {
        validateSubformatRecord(
            loadSubformat(root, config),
            parseSubformatRecord(content, config.format),
        );
    } catch (error) {
        throw new Error(
            `${file} (${config.format}): ${error instanceof Error ? error.message : String(error)}`,
        );
    }
};

export const subformatResponse = (
    root: string,
    input: Record<string, unknown> | undefined,
): {
    status: number;
    body: {
        content?: string;
        data?: Record<string, unknown>;
        collection?: SubformatCollection;
        error?: string;
    };
} => {
    try {
        if (input?.action === "validate") {
            if (typeof input.content !== "string") throw new Error("Schema content is required");
            compileSubformatSchema(input.content);
            return { status: 200, body: {} };
        }
        if (input?.action === "layouts") {
            if (
                typeof input.key !== "string" ||
                !["card_title", "group_by", "sort_by", "sort_order"].includes(input.key) ||
                typeof input.value !== "string" ||
                (input.base !== null && typeof input.base !== "string")
            )
                throw new Error("A layout key, value and previous value are required");
            const raw = readTextfile(root, MANIFEST_FILE);
            const manifest = parseManifestText(raw);
            if (manifest.errors.length) throw new Error(manifest.errors.join("\n"));
            const index =
                manifest.subformats?.findIndex((format) => format.ext === input.ext) ?? -1;
            const config = manifest.subformats?.[index];
            if (!config) throw new Error("Unknown subformat");
            const key = input.key as keyof NonNullable<Subformat["layouts"]>;
            if ((config.layouts?.[key] ?? null) !== input.base)
                return {
                    status: 409,
                    body: { error: "Default changed externally. Reload and try again." },
                };
            parseSubformats([{ ...config, layouts: { ...config.layouts, [key]: input.value } }]);
            if (key !== "sort_order" && input.value) {
                const field = loadSubformat(root, config).fields.find(
                    (field) => field.name === input.value,
                );
                if (
                    !field ||
                    (key === "group_by" && !field.enum?.length) ||
                    (key === "sort_by" && !field.enum && !field.format && !field.type)
                )
                    throw new Error("Default must reference a compatible schema field");
            }
            const document = parseDocument(raw);
            const section = manifest.format === "nested" ? "json_subformats" : "subformats";
            document.setIn([section, index, "layouts", key], input.value);
            if (!writeTextfile(root, MANIFEST_FILE, document.toString(), raw))
                return { status: 409, body: { error: "Manifest changed externally. Try again." } };
            return { status: 200, body: {} };
        }
        if (input?.action === "register") {
            const raw = readTextfile(root, MANIFEST_FILE);
            const manifest = parseManifestText(raw);
            if (manifest.errors.length) throw new Error(manifest.errors.join("\n"));
            const schema =
                input.schema === undefined || input.schema === ""
                    ? `${input.ext}.schema.json`
                    : input.schema;
            const configs = parseSubformats([
                ...(manifest.subformats ?? []),
                { ext: input.ext, format: input.format, schema },
            ]);
            const config = configs[configs.length - 1] as Subformat;
            if (!managedFile(config.schema)) throw new Error("Schema must be a local project file");
            if (input.content !== undefined && typeof input.content !== "string")
                throw new Error("Schema content must be text");
            const initial = input.content ?? SUBFORMAT_SCHEMA_TEMPLATE;
            compileSubformatSchema(initial);
            if (!existsSync(textfilePath(root, config.schema))) {
                if (!writeTextfile(root, config.schema, initial, null))
                    return {
                        status: 409,
                        body: { error: "Schema changed externally. Try again." },
                    };
            } else if (
                input.content !== undefined &&
                readTextfile(root, config.schema) !== initial
            ) {
                return {
                    status: 409,
                    body: { error: "Schema file already exists. Choose another path." },
                };
            }
            if (!filesSnapshot(root).files.some((file) => file.path === config.schema))
                throw new Error("Subformat schema is not available in the workspace");
            const loaded = loadSubformat(root, config);
            const parsed = parseDocument(raw);
            const document =
                isSeq(parsed.contents) || parsed.contents == null
                    ? new Document({ docs: parsed.toJS() ?? [] })
                    : parsed;
            if (document !== parsed) document.commentBefore = parsed.commentBefore;
            const key = manifest.format === "nested" ? "json_subformats" : "subformats";
            if (document.has(key)) document.addIn([key], config);
            else document.set(key, [config]);
            if (!writeTextfile(root, MANIFEST_FILE, document.toString(), raw))
                return { status: 409, body: { error: "Manifest changed externally. Try again." } };
            return {
                status: 200,
                body: {
                    collection: {
                        ...config,
                        fields: loaded.fields,
                        template: loaded.template,
                        defaultFolder: manifest.defaultSubformatFolder,
                        records: [],
                        change: "added",
                    },
                },
            };
        }
        if (input?.action === "create") {
            if (typeof input.file !== "string" || typeof input.content !== "string")
                throw new Error("A record file and content are required");
            const config = readManifest(root).subformats?.find(
                (format) => format.ext === fileExtension(input.file as string),
            );
            if (!config) throw new Error("Choose a configured subformat extension");
            validateSubformatFile(root, input.file, input.content);
            const data = parseSubformatRecord(input.content, config.format);
            if (!writeTextfile(root, input.file, input.content, null))
                return { status: 409, body: { error: "File already exists" } };
            return { status: 200, body: { content: input.content, data } };
        }
        if (
            typeof input?.file !== "string" ||
            typeof input.base !== "string" ||
            typeof input.field !== "string"
        )
            throw new Error("A record file, original content and enum field are required");
        const files = filesSnapshot(root).files.map((file) => file.path);
        if (!files.includes(input.file))
            throw new Error("Record file is not available in the workspace");
        const config = readManifest(root).subformats?.find(
            (format) => format.ext === fileExtension(input.file as string),
        );
        if (!config || !files.includes(config.schema))
            throw new Error("Subformat schema is not available in the workspace");
        const format = loadSubformat(root, config);
        const field = format.fields.find((field) => field.name === input.field);
        if (field?.readOnly || !field?.enum?.some((value) => value === input.value))
            throw new Error("Choose a writable enum value defined by the schema");
        const current = readTextfile(root, input.file);
        if (current !== input.base)
            return {
                status: 409,
                body: { error: "File changed externally. Reload it before saving." },
            };
        const content = setSubformatValue(current, format.format, [input.field], input.value);
        const roundTrip = parseSubformatRecord(content, format.format);
        validateSubformatRecord(format, roundTrip);
        if (!writeTextfile(root, input.file, content, current))
            return {
                status: 409,
                body: { error: "File changed externally. Reload it before saving." },
            };
        return { status: 200, body: { content, data: roundTrip } };
    } catch (error) {
        return {
            status: 400,
            body: { error: error instanceof Error ? error.message : String(error) },
        };
    }
};

export { parseSubformatRecord } from "../core/subformat-record.js";
