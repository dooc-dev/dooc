import {
    completeFilePaths,
    filesSnapshot,
    updateFiles,
    uploadFile,
} from "../../engine/src/compiler/files.js";
import { MAX_FILE_UPLOAD_BYTES } from "../../engine/src/core/files.js";
// Combined Node viewer: serves frontend assets and the shared document application.
// Workspace requests and change notifications travel over a same-origin WebSocket.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { manifestFile } from "../../engine/src/compiler/manifest.js";
import { assembleDoc } from "../../engine/src/compiler/ops.js";
import { MAX_EXTENSION_BYTES } from "../../engine/src/core/extension-package.js";
import { parsePreviewSettings } from "../../engine/src/core/previewers.js";
import { parseWorkspaceSource, type WorkspaceSource } from "../../engine/src/core/workspace.js";
import {
    createDocumentApplication,
    type ServeMode,
} from "../../frontend/src/document-application.js";
import { createHistoryOp, type Person, parsePerson } from "../../workspace/src/history.js";
import { WORKSPACE_PATH } from "../../workspace/src/protocol.js";
import { createWorkspaceServer, type WorkspaceOps } from "../../workspace/src/server.js";
import { readViewerAsset, prebuilt as usePrebuiltAssets } from "./assets.js";
import {
    isLocalHost,
    isLocalToolRequest,
    runCodeTool,
    validateCodeTools,
    validateTextfileCode,
} from "./editor-tools.js";
import { createExtensionManager } from "./extensions.js";
import { fontCss, readFont } from "./fonts.js";
import { createGitHandler, validateGitOrigin } from "./git.js";
import { gitBaseBody, gitBaseText, setSubformatChanges } from "./git-diff.js";
import { workspaceHistory } from "./history.js";
import { watchProject } from "./hmr.js";
import { loadSiteLanguages } from "./languages.js";
import { loggedWorkspaceOps, logHttpOperation } from "./operation-log.js";
import { loadViewerPlugins, type ViewerRuntime } from "./plugin-config.js";
import { createLocalPluginStorage } from "./plugins/local-storage.js";
import { createPluginHandler } from "./plugins.js";
import { terminal } from "./terminal.js";
import { readWorkspaceSource, sourceFileBase } from "./workspace.js";
import { nodeWorkspaceOperations } from "./workspace-server.js";

export type {
    EditorBoot,
    Entry,
    ServeMode,
    Site,
} from "../../frontend/src/document-application.js";
export { assembleDoc };

// pkgRoot = the dooc package itself; client bundles are built from its frontend sources.
// docsRoot = the docs folder that follows the layout convention (content/ figures/).
const pkgRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    usePrebuiltAssets ? "../.." : "../../..",
);
const frontendRoot = join(pkgRoot, "packages/frontend/src");
const root = resolve(process.env.DOCS_ROOT ?? process.cwd());

const application = createDocumentApplication(root, {
    fontCss,
    readWorkspaceSource,
    sourceFileBase,
    gitBaseBody,
    gitBaseText,
    setSubformatChanges,
    runCodeTool,
    validateCodeTools,
    validateTextfileCode,
});
export const {
    siteFrom,
    filePreviewResults,
    renderEntryHtml,
    renderDocFile,
    docQueryResponse,
    sanitizeFrontmatter,
    isExternallyModified,
    resolveContentFile,
    navGroupsHtml,
    textfilePreviewHtml,
    textfilePreviewErrors,
    resourcesMain,
    publishHtml,
    languageFieldHtml,
    editorBoot,
    pageDataResponse,
} = application;
const { readJson, sendJson, notFound } = application;
const SHARED_IDLE_MS = 5 * 60_000;
const SHARED_LEAVE_MS = 30_000;
const HEARTBEAT_MS = 30_000;
let workspaceSource: WorkspaceSource | undefined;
let sharedBranch: string | undefined;
/** Cache of entry name → { js, etag }. clear() is called on HMR "client" notifications
 * (changes to edit-client.ts / the schema graph interaction layer) (= invalidation is
 * startServer's job; this is just the container). */
export interface BundleCache {
    get: (entry: string, build: () => Promise<string>) => Promise<{ js: string; etag: string }>;
    clear: () => void;
}

export const createBundleCache = (): BundleCache => {
    const store = new Map<string, { js: string; etag: string }>();
    return {
        get: async (entry, build) => {
            const hit = store.get(entry);
            if (hit) {
                return hit;
            }
            const js = await build();
            const etag = `"${createHash("sha256").update(js).digest("hex")}"`;
            const value = { js, etag };
            store.set(entry, value);
            return value;
        },
        clear: () => store.clear(),
    };
};

