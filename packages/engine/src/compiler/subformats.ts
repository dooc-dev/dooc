import type { AnySchemaObject, ValidateFunction } from "ajv";
import { stringify as stringifyToml } from "smol-toml";
import { Document, isSeq, parseDocument, stringify as stringifyYaml, visit } from "yaml";
import { flattenTree, subformatPageId } from "../core/content-metadata.js";
import { fileExtension } from "../core/files.js";
import { type SchemaObject, schemaObject } from "../core/schema-fields.js";
import type { SchemaModel, SchemaTable } from "../core/schema-graph.js";
import { schemaResolver } from "../core/schema-refs.js";
import { parseSubformatRecord, setSubformatValue } from "../core/subformat-record.js";
import {
    parseSubformats,
    SUBFORMAT_SCHEMA_TEMPLATE,
    type Subformat,
    type SubformatCollection,
    type SubformatField,
} from "../core/subformats.js";
import { filesSnapshot, managedFile } from "./files.js";
import { existsSync, isDeepStrictEqual, pathToFileURL } from "./host.js";
import { squareSvg } from "./icons.js";
import { manifestFile, parseManifestText, readManifest } from "./manifest.js";
import { compileSubformatSchema } from "./subformat-schema.js";
import { readTextfile, textfilePath, writeTextfile } from "./textfile.js";

export { compileSubformatSchema } from "./subformat-schema.js";

export interface LoadedSubformat extends Subformat {
    fields: SubformatField[];
    template: string;
    validate: ValidateFunction;
}

/** Markup of a subformat's configured icon; throws when the file is not a usable SVG. */
export const subformatIconSvg = (root: string, config: Subformat): string | undefined => {
    if (!config.icon) return undefined;
    const svg = squareSvg(readTextfile(root, config.icon));
    if (!svg) throw new Error(`${config.icon}: expected an SVG with a viewBox or width and height`);
    return svg;
};

