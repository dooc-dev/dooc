import { parseFileReference } from "./textfile.js";

export const PREVIEWERS = [
    { id: "table", label: "Table", extensions: ["csv", "tsv"] },
    { id: "image", label: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif", "svg"] },
    { id: "html", label: "HTML", extensions: ["html", "htm"] },
    { id: "markdown", label: "Markdown", extensions: ["md", "markdown"] },
    {
        id: "code",
        label: "Code",
        extensions: [
            "txt",
            "log",
            "json",
            "yaml",
            "yml",
            "toml",
            "xml",
            "css",
            "js",
            "jsx",
            "ts",
            "tsx",
            "mjs",
            "cjs",
            "py",
            "rs",
            "go",
            "java",
            "c",
            "h",
            "cpp",
            "hpp",
            "cs",
            "rb",
            "php",
            "swift",
            "kt",
            "sh",
            "bash",
            "ps1",
            "sql",
            "tdl",
        ],
    },
    { id: "video", label: "Video", extensions: ["mp4", "webm"] },
] as const;

export type PreviewerId = (typeof PREVIEWERS)[number]["id"];

export interface PreviewSettings {
    domains: string[];
    formats: Record<PreviewerId, string[]>;
}

export const defaultPreviewSettings = (): PreviewSettings => ({
    domains: [],
    formats: Object.fromEntries(
        PREVIEWERS.map((p) => [p.id, [...p.extensions]]),
    ) as PreviewSettings["formats"],
});

/** Exact DNS names only: no schemes, credentials, ports, wildcard or implicit subdomains. */
export const normalizePreviewDomain = (input: string): string => {
    const domain = input.trim().toLowerCase();
    if (
        domain.length > 253 ||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
            domain,
        ) ||
        /\.(?:localhost|local|internal|invalid|test)$/.test(domain)
    )
        throw new Error(`Invalid public domain: ${input}`);
    return domain;
};

/** Shared by manifest loading and the settings API; invalid registrations never take effect. */
export const parsePreviewSettings = (input: unknown): PreviewSettings => {
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("previews must be an object");
    const value = input as Record<string, unknown>;
    for (const key of Object.keys(value))
        if (key !== "domains" && key !== "formats")
            throw new Error(`Unknown previews field: ${key}`);
    const settings = defaultPreviewSettings();
    if (value.domains !== undefined) {
        if (!Array.isArray(value.domains) || value.domains.some((d) => typeof d !== "string"))
            throw new Error("previews.domains must be a list of domains");
        settings.domains = value.domains.map(normalizePreviewDomain);
        if (new Set(settings.domains).size !== settings.domains.length)
            throw new Error("Duplicate allowed domain");
    }
    if (value.formats !== undefined) {
        if (!value.formats || typeof value.formats !== "object" || Array.isArray(value.formats))
            throw new Error("previews.formats must be an object");
        for (const [id, extensions] of Object.entries(value.formats)) {
            if (!PREVIEWERS.some((p) => p.id === id)) throw new Error(`Unknown previewer: ${id}`);
            if (
                !Array.isArray(extensions) ||
                extensions.some(
                    (e) => typeof e !== "string" || !/^[a-z0-9]+(?:\.[a-z0-9]+)*$/.test(e),
                )
            )
                throw new Error(`Invalid extensions for ${id}`);
            settings.formats[id as PreviewerId] = [...extensions];
        }
    }
    const seen = new Set<string>();
    for (const extensions of Object.values(settings.formats)) {
        for (const extension of extensions) {
            if (seen.has(extension)) throw new Error(`Duplicate preview extension: ${extension}`);
            seen.add(extension);
        }
    }
    return settings;
};

export const allowedPreviewUrl = (source: string, domains: readonly string[]): URL => {
    const url = new URL(source);
    if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        /[\\\s]/.test(source)
    )
        throw new Error(
            "External previews require an HTTPS URL without credentials or a custom port",
        );
    if (!domains.includes(url.hostname)) throw new Error(`Domain is not allowed: ${url.hostname}`);
    return url;
};

/** Selects a registered previewer only; reading files and executing content are separate. */
export const resolvePreviewer = (
    source: string,
    settings: PreviewSettings = defaultPreviewSettings(),
): PreviewerId | undefined => {
    let path: string;
    try {
        path =
            /^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith("//")
                ? decodeURIComponent(allowedPreviewUrl(source, settings.domains).pathname)
                : parseFileReference(source).file;
    } catch {
        return undefined;
    }
    const name = path.split("/").at(-1)?.toLowerCase() ?? "";
    // A compound extension can specialize a general one (e.g. schema.json before json).
    return PREVIEWERS.flatMap((p) =>
        settings.formats[p.id].map((extension) => ({ id: p.id, extension })),
    )
        .filter(({ extension }) => name.endsWith(`.${extension}`))
        .sort((a, b) => b.extension.length - a.extension.length)[0]?.id;
};