// The npm package (running as dist/*.js) has no src/, so read the prebuilt bundles.
const PREBUILT: Record<string, string> = {
    "schema-graph-global.tsx": "flow.global.js",
    "edit-client.ts": "edit.global.js",
    "client-entry.ts": "client.global.js",
    "workspace-worker.ts": "workspace-worker.global.js",
    "ui-client.ts": "ui.global.js",
    "code-highlight.ts": "code.global.js",
    "code-worker.ts": "code-worker.global.js",
    "published-plugins.ts": "plugins.global.js",
    "published-subformats.ts": "subformats.global.js",
};

/** Minified client bundle shared by local viewing and published HTML. */
export const bundleClient = async (entry: string): Promise<string> => {
    const prebuilt = PREBUILT[entry];
    if (usePrebuiltAssets && prebuilt) {
        return readViewerAsset(prebuilt).toString("utf8");
    }
    if (entry === "workspace-worker.ts") {
        const script = new URL("../../../scripts/build/client.mjs", import.meta.url).href;
        const { buildBrowserWorkspace } = await import(script);
        const result = await buildBrowserWorkspace({ write: false });
        return result.outputFiles[0].text;
    }
    const esbuild = await import("esbuild");
    const out = await esbuild.build({
        entryPoints: [join(frontendRoot, entry)],
        bundle: true,
        format: "iife",
        target: "es2022",
        write: false,
        minify: true,
    });
    return out.outputFiles?.[0]?.text ?? "";
};

