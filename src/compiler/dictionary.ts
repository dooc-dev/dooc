import { parseDocument } from "yaml";
import type { DictEntry } from "../core/artifact-types.js";

export interface DictionarySource {
    file: string;
    entries: readonly DictEntry[];
}

/** Terms share a global namespace. */
export function collectDictionary(sources: readonly DictionarySource[]): {
    entries: DictEntry[];
    errors: string[];
} {
    const entries: DictEntry[] = [];
    const errors: string[] = [];
    const names = new Map<string, string>();
    for (const source of sources) {
        for (const entry of source.entries) {
            const name = entry.term;
            const previous = names.get(name);
            if (previous)
                errors.push(
                    `${source.file}: duplicate dictionary term "${name}" (already defined in ${previous})`,
                );
            else names.set(name, source.file);
            entries.push(entry);
        }
    }
    return { entries, errors };
}

/** :::dictionary contains YAML data, not Markdown. */
export function parseDictionarySource(source: string): {
    entries: DictEntry[];
    errors: { line: number; message: string }[];
} {
    const entries: DictEntry[] = [];
    const errors: { line: number; message: string }[] = [];
    const fail = (message: string): void => {
        errors.push({ line: 0, message });
    };
    let data: unknown;
    try {
        const doc = parseDocument(source);
        if (doc.errors.length) {
            for (const e of doc.errors)
                errors.push({ line: (e.linePos?.[0]?.line ?? 1) - 1, message: e.message });
            return { entries, errors };
        }
        data = doc.toJS({ maxAliasCount: 0 });
    } catch (e) {
        fail(`cannot read YAML: ${e instanceof Error ? e.message : String(e)}`);
        return { entries, errors };
    }
    if (!Array.isArray(data) || data.length === 0) {
        fail("expected a non-empty array of terms");
        return { entries, errors };
    }
    const allowed = new Set(["term", "definition", "reading"]);
    for (const [index, value] of data.entries()) {
        const prefix = `term ${index + 1}`;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            fail(`${prefix}: must be an object with term and definition`);
            continue;
        }
        const row = value as Record<string, unknown>;
        const before = errors.length;
        for (const key of Object.keys(row))
            if (!allowed.has(key)) fail(`${prefix}: unknown field "${key}"`);
        for (const key of ["term", "definition", "reading"]) {
            if (row[key] === undefined && key === "reading") continue;
            if (typeof row[key] !== "string" || !row[key].trim())
                fail(`${prefix}: ${key} must be a non-empty string`);
        }
        if (errors.length === before) entries.push(row as unknown as DictEntry);
    }
    for (const message of collectDictionary([{ file: "this block", entries }]).errors)
        fail(message);
    return { entries, errors };
}
