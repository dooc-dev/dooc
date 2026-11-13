import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { prebuilt, readInstaller, standalone } from "./assets.js";

export const selfUpdate = (): void => {
    if (!standalone) {
        const hint =
            "Update with your package manager (npm: npm install -g @dooc-dev/dooc@latest).";
        if (!prebuilt) throw new Error(`Cannot self-update a source checkout. ${hint}`);
        const globalRoot = execFileSync("npm", ["root", "--global"], { encoding: "utf8" }).trim();
        const installed = join(globalRoot, "@dooc-dev/dooc");
        if (
            !existsSync(installed) ||
            realpathSync(fileURLToPath(new URL("../..", import.meta.url))) !==
                realpathSync(installed)
        )
            throw new Error(`This is not a global npm installation. ${hint}`);
        execFileSync("npm", ["install", "--global", "@dooc-dev/dooc@latest"], { stdio: "inherit" });
        return;
    }
    const executable = realpathSync(process.execPath);
    if (executable.includes("/Cellar/"))
        throw new Error(
            "This installation is managed by Homebrew. Run: brew upgrade dooc-dev/dooc/dooc",
        );
    if (executable.includes("/mise/installs/"))
        throw new Error(
            "This installation is managed by mise. Run: mise upgrade github:dooc-dev/dooc",
        );
    execFileSync("sh", ["-s"], {
        input: readInstaller(),
        stdio: ["pipe", "inherit", "inherit"],
        env: { ...process.env, DOOC_VERSION: "latest", DOOC_INSTALL_PATH: executable },
    });
};

export const prepareSelfDocs = async (): Promise<{ root: string; dispose: () => void }> => {
    let root: string | undefined;
    const dispose = () => {
        if (root) rmSync(root, { recursive: true, force: true });
    };
    try {
        const response = await fetch(
            "https://codeload.github.com/dooc-dev/dooc/zip/refs/heads/main",
            {
                signal: AbortSignal.timeout(60_000),
            },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        if (!response.body) throw new Error("Empty archive response");
        const chunks: Uint8Array[] = [];
        let downloaded = 0;
        await response.body.pipeTo(
            new WritableStream<Uint8Array>({
                write(chunk) {
                    downloaded += chunk.length;
                    if (downloaded > 128 * 1024 * 1024)
                        throw new Error("Documentation archive exceeds 128 MiB");
                    chunks.push(chunk);
                },
            }),
        );
        const prefix = "dooc-main/dooc-docs/";
        const paths = new Set<string>();
        let extracted = 0;
        const files = unzipSync(Buffer.concat(chunks), {
            filter: ({ name, size, originalSize, compression }) => {
                if (!name.startsWith(prefix) || name.endsWith("/")) return false;
                if (compression === 0 && size !== originalSize)
                    throw new Error("Invalid documentation file size");
                const path = name.slice(prefix.length);
                const parts = path.split("/");
                if (
                    /[\\:]/.test(path) ||
                    [...path].some(
                        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
                    ) ||
                    parts.some(
                        (part) => !part || part === "." || part === ".." || /[. ]$/.test(part),
                    )
                )
                    throw new Error("Invalid documentation path");
                if (parts.some((part) => part.startsWith("."))) return false;
                const key = path.normalize("NFC").toLowerCase();
                if (paths.has(key)) throw new Error("Duplicate documentation path");
                paths.add(key);
                extracted += originalSize;
                if (paths.size > 4096 || extracted > 256 * 1024 * 1024)
                    throw new Error("Documentation exceeds 4096 files or 256 MiB");
                return true;
            },
        });
        if (!files[`${prefix}dooc.yaml`]?.length)
            throw new Error("GitHub main does not contain dooc-docs/dooc.yaml");
        root = mkdtempSync(join(tmpdir(), "dooc-docs-"));
        for (const [name, data] of Object.entries(files)) {
            const path = join(root, name.slice(prefix.length));
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, data, { flag: "wx" });
        }
        return { root, dispose };
    } catch (error) {
        dispose();
        throw new Error(
            `Failed to download documentation from GitHub: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
        );
    }
};
