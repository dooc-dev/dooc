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
}

export const defaultPreviewSettings = (): PreviewSettings => ({
    domains: [],
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

/** Application-owned policy; document sources cannot grant network access. */
export const parsePreviewSettings = (input: unknown): PreviewSettings => {
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("previews must be an object");
    const value = input as Record<string, unknown>;
    for (const key of Object.keys(value))
        if (key !== "domains") throw new Error(`Unknown previews field: ${key}`);
    const settings = defaultPreviewSettings();
    if (value.domains !== undefined) {
        if (!Array.isArray(value.domains) || value.domains.some((d) => typeof d !== "string"))
            throw new Error("previews.domains must be a list of domains");
        settings.domains = value.domains.map(normalizePreviewDomain);
        if (new Set(settings.domains).size !== settings.domains.length)
            throw new Error("Duplicate allowed domain");
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
    return PREVIEWERS.find((previewer) =>
        previewer.extensions.some((extension) => name.endsWith(`.${extension}`)),
    )?.id;
};
