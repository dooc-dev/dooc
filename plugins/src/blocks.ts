export type PluginTone = "neutral" | "accent" | "success" | "warning" | "danger";
export type PluginInline =
    | string
    | {
          text: string;
          url?: string;
          code?: boolean;
          strong?: boolean;
          tone?: PluginTone;
          copy?: string;
      };
export interface PluginEdit {
    action: string;
    field?: string;
}
export interface PluginCell {
    items: PluginInline[];
    edit?: PluginEdit;
}
export type PluginBlock =
    | { type: "heading" | "text"; text: string; markdown?: boolean; edit?: PluginEdit }
    | { type: "context"; items: PluginInline[] }
    | { type: "fields"; items: (PluginCell & { label: string })[] }
    | { type: "section"; title: string; blocks: PluginBlock[]; collapsed?: boolean; note?: string }
    | { type: "columns"; main: PluginBlock[]; aside: PluginBlock[] }
    | { type: "table"; headers: string[]; rows: { cells: PluginCell[]; actions?: string[] }[] }
    | { type: "code"; text: string; diff?: boolean; edit?: PluginEdit }
    | {
          type: "message";
          author: string;
          text: string;
          time?: string;
          edit?: PluginEdit;
          actions?: string[];
          reactions?: {
              label: string;
              count: number;
              active?: boolean;
              action?: string;
              values?: Record<string, string>;
          }[];
      }
    | { type: "actions"; ids: string[]; composer?: boolean }
    | { type: "progress"; label: string; value: number }
    | { type: "divider" };

export interface PluginIcon {
    light: string;
    dark?: string;
}

export interface PluginBlockContent {
    header?: {
        title: string;
        context?: string;
        reference?: string;
        icon?: PluginIcon;
    };
    blocks: PluginBlock[];
}

const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
    typeof value === "string" && value.length <= 60_000;
const optional = (value: unknown, check: (value: unknown) => boolean): boolean =>
    value === undefined || check(value);
const flag = (value: unknown): boolean => typeof value === "boolean";
const array = (value: unknown, check: (value: unknown) => boolean, limit = 200): boolean =>
    Array.isArray(value) && value.length <= limit && value.every(check);
export const pluginLink = (value: unknown): value is string => {
    if (typeof value !== "string" || value.length > 4096 || /[\s\\\p{Cc}]/u.test(value))
        return false;
    try {
        const url = new URL(value);
        return /^https?:$/.test(url.protocol) && !url.username && !url.password;
    } catch {
        return false;
    }
};
const icon = (value: unknown): boolean =>
    typeof value === "string" &&
    value.length <= 100_000 &&
    /^data:image\/(?:svg\+xml|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
export const validPluginIcon = (value: unknown): value is PluginIcon =>
    record(value) && icon(value.light) && optional(value.dark, icon);
const edit = (value: unknown): boolean =>
    record(value) && text(value.action) && optional(value.field, text);
const inlines = (value: unknown): boolean =>
    array(
        value,
        (item) =>
            text(item) ||
            (record(item) &&
                text(item.text) &&
                optional(item.url, pluginLink) &&
                optional(item.code, flag) &&
                optional(item.strong, flag) &&
                optional(item.copy, text) &&
                optional(item.tone, (v) =>
                    ["neutral", "accent", "success", "warning", "danger"].includes(String(v)),
                )),
    );
const cell = (value: unknown): boolean =>
    record(value) && inlines(value.items) && optional(value.edit, edit);

export const validPluginBlocks = (value: unknown): value is PluginBlockContent => {
    let count = 0;
    const blocks = (value: unknown, depth: number): boolean =>
        depth <= 8 &&
        array(value, (item) => {
            if (++count > 2000 || !record(item)) return false;
            if (!optional(item.edit, edit)) return false;
            switch (item.type) {
                case "heading":
                case "text":
                    return text(item.text) && optional(item.markdown, flag);
                case "context":
                    return inlines(item.items);
                case "fields":
                    return array(item.items, (v) => cell(v) && record(v) && text(v.label));
                case "section":
                    return (
                        text(item.title) &&
                        blocks(item.blocks, depth + 1) &&
                        optional(item.collapsed, flag) &&
                        optional(item.note, text)
                    );
                case "columns":
                    return blocks(item.main, depth + 1) && blocks(item.aside, depth + 1);
                case "table":
                    return (
                        array(item.headers, text, 40) &&
                        array(
                            item.rows,
                            (v) =>
                                record(v) &&
                                array(v.cells, cell, 40) &&
                                (v.cells as unknown[]).length ===
                                    (item.headers as unknown[]).length &&
                                optional(v.actions, (v) => array(v, text)),
                        )
                    );
                case "code":
                    return text(item.text) && optional(item.diff, flag);
                case "message":
                    return (
                        text(item.author) &&
                        text(item.text) &&
                        optional(item.time, text) &&
                        optional(item.actions, (v) => array(v, text)) &&
                        optional(item.reactions, (v) =>
                            array(
                                v,
                                (r) =>
                                    record(r) &&
                                    text(r.label) &&
                                    typeof r.count === "number" &&
                                    Number.isInteger(r.count) &&
                                    r.count >= 0 &&
                                    optional(r.active, flag) &&
                                    optional(r.action, text) &&
                                    optional(
                                        r.values,
                                        (v) =>
                                            record(v) &&
                                            Object.keys(v).length <= 40 &&
                                            Object.values(v).every(text),
                                    ),
                            ),
                        )
                    );
                case "actions":
                    return array(item.ids, text) && optional(item.composer, flag);
                case "progress":
                    return (
                        text(item.label) &&
                        typeof item.value === "number" &&
                        Number.isFinite(item.value) &&
                        item.value >= 0 &&
                        item.value <= 100
                    );
                case "divider":
                    return true;
                default:
                    return false;
            }
        });
    return (
        record(value) &&
        !("format" in value) &&
        blocks(value.blocks, 0) &&
        optional(
            value.header,
            (h) =>
                record(h) &&
                text(h.title) &&
                optional(h.context, text) &&
                optional(h.reference, text) &&
                optional(h.icon, validPluginIcon),
        )
    );
};
