import { parseDocument } from "yaml";
import type { TermEntry } from "../core/content-types.js";

/** The internal identity is a file path, or a document position for an inline definition. */
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
