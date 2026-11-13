import { allowedPreviewUrl } from "../core/previewers.js";
import { reportDownloadProgress } from "./download-progress.js";
import { execFileSync, fetchPublicFile } from "./host.js";

export class TextfileUnavailable extends Error {
    constructor(readonly reason: "missing" | "unreachable") {
        super(reason === "missing" ? "File not found" : "File could not be loaded");
    }
}

const MAX_BYTES = 2 * 1024 * 1024;
// The compiler is synchronous; a bounded child fetch keeps its public API synchronous too.
const FETCH = `
    const __name = (value) => value;
    (${fetchPublicFile.toString()})(process.argv[1])
        .then(data => process.stdout.write(data))
        .catch(error => process.exit(error.message === "NOT_FOUND" ? 44 : error.message === "BLOCKED" ? 45 : 1));
`;

export const remoteTextfileSource = (
    file: string,
): { url: string; ref?: string; path?: string } => {
    const url = new URL(file);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password)
        throw new Error("expected an HTTP(S) URL without embedded credentials");
    if (url.pathname.endsWith(".git")) {
        const match = /^#([^:]+):(.+)$/.exec(url.hash);
        const ref = decodeURIComponent(match?.[1] ?? "");
        const path = decodeURIComponent(match?.[2] ?? "");
        if (
            !ref ||
            ref.startsWith("-") ||
            /[\s\0~^:?*[\\]/.test(ref) ||
            ref.includes("..") ||
            ref.includes("@{") ||
            !path ||
            path.startsWith("/") ||
            /[\0\r\n\\]/.test(path) ||
            path.split("/").some((part) => !part || part === "." || part === "..")
        )
            throw new Error("use https://host/repo.git#ref:path/to/file.ext");
        url.hash = "";
        return { url: url.href, ref, path };
    }
    // Accept the ordinary GitHub file URL as well as a raw content URL.
    if (url.hostname === "github.com" && /^\/[^/]+\/[^/]+\/blob\//.test(url.pathname)) {
        url.hostname = "raw.githubusercontent.com";
        url.pathname = url.pathname.replace("/blob/", "/");
    }
    url.hash = "";
    return { url: url.href };
};

// shortcut: cache remote reads for one minute; use explicit reload for immediate branch updates.
const cache = new Map<string, { expires: number; result: Buffer | TextfileUnavailable }>();
const pending = new Map<string, Promise<Buffer>>();

/** The viewer fetches in the background; the compiler reuses the completed cache entry. */
export const readRemoteTextfileAsync = async (
    file: string,
    domains: readonly string[],
    refresh = false,
): Promise<Buffer> => {
    allowedPreviewUrl(file, domains);
    const source = remoteTextfileSource(file);
    if (source.ref)
        throw new Error(
            "Git repositories require a dedicated preview protocol; use a public HTTPS file URL",
        );
    allowedPreviewUrl(source.url, domains);
    const cached = cache.get(file);
    if (!refresh && cached && cached.expires > Date.now()) {
        if (cached.result instanceof Error) throw cached.result;
        return cached.result;
    }
    const active = pending.get(file);
    if (active) return active;
    const task = (async () => {
        let result: Buffer | TextfileUnavailable;
        let received = 0;
        let total: number | undefined;
        reportDownloadProgress({ url: source.url, state: "start", received });
        try {
            result = await fetchPublicFile(source.url, undefined, (size, length) => {
                received = size;
                total = length;
                reportDownloadProgress({ url: source.url, state: "progress", received, total });
            });
            reportDownloadProgress({
                url: source.url,
                state: "complete",
                received: result.length,
                total,
            });
        } catch (error) {
            reportDownloadProgress({ url: source.url, state: "error", received, total });
            if ((error as Error).message === "BLOCKED")
                throw new Error("External previews require a public network address");
            result = new TextfileUnavailable(
                (error as Error).message === "NOT_FOUND" ? "missing" : "unreachable",
            );
        }
        if (cache.size >= 64) cache.clear();
        cache.set(file, { result, expires: Date.now() + 60000 });
        if (result instanceof Error) throw result;
        return result;
    })();
    pending.set(file, task);
    try {
        return await task;
    } finally {
        pending.delete(file);
    }
};

export const readRemoteTextfile = (
    file: string,
    domains: readonly string[],
    refresh = false,
): Buffer => {
    allowedPreviewUrl(file, domains);
    const source = remoteTextfileSource(file);
    if (source.ref)
        throw new Error(
            "Git repositories require a dedicated preview protocol; use a public HTTPS file URL",
        );
    allowedPreviewUrl(source.url, domains);
    const cached = cache.get(file);
    if (!refresh && cached && cached.expires > Date.now()) {
        if (cached.result instanceof Error) throw cached.result;
        return cached.result;
    }
    let result: Buffer | TextfileUnavailable;
    reportDownloadProgress({ url: source.url, state: "start", received: 0 });
    try {
        result = execFileSync(process.execPath, ["--input-type=module", "-e", FETCH, source.url], {
            timeout: 12000,
            maxBuffer: MAX_BYTES,
            stdio: ["ignore", "pipe", "pipe"],
            env: { PATH: process.env.PATH },
        });
        reportDownloadProgress({ url: source.url, state: "complete", received: result.length });
    } catch (error) {
        reportDownloadProgress({ url: source.url, state: "error", received: 0 });
        if ((error as { status?: number }).status === 45)
            throw new Error("External previews require a public network address");
        result = new TextfileUnavailable(
            (error as { status?: number }).status === 44 ? "missing" : "unreachable",
        );
    }
    if (cache.size >= 64) cache.clear();
    cache.set(file, { result, expires: Date.now() + 60000 });
    if (result instanceof Error) throw result;
    return result;
};
