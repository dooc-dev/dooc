export type VersionPart = number | "git" | "hash";

export interface VersionConfig {
    major: number;
    minor: VersionPart;
    patch: VersionPart;
}

export type DocumentVersion = [major: number, minor: number, patch: number];

export interface DocumentRevision {
    version: string;
    revision: string;
    current: boolean;
}

export interface DocumentVersionList {
    versions: DocumentRevision[];
    selected?: string;
    current?: string;
    selector: string;
    showSelector: boolean;
}

const integer = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const parseVersionConfig = (value: unknown): VersionConfig => {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("version must be an object");
    const input = value as Record<string, unknown>;
    for (const key of Object.keys(input))
        if (!["major", "minor", "patch"].includes(key))
            throw new Error(`version: unknown field "${key}"`);
    const major = input.major === undefined ? 0 : input.major;
    const minor = input.minor === undefined ? "git" : input.minor;
    const patch = input.patch === undefined ? "git" : input.patch;
    if (!integer(major)) throw new Error("version.major must be a non-negative integer");
    for (const [key, part] of [
        ["minor", minor],
        ["patch", patch],
    ] as const)
        if (!integer(part) && part !== "git" && part !== "hash")
            throw new Error(`version.${key} must be a non-negative integer, git, or hash`);
    if (typeof minor === "string" && typeof patch === "string" && minor !== patch)
        throw new Error("version.minor and version.patch must use the same automatic source");
    return { major, minor: minor as VersionPart, patch: patch as VersionPart };
};

export const compareVersions = (a: DocumentVersion, b: DocumentVersion): number =>
    a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

export const parseDocumentVersion = (value: string): DocumentVersion => {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
        throw new Error(`Invalid document version: ${value}`);
    const parts = value.split(".").map(Number);
    if (!parts.every(integer)) throw new Error(`Invalid document version: ${value}`);
    return parts as DocumentVersion;
};

type VersionPattern = (number | "*" | "latest")[];
type VersionComparison = { operator: string; version: DocumentVersion };
export type VersionSelection = { pattern: VersionPattern } | { comparisons: VersionComparison[] };

export const parseVersionSelection = (input = "latest"): VersionSelection => {
    const value = input.trim();
    if (value === "latest") return { pattern: ["latest", "latest", "latest"] };
    if (value === "*") return { pattern: ["*", "*", "*"] };
    const parts = value.split(".");
    if (parts.length === 3 && parts.every((part) => /^(?:0|[1-9]\d*|\*|latest)$/.test(part))) {
        const pattern = parts.map((part) =>
            part === "*" || part === "latest" ? part : Number(part),
        );
        if (pattern.some((part) => typeof part === "number" && !integer(part)))
            throw new Error(`Invalid version selection: ${input}`);
        return { pattern };
    }
    const comparisons = value.split(/\s+/).map((part) => {
        const match = /^(>=|<=|>|<|=)(\d+\.\d+\.\d+)$/.exec(part);
        if (!match) throw new Error(`Invalid version selection: ${input}`);
        return { operator: match[1] as string, version: parseDocumentVersion(match[2] as string) };
    });
    return { comparisons };
};

export const latestVersionOnly = (selection: VersionSelection): boolean =>
    "pattern" in selection && selection.pattern.every((part) => part === "latest");

/** Resolve latest within each selected parent group, never independently across all versions. */
export const selectVersions = <T extends { version: string }>(
    entries: readonly T[],
    selection: VersionSelection,
): T[] => {
    let rows = entries.map((entry) => ({ entry, parts: parseDocumentVersion(entry.version) }));
    if ("comparisons" in selection) {
        rows = rows.filter(({ parts }) =>
            selection.comparisons.every(({ operator, version }) => {
                const order = compareVersions(parts, version);
                return operator === ">="
                    ? order >= 0
                    : operator === "<="
                      ? order <= 0
                      : operator === ">"
                        ? order > 0
                        : operator === "<"
                          ? order < 0
                          : order === 0;
            }),
        );
    } else {
        for (const [index, part] of selection.pattern.entries()) {
            if (part === "*") continue;
            if (typeof part === "number") {
                rows = rows.filter(({ parts }) => parts[index] === part);
                continue;
            }
            const maxima = new Map<string, number>();
            for (const { parts } of rows) {
                const parent = parts.slice(0, index).join(".");
                maxima.set(parent, Math.max(maxima.get(parent) ?? 0, parts[index] as number));
            }
            rows = rows.filter(
                ({ parts }) => parts[index] === maxima.get(parts.slice(0, index).join(".")),
            );
        }
    }
    return rows.sort((a, b) => compareVersions(b.parts, a.parts)).map(({ entry }) => entry);
};

export interface VersionInput {
    config: VersionConfig;
    definition: string;
    content: string;
}

export interface VersionState extends VersionInput {
    version: string;
}

export const advanceVersion = (input: VersionInput, previous?: VersionState): VersionState => {
    const { major, minor, patch } = input.config;
    const before = previous ? parseDocumentVersion(previous.version) : undefined;
    let nextMinor = typeof minor === "number" ? minor : 0;
    let nextPatch = typeof patch === "number" ? patch : 0;
    if (before && previous && major === before[0]) {
        if (typeof minor === "string" && minor === previous.config.minor)
            nextMinor = before[1] + Number(input.definition !== previous.definition);
        if (typeof patch === "string" && patch === previous.config.patch && nextMinor === before[1])
            nextPatch = before[2] + Number(input.content !== previous.content);
    }
    if (![major, nextMinor, nextPatch].every(integer))
        throw new Error("Document version exceeds the supported integer range");
    return { ...input, version: [major, nextMinor, nextPatch].join(".") };
};
