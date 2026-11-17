import { parse } from "yaml";
import type { VersionConfig, VersionInput } from "../core/document-version.js";
import { exportEntries } from "./export.js";
import { createHash } from "./host.js";
import { withIgnoredFilesCache } from "./ignored-files.js";
import { manifestFile } from "./manifest.js";
import type { ZipEntry } from "./zip.js";

const canonical = (value: unknown, parents = new Set<object>()): unknown => {
    if (!value || typeof value !== "object") return value;
    if (parents.has(value)) throw new Error("Circular manifest values cannot be versioned");
    parents.add(value);
    try {
        return Array.isArray(value)
            ? value.map((item) => canonical(item, parents))
            : Object.fromEntries(
                  Object.entries(value)
                      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                      .map(([key, item]) => [key, canonical(item, parents)]),
              );
    } finally {
        parents.delete(value);
    }
};

export const versionInput = (
    root: string,
    config: VersionConfig,
    entries: readonly ZipEntry[] = withIgnoredFilesCache(() => exportEntries(root)),
    manifest = manifestFile(root),
): VersionInput => {
    const source = entries.find((entry) => entry.name === manifest);
    if (!source) throw new Error(`Version source is missing ${manifest}`);
    const definition = parse(source.data.toString("utf8"));
    if (definition && typeof definition === "object" && !Array.isArray(definition))
        delete definition.version;
    const content = createHash("sha256");
    for (const { name, data } of entries
        .filter((entry) => entry.name !== manifest)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        content.update(JSON.stringify([name, data.byteLength]));
        content.update(data);
    }
    return {
        config,
        definition: createHash("sha256")
            .update(JSON.stringify(canonical(definition)))
            .digest("hex"),
        content: content.digest("hex"),
    };
};
