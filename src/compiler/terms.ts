import { parseDocument } from "yaml";
import type { TermEntry } from "../core/artifact-types.js";
import { TERM_ID_RE } from "../core/inline.js";

export interface TermSource {
    file: string;
    entries: readonly TermEntry[];
}

export function collectTerms(sources: readonly TermSource[]): {
    entries: TermEntry[];
    errors: string[];
} {
    const entries: TermEntry[] = [];
    const errors: string[] = [];
    const owners = new Map<string, string>();
    for (const source of sources) {
        for (const entry of source.entries) {
            const previous = owners.get(entry.id);
            if (previous)
                errors.push(
                    `${source.file}: duplicate term ID "${entry.id}" (already defined in ${previous})`,
                );
            else owners.set(entry.id, source.file);
            entries.push(entry);
        }
    }
    return { entries, errors };
}

/** A term definition is a YAML object; its ID comes from :::term(id). */
export function parseTermSource(
    id: string,
    source: string,
): {
    entries: TermEntry[];
    errors: { line: number; message: string }[];
} {
    const entries: TermEntry[] = [];
    const errors: { line: number; message: string }[] = [];
    const fail = (message: string): void => {
        errors.push({ line: 0, message });
    };
    if (!TERM_ID_RE.test(id))
        fail(
            "ID must use lowercase letters, digits, underscores or hyphens, starting with a letter or digit",
        );
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
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        fail("expected a YAML object with name and definition");
        return { entries, errors };
    }
    const row = data as Record<string, unknown>;
    for (const key of Object.keys(row))
        if (key !== "name" && key !== "definition" && key !== "description")
            fail(`unknown field "${key}"`);
    for (const key of ["name", "definition"])
        if (typeof row[key] !== "string" || !row[key].trim())
            fail(`${key} must be a non-empty string`);
    if (row.description !== undefined && typeof row.description !== "string")
        fail("description must be a string");
    if (!errors.length)
        entries.push({
            id,
            name: row.name as string,
            definition: row.definition as string,
            ...(typeof row.description === "string" ? { description: row.description } : {}),
        });
    return { entries, errors };
}