export const loadSubformat = (
    root: string,
    config: Subformat,
    domains: readonly string[] = [],
): LoadedSubformat => {
    const content = readTextfile(root, config.schema);
    const { schema, validate, context } = compileSubformatSchema(content, {
        root,
        file: config.schema,
        domains,
    });
    const resolve = schemaResolver(schema, context) as (value: unknown) => AnySchemaObject;
    // shortcut: controls use top-level properties and refs; extend extraction for composed schemas.
    const recordFiles = (ext: string): string[] => {
        try {
            return filesSnapshot(root)
                .files.map((file) => file.path)
                .filter((file) => fileExtension(file) === ext && file !== config.schema);
        } catch {
            // Without a readable workspace the field stays a plain value.
            return [];
        }
    };
    const fields: SubformatField[] = Object.entries(resolve(schema).properties ?? {}).flatMap(
        ([name, definition]) => {
            if (!definition || typeof definition !== "object") return [];
            const property = resolve(definition);
            const values = property.enum;
            const reference =
                typeof property.pattern === "string"
                    ? /\\\.([\w-]+)\$$/.exec(property.pattern)?.[1]
                    : undefined;
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
                    ...(reference ? { options: recordFiles(reference) } : {}),
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
                const prescribed = ["default", "const"].find((key) => Object.hasOwn(property, key));
                const value = prescribed
                    ? property[prescribed]
                    : Array.isArray(property.enum)
                      ? property.enum[0]
                      : property.type === "null"
                        ? null
                        : property.type === "boolean"
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
                                    : "";
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

export const isSubformatSchemaFile = (
    root: string,
    file: string,
    domains: readonly string[] = [],
): boolean => {
    const configs = readManifest(root).subformats ?? [];
    if (
        /\.schema\.json$/i.test(file) ||
        configs.some((config) => config.schema === file.replace(/^(\.\/)+/, ""))
    )
        return true;
    const uri = pathToFileURL(textfilePath(root, file)).href;
    return configs.some((config) => {
        try {
            return Object.hasOwn(
                compileSubformatSchema(readTextfile(root, config.schema), {
                    root,
                    file: config.schema,
                    domains,
                }).context.schemas,
                uri,
            );
        } catch {
            // A broken referring schema must not prevent opening a file for repair.
            return false;
        }
    });
};

export const validateSubformatFile = (
    root: string,
    file: string,
    content: string,
    domains: readonly string[] = [],
): void => {
    const configs = readManifest(root).subformats;
    if (isSubformatSchemaFile(root, file, domains))
        compileSubformatSchema(content, { root, file, domains });
    const config = configs?.find((format) => format.ext === fileExtension(file));
    if (!config) return;
    if (!filesSnapshot(root).files.some((file) => file.path === config.schema))
        throw new Error("Subformat schema is not available in the workspace");
    try {
        validateSubformatRecord(
            loadSubformat(root, config, domains),
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
    domains: readonly string[] = [],
): {
    status: number;
    body: {
        file?: string;
        content?: string;
        data?: Record<string, unknown>;
        collection?: SubformatCollection;
        error?: string;
    };
} => {
    try {
        if (input?.action === "validate") {
            if (typeof input.content !== "string") throw new Error("Schema content is required");
            if (input.file !== undefined && typeof input.file !== "string")
                throw new Error("Schema file must be a path");
            compileSubformatSchema(input.content, {
                root,
                file:
                    typeof input.file === "string" && input.file
                        ? input.file
                        : "subformat.schema.json",
                domains,
            });
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
            const raw = readTextfile(root, manifestFile(root));
            const manifest = parseManifestText(raw, manifestFile(root));
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
                const field = loadSubformat(root, config, domains).fields.find(
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
            if (!writeTextfile(root, manifestFile(root), document.toString(), raw))
                return { status: 409, body: { error: "Manifest changed externally. Try again." } };
            return { status: 200, body: { file: manifestFile(root) } };
        }
        if (input?.action === "delete") {
            if (typeof input.ext !== "string") throw new Error("A subformat extension is required");
            const raw = readTextfile(root, manifestFile(root));
            const manifest = parseManifestText(raw, manifestFile(root));
            if (manifest.errors.length) throw new Error(manifest.errors.join("\n"));
            const index =
                manifest.subformats?.findIndex((format) => format.ext === input.ext) ?? -1;
            const config = manifest.subformats?.[index];
            if (!config) throw new Error("Unknown subformat");
            if (!isDeepStrictEqual(config, parseSubformats([input.base])[0]))
                return {
                    status: 409,
                    body: { error: "Subformat changed externally. Reload and try again." },
                };
            const id = subformatPageId(input.ext);
            if (flattenTree(manifest.tree).some((node) => node.parent === id))
                throw new Error(
                    "Move or remove this subformat page's child pages before deleting it.",
                );
            const document = parseDocument(raw);
            const nested = manifest.format === "nested";
            document.deleteIn([nested ? "json_subformats" : "subformats", index]);
            const pages = document.get(nested ? "center_contents" : "docs", true);
            if (isSeq(pages))
                visit(pages, {
                    Map: (_key, node) => {
                        if (node.get("subformat") === input.ext) return visit.REMOVE;
                    },
                });
            if (!nested && document.hasIn(["files", "icons", id]))
                document.deleteIn(["files", "icons", id]);
            const content = document.toString();
            const next = parseManifestText(content, manifestFile(root));
            if (next.errors.length) throw new Error(next.errors.join("\n"));
            if (!writeTextfile(root, manifestFile(root), content, raw))
                return { status: 409, body: { error: "Manifest changed externally. Try again." } };
            return { status: 200, body: { file: manifestFile(root) } };
        }
        if (input?.action === "register") {
            const raw = readTextfile(root, manifestFile(root));
            const manifest = parseManifestText(raw, manifestFile(root));
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
            compileSubformatSchema(initial, { root, file: config.schema, domains });
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
            const loaded = loadSubformat(root, config, domains);
            const parsed = parseDocument(raw);
            const document =
                isSeq(parsed.contents) || parsed.contents == null
                    ? new Document({ docs: parsed.toJS() ?? [] })
                    : parsed;
            if (document !== parsed) document.commentBefore = parsed.commentBefore;
            const key = manifest.format === "nested" ? "json_subformats" : "subformats";
            if (document.has(key)) document.addIn([key], config);
            else document.set(key, [config]);
            if (!writeTextfile(root, manifestFile(root), document.toString(), raw))
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
            validateSubformatFile(root, input.file, input.content, domains);
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
        const format = loadSubformat(root, config, domains);
        const field = format.fields.find((field) => field.name === input.field);
        if (
            field?.readOnly ||
            !(field?.enum ?? field?.options)?.some((value) => value === input.value)
        )
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

/**
 * Relations between subformats as a schemath model: one table per subformat, one field per
 * top-level property. A property is a relation when it follows a `$ref` into another subformat's
 * schema file, or when its string pattern ends with a registered record extension (`\\.ext$`).
 */
export const subformatRelations = (
    root: string,
    configs: readonly Subformat[],
    domains: readonly string[] = [],
): SchemaModel => {
    const loaded = configs.flatMap((config) => {
        try {
            const compiled = compileSubformatSchema(readTextfile(root, config.schema), {
                root,
                file: config.schema,
                domains,
            });
            return [{ ext: config.ext, ...compiled }];
        } catch {
            // Broken schemas are reported by the resource index.
            return [];
        }
    });
    const owners = new Map(loaded.map(({ ext, context }) => [context.uri, ext]));
    const model: SchemaModel = { groups: [], tables: [], edges: [] };
    for (const { ext, schema, context } of loaded) {
        const resolve = schemaResolver(schema, context);
        const fields: SchemaTable["fields"] = [];
        for (const [name, definition] of Object.entries(resolve(schema).properties ?? {})) {
            const targets = new Set<string>();
            let list = false;
            const seen = new Set<unknown>();
            const walk = (value: unknown): SchemaObject => {
                const node = resolve(value, (uri) => {
                    const owner = owners.get(uri.split("#")[0] ?? "");
                    if (owner && owner !== ext) targets.add(owner);
                });
                if (seen.has(value)) return node;
                seen.add(value);
                const suffix =
                    typeof node.pattern === "string" && /\\\.([\w-]+)\$$/.exec(node.pattern)?.[1];
                if (suffix && loaded.some((item) => item.ext === suffix)) targets.add(suffix);
                for (const key of ["anyOf", "oneOf", "allOf"])
                    if (Array.isArray(node[key])) for (const child of node[key]) walk(child);
                // Nested objects count for their top-level field (`listeners[].target`).
                if (schemaObject(node.properties))
                    for (const child of Object.values(node.properties)) walk(child);
                if (node.items !== undefined) {
                    list = true;
                    walk(node.items);
                }
                return node;
            };
            const property = walk(definition);
            const type = Array.isArray(property.enum)
                ? property.enum.map((value) => JSON.stringify(value)).join("|")
                : property.format === "date" || property.format === "date-time"
                  ? "timestamp"
                  : property.type === "string"
                    ? "string"
                    : property.type === "number" || property.type === "integer"
                      ? "number"
                      : property.type === "boolean"
                        ? "bool"
                        : "json";
            for (const to of targets)
                model.edges.push({ from: ext, fieldIndex: fields.length, field: name, to, list });
            fields.push(
                targets.size
                    ? { name, kind: list ? "fkList" : "fk", targets: [...targets] }
                    : { name, kind: "scalar", type },
            );
        }
        model.tables.push({ name: ext, fields, notes: [] });
        // One group per table: the layout derives its columns from inter-group edges.
        model.groups.push({ tables: [ext] });
    }
    return model;
};
