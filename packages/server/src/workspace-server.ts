import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { WebSocketServer } from "ws";
import {
    completeFilePaths,
    filesSnapshot,
    updateFiles,
    uploadFile,
} from "../../engine/src/compiler/files.js";
import { manifestFile, projectRoot } from "../../engine/src/compiler/manifest.js";
import { MAX_FILE_UPLOAD_BYTES } from "../../engine/src/core/files.js";
import { defaultPreviewSettings } from "../../engine/src/core/previewers.js";
import {
    type ApplicationRequest,
    applicationRequest,
} from "../../frontend/src/application-request.js";
import { createDocumentApplication } from "../../frontend/src/document-application.js";
import { createHistoryOp } from "../../workspace/src/history.js";
import { WORKSPACE_PATH } from "../../workspace/src/protocol.js";
import { createWorkspaceServer, type WorkspaceOps } from "../../workspace/src/server.js";
import {
    isLocalHost,
    runCodeTool,
    validateCodeTools,
    validateTextfileCode,
} from "./editor-tools.js";
import { fontCss } from "./fonts.js";
import { createGitHandler, git, gitManifestPath, gitWorktrees, hasGitManifest } from "./git.js";
import { gitBaseBody, gitBaseText, setSubformatChanges } from "./git-diff.js";
import { workspaceHistory } from "./history.js";
import { watchProject } from "./hmr.js";
import { loadSiteLanguages } from "./languages.js";
import { loadViewerPlugins } from "./plugin-config.js";
import { readWorkspaceSource, sourceFileBase } from "./workspace.js";

export interface WorkspaceDescription {
    id: string;
    label: string;
    branch?: string;
}

