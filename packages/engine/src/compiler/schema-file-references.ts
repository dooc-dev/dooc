import { type SchemaObject, schemaObject } from "../core/schema-fields.js";
import { visitSchema } from "../core/schema-refs.js";
import { posix, readFileSync } from "./host.js";
import { textfilePath } from "./textfile.js";

/** Rewrite only schema positions in registered local schemas and their local dependencies. */
export const rewriteSchemaFiles = (
    root: string,
    registered: readonly string[],
    files: readonly string[],
    moves: ReadonlyMap<string, string>,
): Map<string, string> => {
    const writes = new Map<string, string>();
    if (!moves.size) return writes;
    const uri = (file: string): string =>
        `file:///${file.split("/").map(encodeURIComponent).join("/")}`;
    const local = (url: URL): string | undefined =>
        url.protocol === "file:" && !url.host && !url.search
            ? decodeURIComponent(url.pathname.slice(1))
            : undefined;
    const available = new Set(files);
    const pending = new Set(registered.filter((file) => available.has(file)));
    const sources = new Map<string, { raw: string; schema: SchemaObject }>();
    for (const file of pending) {
        const raw = readFileSync(textfilePath(root, file), "utf8");
        let schema: unknown;
        try {
            schema = JSON.parse(raw);
        } catch {
            // Malformed schemas have no safely editable references; keep their bytes intact.
            continue;
        }
        if (!schemaObject(schema)) continue;
        sources.set(file, { raw, schema });
        visitSchema(schema, uri(file), (node, base) => {
            for (const key of ["$ref", "$dynamicRef"]) {
                if (typeof node[key] !== "string") continue;
                const target = local(new URL(node[key], base));
                if (target && available.has(target)) pending.add(target);
            }
        });
    }
    const bases = new WeakMap<SchemaObject, string>();
    const resources = new Map<string, string>();
    for (const [file, { schema }] of sources) {
        visitSchema(schema, uri(moves.get(file) ?? file), (node, base) => bases.set(node, base));
        visitSchema(schema, uri(file), (node, base) => {
            if (node === schema || typeof node.$id === "string")
                resources.set(base, bases.get(node) as string);
        });
    }
    for (const [file, { raw, schema }] of sources) {
        let changed = false;
        visitSchema(schema, uri(file), (node, base) => {
            const nextBase = bases.get(node) as string;
            for (const key of ["$ref", "$dynamicRef"]) {
                const ref = node[key];
                if (typeof ref !== "string") continue;
                const target = new URL(ref, base);
                const path = local(target);
                if (path === undefined) continue;
                const fragment = target.hash;
                target.hash = "";
                const destination = new URL(
                    resources.get(target.href) ?? uri(moves.get(path) ?? path),
                );
                destination.hash = fragment;
                if (new URL(ref, nextBase).href === destination.href) continue;
                const owner = new URL(nextBase);
                node[key] = ref.startsWith("file:")
                    ? destination.href
                    : (owner.pathname === destination.pathname
                          ? ""
                          : posix.relative(posix.dirname(owner.pathname), destination.pathname)) +
                      destination.hash;
                changed = true;
            }
        });
        if (changed)
            writes.set(
                file,
                JSON.stringify(schema, null, raw.match(/\n([\t ]+)"/)?.[1] ?? 2) +
                    (raw.endsWith("\n") ? "\n" : ""),
            );
    }
    return writes;
};
