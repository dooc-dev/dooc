import { localFile } from "./files.js";

export const SUBFORMAT_SCHEMA_VERSION = "https://json-schema.org/draft/2020-12/schema";
export const SUBFORMAT_SCHEMA_TEMPLATE = `${JSON.stringify(
    {
        $schema: SUBFORMAT_SCHEMA_VERSION,
        type: "object",
        properties: {},
        additionalProperties: false,
    },
    null,
    2,
)}\n`;

export interface Subformat {
    ext: string;
    format: "yaml" | "json" | "toml";
    schema: string;
    layouts?: {
        card_title?: string;
        group_by?: string;
        sort_by?: string;
        sort_order?: "asc" | "desc";
    };
}

export interface SubformatField {
    name: string;
    title: string;
    type?: "string" | "number" | "integer" | "boolean";
    enum?: (string | number | boolean | null)[];
    format?: "date" | "date-time";
    readOnly?: boolean;
}

export interface SubformatRecord {
    file: string;
    content: string;
    data: Record<string, unknown>;
    change?: "added" | "modified";
    references?: { file: string; line: number }[];
}

export interface SubformatCollection extends Subformat {
    change?: "added" | "modified";
    baseLayouts?: NonNullable<Subformat["layouts"]>;
    fields: SubformatField[];
    template?: string;
    defaultFolder?: string;
    records: SubformatRecord[];
}

export const subformatSourcePath = (file: string, base = ""): string =>
    base + (/^https?:\/\//i.test(base) ? file.split("/").map(encodeURIComponent).join("/") : file);

export const subformatChange = (collection: SubformatCollection): SubformatRecord["change"] =>
    collection.change ??
    (collection.records.some((record) => record.change === "modified")
        ? "modified"
        : collection.records.some((record) => record.change === "added")
          ? "added"
          : undefined);

export const parseSubformats = (input: unknown): Subformat[] => {
    if (!Array.isArray(input)) throw new Error("subformats must be a list");
    const seen = new Set<string>();
    return input.map((value) => {
        if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            Object.keys(value).some(
                (key) => !["ext", "format", "schema", "layouts"].includes(key),
            ) ||
            typeof value.ext !== "string" ||
            !/^[a-z0-9][a-z0-9_-]*$/.test(value.ext) ||
            !["yaml", "json", "toml"].includes(value.format) ||
            !localFile(value.schema)
        )
            throw new Error(
                "Each subformat requires ext (without a dot), format (yaml, json or toml), and a local schema path",
            );
        if (
            value.layouts !== undefined &&
            (!value.layouts ||
                typeof value.layouts !== "object" ||
                Array.isArray(value.layouts) ||
                Object.entries(value.layouts).some(([key, item]) =>
                    key === "sort_order"
                        ? item !== "asc" && item !== "desc"
                        : !["card_title", "group_by", "sort_by"].includes(key) ||
                          typeof item !== "string",
                ))
        )
            throw new Error(
                "Subformat layouts accept card_title, group_by, sort_by field names and sort_order (asc or desc)",
            );
        if (seen.has(value.ext)) throw new Error(`Duplicate subformat extension: ${value.ext}`);
        seen.add(value.ext);
        return {
            ext: value.ext,
            format: value.format,
            schema: value.schema,
            ...(value.layouts === undefined ? {} : { layouts: { ...value.layouts } }),
        };
    });
};

export const sortSubformatRecords = (
    records: readonly SubformatRecord[],
    field?: SubformatField,
    descending = false,
): SubformatRecord[] =>
    [...records].sort((a, b) => {
        const value = (record: SubformatRecord): string | number | undefined => {
            if (!field) return record.file;
            const item = record.data[field.name];
            if (field.enum) {
                const index = field.enum.indexOf(item as (typeof field.enum)[number]);
                return index < 0 ? undefined : index;
            }
            if (item == null) return undefined;
            if (field.format) {
                const time = typeof item === "string" ? Date.parse(item) : Number.NaN;
                return Number.isNaN(time) ? undefined : time;
            }
            if (typeof item === "boolean") return Number(item);
            return typeof item === "string" || (typeof item === "number" && Number.isFinite(item))
                ? item
                : undefined;
        };
        const left = value(a);
        const right = value(b);
        if ((left === undefined) !== (right === undefined)) return left === undefined ? 1 : -1;
        const order =
            typeof left === "number" && typeof right === "number"
                ? left - right
                : typeof left === "string" && typeof right === "string"
                  ? left.localeCompare(right, undefined, { numeric: true })
                  : 0;
        return order * (descending ? -1 : 1) || a.file.localeCompare(b.file);
    });
