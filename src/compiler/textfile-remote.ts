import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class TextfileUnavailable extends Error {
    constructor(readonly reason: "missing" | "unreachable") {
        super(reason === "missing" ? "File not found" : "File could not be loaded");
    }
}

const MAX_BYTES = 2 * 1024 * 1024;
// The compiler is synchronous; a bounded child fetch keeps its public API synchronous too.
const FETCH = `
    const response = await fetch(process.argv[1], { signal: AbortSignal.timeout(10000) });
    if (response.status === 404 || response.status === 410) process.exit(44);
    if (!response.ok || !response.body) process.exit(1);
    let size = 0;
    for await (const chunk of response.body) {
        size += chunk.length;
        if (size > ${MAX_BYTES}) process.exit(1);
        process.stdout.write(chunk);
    }
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

export const readRemoteTextfile = (file: string, refresh = false): Buffer => {
    const source = remoteTextfileSource(file);
    const cached = cache.get(file);
    if (!refresh && cached && cached.expires > Date.now()) {
        if (cached.result instanceof Error) throw cached.result;
        return cached.result;
    }
    let result: Buffer | TextfileUnavailable;
    let temp: string | undefined;
    try {
        if (source.ref && source.path) {
            temp = mkdtempSync(join(tmpdir(), "docs-textfile-git-"));
            const git = (...args: string[]): Buffer =>
                execFileSync(
                    "git",
                    [
                        "-c",
                        "protocol.allow=never",
                        "-c",
                        "protocol.http.allow=always",
                        "-c",
                        "protocol.https.allow=always",
                        "-c",
                        "credential.helper=",
                        "-c",
                        "core.hooksPath=/dev/null",
                        "-C",
                        temp as string,
                        ...args,
                    ],
                    {
                        env: {
                            ...process.env,
                            GIT_TERMINAL_PROMPT: "0",
                            GIT_ASKPASS: "",
                            SSH_ASKPASS: "",
                        },
                        timeout: 15000,
                        maxBuffer: MAX_BYTES,
                        stdio: ["ignore", "pipe", "pipe"],
                    },
                );
            git("init", "--bare", "--quiet");
            git("fetch", "--quiet", "--depth=1", "--no-tags", "--", source.url, source.ref);
            try {
                // Read the blob directly: no checkout, hooks, filters or source execution.
                if (git("cat-file", "-t", `FETCH_HEAD:${source.path}`).toString().trim() !== "blob")
                    throw new TextfileUnavailable("missing");
            } catch {
                throw new TextfileUnavailable("missing");
            }
            result = git("show", `FETCH_HEAD:${source.path}`);
        } else {
            try {
                result = execFileSync(
                    process.execPath,
                    ["--input-type=module", "-e", FETCH, source.url],
                    {
                        timeout: 12000,
                        maxBuffer: MAX_BYTES,
                        stdio: ["ignore", "pipe", "pipe"],
                    },
                );
            } catch (error) {
                throw new TextfileUnavailable(
                    (error as { status?: number }).status === 44 ? "missing" : "unreachable",
                );
            }
        }
    } catch (error) {
        result =
            error instanceof TextfileUnavailable ? error : new TextfileUnavailable("unreachable");
    } finally {
        if (temp) rmSync(temp, { recursive: true, force: true });
    }
    if (cache.size >= 64) cache.clear();
    cache.set(file, { result, expires: Date.now() + 60000 });
    if (result instanceof Error) throw result;
    return result;
};