export const clientOrigin = (value: string): string => {
    const url = new URL(value);
    if (
        !/^https?:$/.test(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
    )
        throw new Error("Client origin must be an HTTP(S) origin without a path or credentials");
    return url.origin;
};

export const nodeWorkspaceOperations = async (
    manifest: string,
    pluginModule?: string,
    notify: (event: string, data: unknown) => void = () => {},
) => {
    const primary = projectRoot(manifest);
    const entries = new Map<
        string,
        {
            description: WorkspaceDescription;
            root: string;
            app: ReturnType<typeof createDocumentApplication>;
            git: ReturnType<typeof createGitHandler>;
            history: ReturnType<typeof createHistoryOp>;
        }
    >();
    const closes: (() => void)[] = [];
    type Session = { local: boolean; user?: import("../../workspace/src/history.js").Person };
    const add = async (root: string, id: string) => {
        const existing = entries.get(id);
        if (existing) return existing;
        const source = readWorkspaceSource(root);
        const plugins = await loadViewerPlugins(pluginModule);
        const app = createDocumentApplication(root, {
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
        const description: WorkspaceDescription = {
            id,
            label:
                source.protocol === "git"
                    ? `${source.branch}/${source.repo ?? basename(root)}`
                    : basename(root),
            ...(source.protocol === "git" ? { branch: source.branch } : {}),
        };
        const entry = {
            description,
            root,
            app,
            git: createGitHandler(root, () => plugins.gitOrigin),
            history: createHistoryOp(() => workspaceHistory(root)),
        };
        entries.set(id, entry);
        const watcher = watchProject(root, "", (kind, files) =>
            notify("change", { kind, files, workspace: id }),
        );
        closes.push(watcher.close);
        app.configure({
            languages: await loadSiteLanguages(root),
            workspace: source,
            previews: defaultPreviewSettings(),
            downloads: true,
            watch: watcher.watchTextfiles,
        });
        return entry;
    };
    const entry = (input: Record<string, unknown>) => {
        const value = entries.get(typeof input.workspace === "string" ? input.workspace : "main");
        if (!value) throw new Error("Workspace is not open");
        return value;
    };
    let opening = false;
    const ops: WorkspaceOps<Session> = {
        workspaces: async (input) => {
            if (input.action === "list")
                return [...entries.values()].map(({ description }) => description);
            if (
                input.action !== "branch" ||
                typeof input.branch !== "string" ||
                !input.branch.trim()
            )
                throw new Error("Choose a branch");
            if (opening) throw new Error("A workspace is opening. Try again when it finishes.");
            opening = true;
            try {
                const current = entry(input);
                const repository = (
                    await git(current.root, ["rev-parse", "--show-toplevel"])
                ).trim();
                await git(repository, ["check-ref-format", "--branch", input.branch]);
                const manifest = gitManifestPath(current.root, repository);
                const missingManifest = () =>
                    new Error(
                        input.create
                            ? `Cannot create a branch workspace: "${manifest}" is not committed in HEAD. Commit this manifest before creating a branch.`
                            : `Branch "${input.branch}" does not contain "${manifest}". Choose a branch containing this manifest.`,
                    );
                const existing = [...entries.values()].find(
                    (e) => e.description.branch === input.branch,
                );
                if (existing && !input.create) {
                    if (!(await hasGitManifest(existing.root, manifestFile(existing.root))))
                        throw missingManifest();
                    return existing.description;
                }
                const common = resolve(
                    repository,
                    (await git(repository, ["rev-parse", "--git-common-dir"])).trim(),
                );
                const id = createHash("sha256")
                    .update(`${common}\0${input.branch}`)
                    .digest("hex")
                    .slice(0, 20);
                const checkedOut =
                    !input.create && (await gitWorktrees(repository)).get(input.branch);
                const target = checkedOut || join(common, "dooc-worktrees", id);
                if (!existsSync(target)) {
                    if (
                        !(await hasGitManifest(
                            repository,
                            manifest,
                            input.create ? "HEAD" : `refs/heads/${input.branch}`,
                        ))
                    )
                        throw missingManifest();
                    mkdirSync(dirname(target), { recursive: true });
                    await git(repository, [
                        "worktree",
                        "add",
                        ...(input.create ? ["-b", input.branch] : []),
                        target,
                        input.create ? "HEAD" : input.branch,
                    ]);
                } else {
                    if (input.create) throw new Error("Branch already has a workspace");
                    if (
                        (await git(target, ["symbolic-ref", "--short", "HEAD"])).trim() !==
                        input.branch
                    )
                        throw new Error("Saved worktree now belongs to a different branch");
                    if (!(await hasGitManifest(target, manifest))) throw missingManifest();
                }
                const next = projectRoot(join(target, manifest));
                return (await add(next, id)).description;
            } finally {
                opening = false;
            }
        },
        http: async (input) => {
            if (
                typeof input.url !== "string" ||
                !input.url.startsWith("/") ||
                input.url.startsWith("//") ||
                !["GET", "POST"].includes(String(input.method)) ||
                typeof input.body !== "string"
            )
                throw new Error("Invalid document request");
            const result = await applicationRequest(entry(input).app, "edit", {
                url: input.url,
                method: String(input.method),
                body: input.body,
                headers:
                    input.headers && typeof input.headers === "object"
                        ? (input.headers as ApplicationRequest["headers"])
                        : {},
            });
            return {
                ...result,
                body: typeof result.body === "string" ? result.body : Array.from(result.body),
            };
        },
        files: (input) => {
            const { root } = entry(input);
            return input.action === "read"
                ? filesSnapshot(root)
                : input.action === "complete"
                  ? completeFilePaths(root, input.prefix)
                  : input.action === "upload"
                    ? uploadFile(root, input)
                    : updateFiles(root, input);
        },
        git: (input) => {
            if (input.action === "switch" || input.action === "branch")
                throw new Error("Open the branch in a separate workspace");
            return entry(input).git(input);
        },
        history: (input, session) => entry(input).history.op(input, session),
    };
    const queues = new Map<string, Promise<unknown>>();
    const serial = Object.fromEntries(
        Object.entries(ops).map(([name, operation]) => [
            name,
            (input: Record<string, unknown>, session: Session) => {
                const id = typeof input.workspace === "string" ? input.workspace : "main";
                const run = () => operation(input, session);
                const next = (queues.get(id) ?? Promise.resolve()).then(run, run);
                queues.set(
                    id,
                    next.catch(() => {}),
                );
                return next;
            },
        ]),
    );
    await add(primary, "main");
    return {
        ops: serial,
        close: () => {
            for (const close of closes) close();
        },
    };
};

export const startWorkspaceServer = async (
    manifest: string,
    port = 5179,
    origin = "http://localhost:5180",
    pluginModule?: string,
) => {
    const allowed = clientOrigin(origin);
    let channel: ReturnType<typeof createWorkspaceServer<{ local: boolean }>> | undefined;
    const manager = await nodeWorkspaceOperations(manifest, pluginModule, (event, data) =>
        channel?.broadcast(event, data),
    );
    const activeChannel = createWorkspaceServer(manager.ops, { boot: crypto.randomUUID() });
    channel = activeChannel;
    const server = createServer((_req, res) => {
        res.writeHead(404);
        res.end("Connect using the dooc workspace socket");
    });
    const sockets = new WebSocketServer({
        noServer: true,
        maxPayload: Math.ceil((MAX_FILE_UPLOAD_BYTES * 4) / 3) + 16_384,
    });
    server.on("upgrade", (req, socket, head) => {
        if (
            !isLocalHost(req.headers.host ?? "") ||
            req.headers.origin !== allowed ||
            req.url !== WORKSPACE_PATH
        ) {
            socket.destroy();
            return;
        }
        sockets.handleUpgrade(req, socket, head, (ws) => {
            const detach = activeChannel.connect(
                {
                    send: (message) => {
                        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
                    },
                    receive: (handler) =>
                        ws.on("message", (data) => {
                            try {
                                handler(JSON.parse(data.toString()));
                            } catch {
                                ws.close(1007, "Invalid JSON");
                            }
                        }),
                },
                { local: true },
            );
            ws.on("close", detach);
            ws.on("error", detach);
        });
    });
    server.on("close", () => {
        manager.close();
        for (const ws of sockets.clients) ws.terminate();
        sockets.close();
    });
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(port, "127.0.0.1", resolve);
        });
    } catch (error) {
        manager.close();
        sockets.close();
        throw error;
    }
    const address = server.address();
    console.log(
        `dooc server: ws://localhost:${typeof address === "object" && address ? address.port : port}${WORKSPACE_PATH} (client: ${allowed})`,
    );
    return server;
};
