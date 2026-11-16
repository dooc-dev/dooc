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
    /** Local SVG file shown wherever the subformat is listed. */
    icon?: string;
    layouts?: {
        view?: "card" | "list";
        card_title?: string;
        group_by?: string;
        sort_by?: string;
        sort_order?: "asc" | "desc";
    };
}

export interface SubformatEmbedOptions {
    view?: "card" | "list" | "table";
    title?: string;
    card_title?: string;
    group_by?: string;
    sort_by?: string;
    sort_order?: "asc" | "desc";
    fields?: string[];
    q?: string;
    filters?: SubformatFilter[];
}

export const SUBFORMAT_FILTER_OPERATORS = {
    eq: "Equals",
    ne: "Does not equal",
    contains: "Contains",
    in: "Is one of",
    gt: "Greater than",
    gte: "At least",
    lt: "Less than",
    lte: "At most",
    empty: "Is empty",
} as const;
export type SubformatFilterOperator = keyof typeof SUBFORMAT_FILTER_OPERATORS;
export type SubformatFilter = [field: string, value: string, operator?: SubformatFilterOperator];

export const parseSubformatQuery = (query: string): SubformatEmbedOptions => {
    const options: SubformatEmbedOptions = {};
    const seen = new Set<string>();
    for (const [key, value] of new URLSearchParams(query)) {
        if (seen.has(key)) throw new Error(`Duplicate embed parameter: ${key}`);
        seen.add(key);
        if (key === "view" && ["card", "list", "table"].includes(value))
            options.view = value as SubformatEmbedOptions["view"];
        else if (key === "title" || key === "q") options[key] = value;
        else if (key === "card_title" || key === "group_by" || key === "sort_by")
            options[key] = value;
        else if (key === "sort_order" && (value === "asc" || value === "desc"))
            options.sort_order = value;
        else if (key === "fields") {
            options.fields = value === "" ? [] : value.split(",").map((field) => field.trim());
            if (
                options.fields.some((field) => !field) ||
                new Set(options.fields).size !== options.fields.length
            )
                throw new Error("Embed fields must be distinct, non-empty field names");
        } else if (key.startsWith("filter.") && key.length > 7) {
            const match = /^(.+?)(?:\[([a-z]+)\])?$/.exec(key.slice(7));
            const operator = match?.[2];
            if (!match || (operator && !Object.hasOwn(SUBFORMAT_FILTER_OPERATORS, operator)))
                throw new Error(`Unknown subformat filter operator: ${key}`);
            options.filters ??= [];
            options.filters.push(
                operator
                    ? [match[1] as string, value, operator as SubformatFilterOperator]
                    : [match[1] as string, value],
            );
        } else throw new Error(`Unknown embed parameter or value: ${key}=${value}`);
    }
    return options;
};

export interface SubformatField {
    name: string;
    title: string;
    type?: "string" | "number" | "integer" | "boolean";
    enum?: (string | number | boolean | null)[];
    format?: "date" | "date-time";
    readOnly?: boolean;
    /** Record files a reference field may point to (its pattern ends with `\\.<ext>$`). */
    options?: string[];
}

export const subformatFilterOperators = (field: SubformatField): SubformatFilterOperator[] =>
    (Object.keys(SUBFORMAT_FILTER_OPERATORS) as SubformatFilterOperator[]).filter(
        (operator) =>
            !["gt", "gte", "lt", "lte"].includes(operator) ||
            field.type === "number" ||
            field.type === "integer" ||
            !!field.format,
    );

