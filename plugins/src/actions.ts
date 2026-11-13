import { PluginError } from "./oauth.js";
import type { PluginUser } from "./types.js";

export interface PluginActionContext {
    user: PluginUser;
    request(
        url: string,
        init?: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown },
    ): Promise<unknown>;
}
export interface PluginActionField {
    name: string;
    label: string;
    type: "text" | "textarea" | "select" | "multiselect" | "date" | "number";
    required?: boolean;
    value?: string;
    maxLength?: number;
    min?: number;
    max?: number;
    options?: { value: string; label: string }[];
}
export interface PluginAction {
    id: string;
    label: string;
    target: string;
    fields: PluginActionField[];
    destructive?: boolean;
    confirm?: boolean;
    version?: string;
    partial?: boolean;
}
export interface PluginActionRequest {
    id: string;
    values: Record<string, string>;
    version?: string;
    confirmed?: boolean;
}
export interface PluginActionResult {
    message: string;
    deleted?: boolean;
}

export const validatePluginActions = (input: unknown): PluginAction[] => {
    if (
        new TextEncoder().encode(JSON.stringify(input)).length > 2 * 1024 * 1024 ||
        !Array.isArray(input) ||
        input.length > 500
    )
        throw new Error("Invalid plugin actions");
    const ids = new Set<string>();
    const string = (v: unknown): v is string => typeof v === "string" && v.length <= 60_000;
    const optionalBoolean = (v: unknown) => v === undefined || typeof v === "boolean";
    for (const action of input as PluginAction[]) {
        if (
            !action ||
            !string(action.id) ||
            !action.id ||
            ids.has(action.id) ||
            !string(action.label) ||
            !string(action.target) ||
            !Array.isArray(action.fields) ||
            action.fields.length > 40 ||
            !optionalBoolean(action.destructive) ||
            !optionalBoolean(action.confirm) ||
            !optionalBoolean(action.partial) ||
            (action.version !== undefined && !string(action.version))
        )
            throw new Error("Invalid plugin actions");
        ids.add(action.id);
        const names = new Set<string>();
        for (const field of action.fields) {
            if (
                !field ||
                !string(field.name) ||
                !/^[a-zA-Z][\w.:-]{0,199}$/.test(field.name) ||
                names.has(field.name) ||
                !string(field.label) ||
                !["text", "textarea", "select", "multiselect", "date", "number"].includes(
                    field.type,
                ) ||
                !optionalBoolean(field.required) ||
                (field.value !== undefined && !string(field.value)) ||
                (field.maxLength !== undefined &&
                    (!Number.isInteger(field.maxLength) ||
                        field.maxLength < 1 ||
                        field.maxLength > 60_000)) ||
                [field.min, field.max].some(
                    (v) => v !== undefined && (typeof v !== "number" || !Number.isFinite(v)),
                ) ||
                (field.min !== undefined && field.max !== undefined && field.min > field.max) ||
                (["select", "multiselect"].includes(field.type) &&
                    (!Array.isArray(field.options) ||
                        field.options.length > 1000 ||
                        field.options.some((o) => !o || !string(o.value) || !string(o.label))))
            )
                throw new Error("Invalid plugin action field");
            if (field.type === "multiselect" && field.value !== undefined) {
                let values: unknown;
                try {
                    values = JSON.parse(field.value);
                } catch {
                    throw new Error("Invalid plugin action selection");
                }
                if (!Array.isArray(values) || values.some((v) => typeof v !== "string"))
                    throw new Error("Invalid plugin action selection");
            }
            names.add(field.name);
        }
    }
    return input;
};

export const validatePluginActionRequest = (input: unknown): PluginActionRequest => {
    const request = input as PluginActionRequest;
    if (
        !request ||
        typeof request.id !== "string" ||
        !request.id ||
        request.id.length > 1000 ||
        !request.values ||
        typeof request.values !== "object" ||
        Array.isArray(request.values) ||
        Object.keys(request.values).length > 40 ||
        Object.values(request.values).some((v) => typeof v !== "string" || v.length > 60_000) ||
        (request.version !== undefined &&
            (typeof request.version !== "string" || request.version.length > 1000)) ||
        (request.confirmed !== undefined && typeof request.confirmed !== "boolean")
    )
        throw new PluginError(400, "Invalid plugin operation");
    return request;
};

export const validatePluginActionValues = (
    action: PluginAction,
    input: PluginActionRequest,
): void => {
    if ((action.destructive || action.confirm) && input.confirmed !== true)
        throw new PluginError(400, "Confirm the operation target");
    if (action.version !== undefined && input.version !== action.version)
        throw new PluginError(409, "Content changed. Reload before saving.");
    if (
        Object.keys(input.values).some(
            (key) => !action.fields.some((field) => field.name === key),
        ) ||
        (action.partial && !Object.keys(input.values).length)
    )
        throw new PluginError(400, "Invalid operation fields");
    for (const field of action.fields) {
        if (action.partial && !Object.hasOwn(input.values, field.name)) continue;
        const value = input.values[field.name] ?? "";
        const invalid = () => {
            throw new PluginError(400, `Invalid value: ${field.label}`);
        };
        if (value.length > (field.maxLength ?? 4000) || (field.required && !value.trim()))
            invalid();
        if (field.type === "select" && !field.options?.some((o) => o.value === value)) invalid();
        if (field.type === "multiselect") {
            let selected: unknown;
            try {
                selected = JSON.parse(value);
            } catch {
                invalid();
            }
            if (
                !Array.isArray(selected) ||
                (field.required && !selected.length) ||
                new Set(selected).size !== selected.length ||
                selected.some((v) => !field.options?.some((o) => o.value === v))
            )
                invalid();
        }
        if (
            value &&
            field.type === "date" &&
            (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
                !Number.isFinite(Date.parse(value)) ||
                new Date(value).toISOString().slice(0, 10) !== value)
        )
            invalid();
        if (
            value &&
            field.type === "number" &&
            (!Number.isFinite(Number(value)) ||
                Number(value) < (field.min ?? -Infinity) ||
                Number(value) > (field.max ?? Infinity))
        )
            invalid();
    }
};
