import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
} from "node:fs";
import { devNull, homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { reportDownloadProgress } from "../../engine/src/compiler/download-progress.js";
import { isManifestFile, MANIFEST_FILE } from "../../engine/src/core/content-metadata.js";

const invalidSource = () =>
    new Error("Use an HTTPS, HTTP, or SSH Git repository URL without passwords or URL parameters.");

const parseSource = (source: string): { url: string; name: string } => {
    if (!source || source.length > 4096 || /\p{Cc}|\p{Cf}|\s/gu.test(source)) throw invalidSource();
    const scp = /^([a-z\d][a-z\d._-]*)@([a-z\d][a-z\d.-]*):([^?#\\]+)$/i.exec(source);
    let url: string;
    let path: string;
    if (scp) {
        if (!scp[3] || scp[3].startsWith("-") || scp[3].split("/").some((part) => part === ".."))
            throw invalidSource();
        url = `${scp[1]}@${scp[2]?.toLowerCase()}:${scp[3].replace(/\/$/, "")}`;
        path = scp[3];
    } else {
        let parsed: URL;
        try {
            parsed = new URL(source);
        } catch {
            throw invalidSource();
        }
        if (
            !["https:", "http:", "ssh:"].includes(parsed.protocol) ||
            !parsed.hostname ||
            parsed.hostname.startsWith("-") ||
            parsed.password ||
            parsed.search ||
            parsed.hash ||
            source.includes("\\") ||
            (parsed.username &&
                (parsed.protocol !== "ssh:" || !/^[a-z\d][a-z\d._-]*$/i.test(parsed.username))) ||
            !parsed.pathname.replaceAll("/", "")
        )
            throw invalidSource();
        parsed.pathname = parsed.pathname.replace(/\/$/, "");
        url = parsed.href;
        path = parsed.pathname;
    }
    const name = basename(path)
        .replace(/\.git$/i, "")
        .replace(/[^a-z\d._-]/gi, "_")
        .replace(/[. ]+$/, "");
    return { url, name: name && name !== "." && !name.startsWith("-") ? name : "repository" };
};

const selectedPath = (path = ""): string => {
    if (
        path.length > 4096 ||
        /[\\:]|\p{Cc}|\p{Cf}/u.test(path) ||
        isAbsolute(path) ||
        path.split("/").some((part) => part === ".." || part.toLowerCase() === ".git")
    )
        throw new Error("Choose a relative folder or manifest path inside the Git repository");
    return path;
};

const manifestIn = (repository: string, selected: string): string => {
    const root = realpathSync(repository);
    let manifest = join(root, selected);
    if (statSync(manifest, { throwIfNoEntry: false })?.isDirectory())
        manifest = join(manifest, MANIFEST_FILE);
    if (!isManifestFile(basename(manifest)) || !existsSync(manifest))
        throw new Error(`No dooc manifest at ${selected || "."}. Choose its folder or file.`);
    manifest = realpathSync(manifest);
    const path = relative(root, manifest);
    if (
        path === ".." ||
        path.startsWith(`..${sep}`) ||
        isAbsolute(path) ||
        !statSync(manifest).isFile()
    )
        throw new Error("The selected manifest must be a file inside the Git repository");
    return manifest;
};

const cleanMessage = (message: string): string =>
    stripVTControlCharacters(message)
        .replace(/\p{Cc}|\p{Cf}/gu, " ")
        .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"'`]+/giu, (value) => {
            try {
                const url = new URL(value);
                url.username = url.password = url.search = url.hash = "";
                return url.href;
            } catch {
                return "[invalid URL]";
            }
        })
        .trim()
        .slice(0, 2000);

export const prepareGitWorkspace = async (
    source: string,
    mode: "edit" | "view",
    options: { path?: string } = {},
) => {
    const remote = parseSource(source);
    const selected = selectedPath(options.path);
    const dataHome = process.env.XDG_DATA_HOME;
    const directory = join(
        dataHome && isAbsolute(dataHome) ? dataHome : join(homedir(), ".local/share"),
        "dooc/workspaces",
    );
    const hash = createHash("sha256").update(remote.url).digest("hex").slice(0, 24);
    const saved = join(directory, `git-${hash}`);
    const result = (container: string, reused: boolean) => {
        const repository = join(container, remote.name);
        if (
            !lstatSync(container).isDirectory() ||
            !existsSync(repository) ||
            !lstatSync(repository).isDirectory() ||
            !existsSync(join(repository, ".git")) ||
            !lstatSync(join(repository, ".git")).isDirectory()
        )
            throw new Error(
                "Saved workspace is missing its Git repository. Restore it to reopen your edits.",
            );
        const manifest = manifestIn(repository, selected);
        return {
            root: dirname(manifest),
            manifest,
            reused,
            dispose: () => {
                if (mode === "view") rmSync(container, { recursive: true, force: true });
            },
        };
    };
    let staging: string | undefined;
    let child: ChildProcess | undefined;
    const stop = () => {
        if (!child?.pid) return;
        try {
            if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
        } catch {
            // The child may have exited while its close event is still queued.
        }
    };
    const cleanup = () => {
        stop();
        if (staging) rmSync(staging, { recursive: true, force: true });
    };
    const interrupt = () => {
        cleanup();
        process.exit(130);
    };
    const terminate = () => {
        cleanup();
        process.exit(143);
    };
    const run = (args: string[], network = false, globalConfig = network): Promise<string> =>
        new Promise((resolve, reject) => {
            const env: NodeJS.ProcessEnv = { ...process.env };
            // Inherited repository selectors must never redirect operations into the caller's repo.
            for (const key of Object.keys(env))
                if (
                    key.startsWith("GIT_") &&
                    ![
                        "GIT_CONFIG_GLOBAL",
                        "GIT_CONFIG_SYSTEM",
                        "GIT_CONFIG_NOSYSTEM",
                        "GIT_SSH",
                        "GIT_SSH_COMMAND",
                        "GIT_SSH_VARIANT",
                        "GIT_ASKPASS",
                    ].includes(key)
                )
                    delete env[key];
            Object.assign(env, {
                GIT_TERMINAL_PROMPT: "0",
                GIT_ALLOW_PROTOCOL: "https:http:ssh",
                GIT_OPTIONAL_LOCKS: "0",
                LC_ALL: "C",
                ...(globalConfig ? {} : { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull }),
            });
            child = spawn(
                "git",
                [
                    "-c",
                    `core.hooksPath=${devNull}`,
                    "-c",
                    "core.fsmonitor=false",
                    "-c",
                    "submodule.recurse=false",
                    ...args,
                ],
                {
                    env,
                    stdio: ["ignore", "pipe", "pipe"],
                    windowsHide: true,
                    detached: process.platform !== "win32",
                },
            );
            const timeout = setTimeout(stop, 180_000);
            let stdout = "";
            let stderr = "";
            let pending = "";
            child.stdout?.on("data", (chunk: Buffer) => {
                stdout += chunk.toString();
                if (stdout.length > 8 * 1024 * 1024) stop();
            });
            child.stderr?.on("data", (chunk: Buffer) => {
                const text = chunk.toString();
                stderr = (stderr + text).slice(-8192);
                if (!network) return;
                const lines = (pending + text).split(/[\r\n]/);
                pending = lines.pop()?.slice(-2000) ?? "";
                for (const line of lines) {
                    const detail = cleanMessage(line);
                    if (detail)
                        reportDownloadProgress({
                            url: remote.url,
                            state: "progress",
                            received: 0,
                            detail,
                        });
                }
            });
            child.once("error", (error: NodeJS.ErrnoException) => {
                clearTimeout(timeout);
                child = undefined;
                reject(
                    new Error(
                        error.code === "ENOENT"
                            ? "Install Git to open a remote repository"
                            : cleanMessage(error.message),
                    ),
                );
            });
            child.once("close", (code) => {
                clearTimeout(timeout);
                child = undefined;
                if (code === 0) resolve(stdout);
                else reject(new Error(cleanMessage(stderr) || "Git command failed or timed out"));
            });
        });
    const protect = async (repository: string) => {
        const config = await run(["-C", repository, "config", "--null", "--list"], false, true);
        const local = new Map(
            (await run(["-C", repository, "config", "--local", "--null", "--list"]))
                .split("\0")
                .filter(Boolean)
                .map((entry) => [
                    entry.slice(0, entry.indexOf("\n")),
                    entry.slice(entry.indexOf("\n") + 1),
                ]),
        );
        const drivers = new Set<string>();
        for (const entry of config.split("\0")) {
            const key = entry.slice(0, entry.indexOf("\n"));
            const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/i.exec(key);
            if (match?.[1]) drivers.add(match[1]);
        }
        const settings: [string, string][] = [
            ["core.hookspath", devNull],
            ["core.fsmonitor", "false"],
            ...[...drivers].flatMap<[string, string]>((driver) => [
                [`filter.${driver}.clean`, ""],
                [`filter.${driver}.smudge`, ""],
                [`filter.${driver}.process`, ""],
                [`filter.${driver}.required`, "false"],
            ]),
        ];
        for (const [key, value] of settings)
            if (local.get(key) !== value)
                await run(["-C", repository, "config", "--local", "--replace-all", key, value]);
    };
    if (mode === "edit" && existsSync(saved)) {
        const workspace = result(saved, true);
        await protect(join(saved, remote.name));
        return workspace;
    }
    if (mode === "edit") mkdirSync(directory, { recursive: true });
    staging = mkdtempSync(join(mode === "edit" ? directory : tmpdir(), "dooc-git-"));
    process.once("exit", cleanup);
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    reportDownloadProgress({
        url: remote.url,
        state: "start",
        received: 0,
        detail: "Cloning repository",
    });
    try {
        const repository = join(staging, remote.name);
        await run(
            [
                "clone",
                "--progress",
                "--no-checkout",
                "--no-recurse-submodules",
                "--template=",
                "--origin=origin",
                "--",
                remote.url,
                repository,
            ],
            true,
        );
        await protect(repository);
        // Keep native credentials for cloning, but never execute global checkout filters.
        await run(["-C", repository, "checkout", "--force"]);
        const refs = await run([
            "-C",
            repository,
            "for-each-ref",
            "--format=%(refname:strip=3)%00%(symref)",
            "refs/remotes/origin",
        ]);
        const current = (await run(["-C", repository, "symbolic-ref", "--short", "HEAD"])).trim();
        for (const line of refs.trimEnd().split("\n")) {
            const [branch, symbolic] = line.split("\0");
            if (branch && !symbolic && branch !== current)
                await run([
                    "-C",
                    repository,
                    "branch",
                    "--track",
                    "--",
                    branch,
                    `refs/remotes/origin/${branch}`,
                ]);
        }
        manifestIn(repository, selected);
        if (mode === "view") {
            const workspace = result(staging, false);
            staging = undefined;
            reportDownloadProgress({
                url: remote.url,
                state: "complete",
                received: 0,
                detail: "Clone ready",
            });
            return workspace;
        }
        if (existsSync(saved)) {
            cleanup();
            staging = undefined;
            const workspace = result(saved, true);
            await protect(join(saved, remote.name));
            reportDownloadProgress({
                url: remote.url,
                state: "complete",
                received: 0,
                detail: "Existing clone ready",
            });
            return workspace;
        }
        try {
            renameSync(staging, saved);
        } catch (error) {
            if (!existsSync(saved)) throw error;
            cleanup();
            staging = undefined;
            const workspace = result(saved, true);
            await protect(join(saved, remote.name));
            reportDownloadProgress({
                url: remote.url,
                state: "complete",
                received: 0,
                detail: "Existing clone ready",
            });
            return workspace;
        }
        staging = undefined;
        await protect(join(saved, remote.name));
        const workspace = result(saved, false);
        reportDownloadProgress({
            url: remote.url,
            state: "complete",
            received: 0,
            detail: "Clone ready",
        });
        return workspace;
    } catch (error) {
        cleanup();
        reportDownloadProgress({
            url: remote.url,
            state: "error",
            received: 0,
            detail: "Clone failed",
        });
        throw new Error(
            `Failed to open Git workspace: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
        );
    } finally {
        process.removeListener("exit", cleanup);
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", terminate);
    }
};