export const validateSubformatOptions = (
    options: SubformatEmbedOptions,
    fields: SubformatField[],
): void => {
    for (const name of options.fields ?? [])
        if (!fields.some((field) => field.name === name))
            throw new Error(`Unknown subformat display field: ${name}`);
    for (const key of ["card_title", "group_by", "sort_by"] as const) {
        if (!options[key]) continue;
        const field = fields.find((field) => field.name === options[key]);
        if (
            !field ||
            (key === "group_by" && !field.enum?.length) ||
            (key === "sort_by" && !field.enum && !field.format && !field.type)
        )
            throw new Error(`Invalid subformat ${key} field: ${options[key]}`);
    }
    for (const [name, value, operator = "eq"] of options.filters ?? []) {
        const field = fields.find((field) => field.name === name);
        if (!field) throw new Error(`Unknown subformat filter field: ${name}`);
        if (!subformatFilterOperators(field).includes(operator))
            throw new Error(`Unsupported subformat filter operator for ${name}: ${operator}`);
        if (operator === "empty" && value !== "true" && value !== "false")
            throw new Error(`Subformat empty filter requires true or false: ${name}`);
        if (operator === "in" && value.split(",").some((item) => !item.trim()))
            throw new Error(`Subformat in filter requires comma-separated values: ${name}`);
        if (
            ["gt", "gte", "lt", "lte"].includes(operator) &&
            (!value.trim() || !Number.isFinite(field.format ? Date.parse(value) : Number(value)))
        )
            throw new Error(`Invalid subformat comparison value for ${name}: ${value}`);
    }
};

export const matchesSubformatRecord = (
    record: SubformatRecord,
    options: SubformatEmbedOptions,
    fields: SubformatField[],
): boolean => {
    if (options.q) {
        const text = `${record.file} ${record.content}`.normalize("NFKC").toLowerCase();
        if (
            !options.q
                .normalize("NFKC")
                .toLowerCase()
                .trim()
                .split(/\s+/)
                .every((word) => text.includes(word))
        )
            return false;
    }
    return (options.filters ?? []).every(([name, expected, operator = "eq"]) => {
        const present = Object.hasOwn(record.data, name);
        const value = present ? record.data[name] : undefined;
        if (operator === "empty")
            return (
                (!present ||
                    value == null ||
                    value === "" ||
                    (Array.isArray(value) && !value.length)) ===
                (expected === "true")
            );
        if (!present) return false;
        const scalar = (item: unknown): boolean =>
            item === null || ["string", "number", "boolean"].includes(typeof item);
        if (operator === "contains")
            return typeof value === "string"
                ? value
                      .normalize("NFKC")
                      .toLowerCase()
                      .includes(expected.normalize("NFKC").toLowerCase())
                : Array.isArray(value) &&
                      value.some((item) => scalar(item) && String(item) === expected);
        if (operator === "in")
            return (
                scalar(value) && expected.split(",").some((item) => String(value) === item.trim())
            );
        if (operator === "eq" || operator === "ne")
            return scalar(value) && (String(value) === expected) === (operator === "eq");
        const field = fields.find((field) => field.name === name);
        const left = field?.format && typeof value === "string" ? Date.parse(value) : value;
        const right = field?.format ? Date.parse(expected) : Number(expected);
        if (typeof left !== "number" || !Number.isFinite(left) || !Number.isFinite(right))
            return false;
        return operator === "gt"
            ? left > right
            : operator === "gte"
              ? left >= right
              : operator === "lt"
                ? left < right
                : operator === "lte" && left <= right;
    });
};

export interface SubformatRecord {
    file: string;
    content: string;
    data: Record<string, unknown>;
    change?: "added" | "modified";
    references?: { file: string; line: number; href?: string }[];
}

export interface SubformatCollection extends Subformat {
    change?: "added" | "modified";
    baseLayouts?: NonNullable<Subformat["layouts"]>;
    /** Markup of `icon`, normalized to a square. */
    iconSvg?: string;
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
                (key) => !["ext", "format", "schema", "icon", "layouts"].includes(key),
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
                    key === "view"
                        ? item !== "card" && item !== "list"
                        : key === "sort_order"
                          ? item !== "asc" && item !== "desc"
                          : !["card_title", "group_by", "sort_by"].includes(key) ||
                            typeof item !== "string",
                ))
        )
            throw new Error(
                "Subformat layouts accept view (card or list), card_title, group_by, sort_by field names and sort_order (asc or desc)",
            );
        if (
            value.icon !== undefined &&
            (!localFile(value.icon) || !value.icon.toLowerCase().endsWith(".svg"))
        )
            throw new Error("Subformat icon must be a local .svg file path");
        if (seen.has(value.ext)) throw new Error(`Duplicate subformat extension: ${value.ext}`);
        seen.add(value.ext);
        return {
            ext: value.ext,
            format: value.format,
            schema: value.schema,
            ...(value.icon === undefined ? {} : { icon: value.icon }),
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
