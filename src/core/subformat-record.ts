import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { type AST, parseTOML } from "toml-eslint-parser";
import { parseDocument } from "yaml";
import type { Subformat } from "./subformats.js";

const yamlDocument = (content: string) => {
    const document = parseDocument(content);
    if (document.errors.length || document.warnings.length)
        throw new Error(
            [...document.errors, ...document.warnings].map((error) => error.message).join("; "),
        );
    return document;
};

export const parseSubformatRecord = (
    content: string,
    format: Subformat["format"],
): Record<string, unknown> => {
    const value =
        format === "json"
            ? JSON.parse(content)
            : format === "yaml"
              ? yamlDocument(content).toJS()
              : parseToml(content, { integersAsBigInt: "asNeeded" });
    const data = JSON.parse(
        JSON.stringify(value, (_key, item) => {
            if (
                typeof item === "bigint" ||
                (typeof item === "number" &&
                    (!Number.isFinite(item) ||
                        (Number.isInteger(item) && !Number.isSafeInteger(item))))
            )
                throw new Error("Records require finite JSON-compatible numbers");
            return item;
        }),
    );
    if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error("Each record file must contain one object");
    return data;
};

const jsonKey = (value: unknown): string =>
    JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
            ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
            : item,
    );

const tomlValue = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
    if (value && typeof value === "object")
        return `{ ${Object.entries(value)
            .map(([key, item]) => `${JSON.stringify(key)} = ${tomlValue(item)}`)
            .join(", ")} }`;
    return stringifyToml({ value })
        .replace(/^value\s*=\s*/, "")
        .trimEnd();
};

export const setSubformatValue = (
    source: string,
    format: Subformat["format"],
    path: (string | number)[],
    value: unknown,
): string => {
    const data = parseSubformatRecord(source, format);
    const key = path.at(-1);
    if (key === undefined) throw new Error("A field path is required");
    let parent: unknown = data;
    for (const part of path.slice(0, -1)) {
        if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, part))
            throw new Error("The record changed. Try again.");
        parent = (parent as Record<string | number, unknown>)[part];
    }
    if (!parent || typeof parent !== "object") throw new Error("The record changed. Try again.");
    Object.defineProperty(parent, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
    });
    let content: string;
    if (format === "yaml") {
        const document = yamlDocument(source);
        document.setIn(path, value);
        content = document.toString();
    } else if (format === "toml") {
        let found: AST.TOMLContentNode | undefined;
        const visit = (node: AST.TOMLContentNode, keys: (string | number)[]) => {
            if (JSON.stringify(keys) === JSON.stringify(path)) found = node;
            if (node.type === "TOMLArray")
                node.elements.forEach((item, index) => {
                    visit(item, [...keys, index]);
                });
            else if (node.type === "TOMLInlineTable") entries(node.body, keys);
        };
        const entries = (nodes: AST.TOMLKeyValue[], keys: (string | number)[]) => {
            for (const node of nodes)
                visit(node.value, [
                    ...keys,
                    ...node.key.keys.map((key) => (key.type === "TOMLBare" ? key.name : key.value)),
                ]);
        };
        const nodes = parseTOML(source).body[0].body;
        for (const node of nodes) {
            if (node.type === "TOMLTable") entries(node.body, node.resolvedKey);
            else entries([node], []);
        }
        if (found)
            content =
                source.slice(0, found.range[0]) + tomlValue(value) + source.slice(found.range[1]);
        else {
            let remaining = source;
            for (const node of [...nodes].reverse()) {
                const keys =
                    node.type === "TOMLTable"
                        ? node.resolvedKey
                        : node.key.keys.map((key) =>
                              key.type === "TOMLBare" ? key.name : key.value,
                          );
                if (path.every((part, index) => keys[index] === part))
                    remaining = remaining.slice(0, node.range[0]) + remaining.slice(node.range[1]);
            }
            const table = parseTOML(remaining)
                .body[0].body.filter(
                    (node): node is AST.TOMLTable =>
                        node.type === "TOMLTable" &&
                        node.resolvedKey.length < path.length &&
                        node.resolvedKey.every((part, index) => part === path[index]),
                )
                .sort((a, b) => b.resolvedKey.length - a.resolvedKey.length)[0];
            const keys = path.slice(table?.resolvedKey.length ?? 0);
            if (keys.some((key) => typeof key !== "string"))
                throw new Error("Use TOML text to edit this value.");
            const offset = table ? remaining.indexOf("\n", table.key.range[1]) + 1 : 0;
            if (table && !offset) throw new Error("Use TOML text to edit this value.");
            content =
                remaining.slice(0, offset) +
                `${keys.map((key) => (/^[A-Za-z0-9_-]+$/.test(String(key)) ? key : JSON.stringify(key))).join(".")} = ${tomlValue(value)}\n` +
                remaining.slice(offset);
        }
    } else {
        const indent = /\n([ \t]+)"/.exec(source)?.[1];
        content = JSON.stringify(data, null, indent) + (source.endsWith("\n") ? "\n" : "");
    }
    if (source.includes("\r\n")) content = content.replace(/\r?\n/g, "\r\n");
    if (jsonKey(parseSubformatRecord(content, format)) !== jsonKey(data))
        throw new Error("The updated record cannot be saved without changing other values");
    return content;
};