export const startServer = async (
    mode: ServeMode,
    port = 5179,
    pluginModule?: string,
    startup?: {
        open?: boolean;
        file?: string;
        data?: string;
        login?: string;
        /** PEM file paths; with them the viewer is served over HTTPS (and the socket over WSS). */
        tls?: { cert: string; key: string };
        /** Branch that a shared workspace records its snapshots on. */
        shared?: string;
    },
): Promise<ViewerRuntime> => {
    // Language adapters are read once; the manifest is re-read by the compiler.
    const siteLanguages = await loadSiteLanguages(root);
    const viewerPlugins = await loadViewerPlugins(pluginModule);
    workspaceSource = viewerPlugins.workspace;
    let gitOrigin = viewerPlugins.gitOrigin;
    const handleGit = createGitHandler(root, () => gitOrigin);
    // File and Git control travel over the workspace socket. `local` marks a connection whose
    // Host is this exact listener, so Git and its credentials stay off forwarded ports.
    // A shared workspace: snapshots go onto one branch and credit everyone who edited, edits
    // left alone are snapshotted after a quiet period, and branch-level Git is not offered.
    sharedBranch = startup?.shared;
    const history = createHistoryOp(
        () => workspaceHistory(root, sharedBranch),
        sharedBranch === undefined ? {} : { idleMs: SHARED_IDLE_MS, leaveMs: SHARED_LEAVE_MS },
    );
    type Session = { local: boolean; user?: Person };
    const editOps: WorkspaceOps<Session> = {
        history: history.op,
        identify: (input, session) => {
            session.user = parsePerson(input);
            return session.user;
        },
        files: (input) =>
            input.action === "complete"
                ? completeFilePaths(root, input.prefix)
                : input.action === "read"
                  ? filesSnapshot(root)
                  : input.action === "upload"
                    ? uploadFile(root, input)
                    : updateFiles(root, input),
        git: async (input, session) => {
            if (!session.local) throw new Error("Git requires a same-origin local editor request");
            if ((workspaceSource ?? readWorkspaceSource(root)).protocol !== "git")
                throw new Error("Git workspace is not available");
            const result = await handleGit(input);
            if (
                workspaceSource?.protocol === "git" &&
                (input.action === "switch" || input.action === "branch")
            ) {
                const local = readWorkspaceSource(root);
                if (local.protocol === "git")
                    workspaceSource = { ...workspaceSource, branch: local.branch };
            }
            return result;
        },
    };
    let isolated: ReturnType<typeof nodeWorkspaceOperations> | undefined;
    if (mode === "edit" && sharedBranch === undefined) {
        const original = { ...editOps };
        for (const name of ["workspaces", "http", "files", "git", "history"]) {
            editOps[name] = async (input, session) => {
                if (input.workspace === undefined && original[name])
                    return original[name](input, session);
                if (!session.local)
                    throw new Error("Workspace branches require a local editor connection");
                isolated ??= nodeWorkspaceOperations(
                    join(root, manifestFile(root)),
                    pluginModule,
                    (event, data) => workspaceServer.broadcast(event, data),
                );
                const manager = await isolated;
                const operation = manager.ops[name];
                if (!operation) throw new Error("Workspace operation is unavailable");
                return operation(input, session);
            };
        }
    }
    // A shared workspace records snapshots instead of offering branch-level Git.
    if (sharedBranch !== undefined) delete editOps.git;
    // The boot id changes on every process start; it is how an open page notices a restart.
    // A preview only listens for changes, so it gets no operations.
    const workspaceServer = createWorkspaceServer<Session>(
        mode === "edit" ? loggedWorkspaceOps(editOps) : {},
        {
            boot: `${process.pid}-${Date.now()}`,
            ...(sharedBranch === undefined ? {} : { shared: true }),
        },
    );
    const personal = createLocalPluginStorage();
    const handlePlugins = createPluginHandler(
        viewerPlugins.plugins,
        viewerPlugins,
        personal.credentials,
    );
    const handleExtensions = createExtensionManager(root, handlePlugins, viewerPlugins, personal);
    let loginPlugins = startup?.login ? [startup.login] : [];
    process.once("exit", handleExtensions.dispose);
    // Client bundles (bundleClient) = edit's editing UI and the schema graph interaction layer
    // shared by preview/edit. React Flow's stylesheet isn't mixed into the bundle — the mount
    // layer (flow-css.ts) injects it into a <style> at runtime, so the page needs no CSS delivery
    // path (same conditions as the published output).
    // Cache the bundle result + etag per entry (graph.js / edit.js) — this path isn't hit by the
    // per-keystroke /api/render / /api/save, but tsx watch doesn't restart for these, so
    // invalidate explicitly on the watcher's "client" notification (changes to edit-client.ts /
    // the schema graph interaction layer's src/*.tsx).
    const bundleCache = createBundleCache();
    let graphChunks: Promise<Map<string, string>> | undefined;
    const graphAsset = async (name: string): Promise<string> => {
        if (usePrebuiltAssets) return readViewerAsset(`graph/${name}`).toString("utf8");
        graphChunks ??= import("esbuild")
            .then(async (esbuild) => {
                const output = await esbuild.build({
                    entryPoints: [join(frontendRoot, "schema-graph-global.tsx")],
                    bundle: true,
                    splitting: true,
                    format: "esm",
                    target: "es2022",
                    outdir: join(pkgRoot, "dist/graph"),
                    write: false,
                    minify: true,
                });
                return new Map(output.outputFiles.map((file) => [basename(file.path), file.text]));
            })
            .catch((error) => {
                graphChunks = undefined;
                throw error;
            });
        const js = (await graphChunks).get(name);
        if (js === undefined) throw new Error("Diagram asset not found");
        return js;
    };

    const viewer: ViewerRuntime = {
        register: handlePlugins.register,
        unregister: handlePlugins.unregister,
        setWorkspace(workspace) {
            workspaceSource = workspace === undefined ? undefined : parseWorkspaceSource(workspace);
            application.configure({
                languages: siteLanguages,
                workspace: workspaceSource,
                shared: sharedBranch,
                downloads: mode === "edit",
            });
            workspaceServer.broadcast("change", { kind: "content", files: [] });
        },
        setGitOrigin(origin) {
            gitOrigin = origin === undefined ? undefined : validateGitOrigin(origin);
        },
        setAllowedDomains(domains) {
            if (!Array.isArray(domains)) throw new Error("Allowed domains must be a list");
            const previews = parsePreviewSettings({ domains });
            application.configure({
                languages: siteLanguages,
                workspace: workspaceSource,
                shared: sharedBranch,
                downloads: mode === "edit",
                previews,
            });
            workspaceServer.broadcast("change", { kind: "content", files: [] });
        },
    };
    viewer.setAllowedDomains(viewerPlugins.allowedDomains ?? []);
    await viewerPlugins.setup?.(viewer);
    const extensionErrors = await handleExtensions
        .restore()
        .catch((error: unknown) => [error instanceof Error ? error.message : String(error)]);
    for (const error of extensionErrors) terminal.error(`Plugin: ${error}`);
    if (startup?.file && startup.data) {
        const result = (await handleExtensions({
            action: "install",
            file: startup.file,
            data: startup.data,
            base: null,
        })) as { items: import("../../engine/src/core/extension-package.js").ExtensionSummary[] };
        loginPlugins = result.items.find((item) => item.file === startup.file)?.plugins ?? [];
        terminal.operation("Installed plugin", startup.file);
    }

    // DOCS_HMR=0 = no hot reload (nothing is watched = changes need a manual reload).
    if (process.env.DOCS_HMR !== "0") {
        const watcher = watchProject(root, pkgRoot, (kind, files) => {
            terminal.operation(kind === "client" ? "Reloaded client" : "Changed", files.join(", "));
            if (kind === "client") {
                bundleCache.clear();
                graphChunks = undefined;
            }
            workspaceServer.broadcast("change", { kind, files });
        });
        application.configure({
            languages: siteLanguages,
            workspace: workspaceSource,
            shared: sharedBranch,
            downloads: mode === "edit",
            watch: watcher.watchTextfiles,
        });
        process.once("exit", watcher.close);
    }

    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (await handlePlugins(req, res)) return;
        // The editor exposes workspace content and writes; refuse rebound hosts for every route.
        if (mode === "edit" && !isLocalHost(req.headers.host ?? "")) {
            sendJson(res, 403, { error: "The editor requires a local host" });
            return;
        }
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        if (req.method === "GET" && path.startsWith("/assets/fonts/")) {
            const font = readFont(path.slice("/assets/fonts/".length));
            if (!font) {
                notFound(res, path);
                return;
            }
            res.writeHead(200, {
                "content-type": "font/woff2",
                "cache-control": "public, max-age=86400",
            });
            res.end(font);
            return;
        }
        // No favicon (this only silences the 404 console error from the browser's auto-request).
        if (path === "/favicon.ico") {
            res.writeHead(204);
            res.end();
            return;
        }
        // Client bundles — graph.js (the schema graph interaction layer) is shared by
        // preview / edit, edit.js is for the editing UI only.
        const clientEntry =
            path === "/assets/client.js"
                ? "client-entry.ts"
                : path === "/assets/workspace-worker.js"
                  ? "workspace-worker.ts"
                  : path === "/assets/code.js"
                    ? "code-highlight.ts"
                    : path === "/assets/code-worker.js"
                      ? "code-worker.ts"
                      : mode === "edit" && path === "/assets/edit.js"
                        ? "edit-client.ts"
                        : path === "/assets/ui.js"
                          ? "ui-client.ts"
                          : undefined;
        const graphName =
            path === "/assets/graph.js"
                ? "schema-graph-global.js"
                : /^\/assets\/graph\/([\w-]+\.js)$/.exec(path)?.[1];
        if (req.method === "GET" && (clientEntry != null || graphName)) {
            const { js, etag } = await bundleCache.get(
                graphName ? path : (clientEntry ?? ""),
                () =>
                    graphName
                        ? path === "/assets/graph.js"
                            ? Promise.resolve('import "/assets/graph/schema-graph-global.js";')
                            : graphAsset(graphName)
                        : bundleClient(clientEntry ?? ""),
            );
            if (req.headers["if-none-match"] === etag) {
                res.writeHead(304, { etag, "cache-control": "no-cache" });
                res.end();
                return;
            }
            res.writeHead(200, {
                "content-type": "application/javascript; charset=utf-8",
                etag,
                "cache-control": "no-cache",
            });
            res.end(js);
            return;
        }
        if (mode === "edit" && req.method === "POST") {
            // Every write route: a cross-site form or fetch cannot send this origin + JSON type.
            if (
                !isLocalToolRequest(
                    req.headers.host ?? "",
                    req.headers.origin,
                    req.headers["content-type"],
                )
            ) {
                sendJson(res, 403, {
                    error: "Editing requires a same-origin local editor request",
                });
                return;
            }
            if (path === "/api/extensions") {
                res.setHeader("cache-control", "no-store");
                // Plugins run code, so they also stay off forwarded ports.
                if (
                    ![
                        `localhost:${req.socket.localPort}`,
                        `127.0.0.1:${req.socket.localPort}`,
                        `[::1]:${req.socket.localPort}`,
                    ].includes(req.headers.host ?? "")
                ) {
                    sendJson(res, 403, {
                        error: "Plugins require a same-origin local editor request",
                    });
                    return;
                }
                try {
                    const input = await readJson(req, MAX_EXTENSION_BYTES * 6 + 4096);
                    if (!input) throw new Error("Expected a plugin request");
                    sendJson(res, 200, await handleExtensions(input));
                } catch (error) {
                    sendJson(res, 409, {
                        error: error instanceof Error ? error.message : "Plugin operation failed",
                    });
                }
                return;
            }
        }
        await application.handle(mode, req, res);
    };

    const listener = (req: IncomingMessage, res: ServerResponse): void => {
        handle(req, res)
            .then(() => {
                if (typeof res.statusCode === "number")
                    logHttpOperation(req.method ?? "GET", req.url ?? "/", res.statusCode);
            })
            .catch((e: unknown) => {
                terminal.error(
                    `Request failed: ${req.method ?? "GET"} ${(req.url ?? "/").split(/[?#]/)[0]}`,
                );
                if (!res.headersSent) {
                    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
                }
                res.end(`error: ${e instanceof Error ? e.message : e}`);
            });
    };
    const tls = startup?.tls;
    const server = tls
        ? createSecureServer({ cert: readFileSync(tls.cert), key: readFileSync(tls.key) }, listener)
        : createServer(listener);
    const scheme = tls ? "https" : "http";
    server.on("close", () => {
        void isolated?.then((manager) => manager.close());
    });

    {
        const sockets = new WebSocketServer({
            noServer: true,
            maxPayload: Math.ceil((MAX_FILE_UPLOAD_BYTES * 4) / 3) + 16_384,
        });
        // A connection that vanished without closing (sleep, lost network) never answers a ping;
        // ending it here is what tells the history that its editor has left.
        const alive = new WeakSet<object>();
        setInterval(() => {
            for (const ws of sockets.clients) {
                if (!alive.has(ws)) {
                    ws.terminate();
                    continue;
                }
                alive.delete(ws);
                ws.ping();
            }
        }, HEARTBEAT_MS).unref();
        server.on("upgrade", (req, socket, head) => {
            const host = req.headers.host ?? "";
            // Browsers do not apply CORS to WebSockets, so this origin check is the whole defence.
            // The editor also refuses rebound hosts; a preview may sit behind a proxy.
            if (
                new URL(req.url ?? "/", "http://localhost").pathname !== WORKSPACE_PATH ||
                (mode === "edit" && !isLocalHost(host)) ||
                ![`http://${host}`, `https://${host}`].includes(req.headers.origin ?? "")
            ) {
                socket.destroy();
                return;
            }
            sockets.handleUpgrade(req, socket, head, (ws) => {
                const session: Session = { local: host.endsWith(`:${req.socket.localPort}`) };
                const detach = workspaceServer.connect(
                    {
                        send: (message) => ws.send(JSON.stringify(message)),
                        receive: (handler) => {
                            ws.on("message", (data) => {
                                let message: unknown;
                                try {
                                    message = JSON.parse(data.toString());
                                } catch {
                                    return;
                                }
                                handler(message);
                            });
                        },
                    },
                    session,
                );
                alive.add(ws);
                ws.on("pong", () => alive.add(ws));
                const leave = () => {
                    detach();
                    history.left(session);
                };
                ws.on("close", leave);
                ws.on("error", leave);
            });
        });
    }

    // If the port is in use (e.g. a previous instance left running), automatically try +1, up to
    // 10 ports.
    // The URL is printed once, on "listening" (no callbacks left over from failed listens).
    server.once("listening", () => {
        const addr = server.address();
        const p = typeof addr === "object" && addr ? addr.port : port;
        terminal.ready(mode === "preview" ? "view" : mode, root, `${scheme}://localhost:${p}/`);
        if (startup?.open) {
            const url = `${scheme}://localhost:${p}/`;
            const command = process.platform === "darwin" ? "open" : "xdg-open";
            const browser = spawn(command, [url], { stdio: "ignore", detached: true });
            browser.on("error", () => terminal.warn(`Open ${url} in your browser.`));
            browser.on("exit", (code) => {
                if (code) terminal.warn(`Open ${url} in your browser.`);
            });
            browser.unref();
        }
        for (const plugin of loginPlugins) {
            try {
                console.log(
                    `Log in to ${plugin}: ${handlePlugins.loginLink(plugin, `${scheme}://localhost:${p}`)}`,
                );
            } catch (error) {
                terminal.error(error instanceof Error ? error.message : String(error));
            }
        }
        if (loginPlugins.length)
            console.log(
                "Keep this command running while signing in. Login links expire in 10 minutes.",
            );
    });
    const listen = (p: number, left: number): void => {
        server.once("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE" && left > 0) {
                terminal.warn(`Port ${p} is in use; trying ${p + 1}`);
                listen(p + 1, left - 1);
                return;
            }
            throw err;
        });
        server.listen(p, "127.0.0.1");
    };
    listen(port, 10);
    return viewer;
};
