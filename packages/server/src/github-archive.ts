import { unzipSync } from "fflate";
import { reportDownloadProgress } from "../../engine/src/compiler/download-progress.js";

const safePath = (path: string): boolean =>
    !/[\\:]/.test(path) &&
    ![...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    path.split("/").every((part) => part && part !== "." && part !== ".." && !/[. ]$/.test(part));

export const downloadGitHubArchive = async (
    url: string,
    folder: string,
    label: "workspace" | "documentation" = "workspace",
): Promise<Record<string, Uint8Array>> => {
    const title = label[0]?.toUpperCase() + label.slice(1);
    let received = 0;
    let total: number | undefined;
    const chunks: Uint8Array[] = [];
    reportDownloadProgress({ url, state: "start", received });
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        if (!response.body) throw new Error("Empty archive response");
        const length = response.headers.get("content-length");
        if (length && /^\d+$/.test(length) && Number.isSafeInteger(Number(length)))
            total = Number(length);
        await response.body.pipeTo(
            new WritableStream<Uint8Array>({
                write(chunk) {
                    received += chunk.length;
                    if (received > 128 * 1024 * 1024)
                        throw new Error(`${title} archive exceeds 128 MiB`);
                    chunks.push(chunk);
                    reportDownloadProgress({
                        url,
                        state: "progress",
                        received,
                        ...(total === undefined ? {} : { total }),
                    });
                },
            }),
        );
        reportDownloadProgress({
            url,
            state: "complete",
            received,
            ...(total === undefined ? {} : { total }),
        });
    } catch (error) {
        reportDownloadProgress({
            url,
            state: "error",
            received,
            ...(total === undefined ? {} : { total }),
        });
        throw error;
    }
    const paths = new Set<string>();
    let archiveRoot: string | undefined;
    let extracted = 0;
    const selected = (name: string): string | undefined => {
        const split = name.indexOf("/");
        if (split <= 0 || name.endsWith("/")) return;
        const root = name.slice(0, split);
        const path = name.slice(split + 1);
        if (folder && !path.startsWith(`${folder}/`)) return;
        if (!safePath(root) || (archiveRoot !== undefined && archiveRoot !== root))
            throw new Error(`Invalid ${label} archive root`);
        archiveRoot = root;
        return folder ? path.slice(folder.length + 1) : path;
    };
    const files = unzipSync(Buffer.concat(chunks), {
        filter: ({ name, size, originalSize, compression }) => {
            const path = selected(name);
            if (path === undefined) return false;
            if (compression === 0 && size !== originalSize)
                throw new Error(`Invalid ${label} file size`);
            if (!safePath(path)) throw new Error(`Invalid ${label} path`);
            if (path.split("/").some((part) => part.startsWith("."))) return false;
            // Language configuration is executable and must not run from downloaded workspaces.
            if (path.toLowerCase() === "docs.config.mjs") return false;
            const key = path.normalize("NFC").toLowerCase();
            if (paths.has(key)) throw new Error(`Duplicate ${label} path`);
            paths.add(key);
            extracted += originalSize;
            if (paths.size > 4096 || extracted > 256 * 1024 * 1024)
                throw new Error(`${title} exceeds 4096 files or 256 MiB`);
            return true;
        },
    });
    return Object.fromEntries(
        Object.entries(files).map(([name, data]) => [selected(name) as string, data]),
    );
};
