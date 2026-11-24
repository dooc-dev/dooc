import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { WebSocketServer } from "ws";
import {
    completeFilePaths,
    filesSnapshot,
    updateFiles,
    uploadFile,
} from "../../engine/src/compiler/files.js";
import {
    manifestFile,
    projectRoot,
    readManifest,
    sectionManifest,
} from "../../engine/src/compiler/manifest.js";
import { flattenTree } from "../../engine/src/core/content-metadata.js";
import {
    type DocumentRevision,
    latestVersionOnly,
    parseVersionSelection,
    selectVersions,
} from "../../engine/src/core/document-version.js";
import { MAX_FILE_UPLOAD_BYTES } from "../../engine/src/core/files.js";
import { parsePreviewSettings } from "../../engine/src/core/previewers.js";
import { docPath } from "../../engine/src/core/routing.js";
import { parseWorkspaceSource } from "../../engine/src/core/workspace.js";
import {
    type ApplicationRequest,
    applicationRequest,
} from "../../frontend/src/application-request.js";
import { createDocumentApplication } from "../../frontend/src/document-application.js";
import { createHistoryOp, type Person, parsePerson } from "../../workspace/src/history.js";
import { assertReadOnlyOperation } from "../../workspace/src/read-only.js";
import { createWorkspaceServer, type WorkspaceOps } from "../../workspace/src/server.js";
import { createDocumentVersions } from "./document-versions.js";
import {
    isLocalHost,
    requestScheme,
    runCodeTool,
    validateCodeTools,
    validateTextfileCode,
} from "./editor-tools.js";
import { createExtensionManager } from "./extensions.js";
import { fontCss } from "./fonts.js";
import { frameBlocked } from "./frame-policy.js";
import {
    createGitHandler,
    git,
    gitManifestPath,
    gitWorktrees,
    hasGitManifest,
    validateGitOrigin,
} from "./git.js";
import { gitBaseBody, gitBaseText, setSubformatChanges } from "./git-diff.js";
import { workspaceHistory } from "./history.js";
import { watchProject } from "./hmr.js";
import { DEFAULT_SITE_LANGUAGES, loadSiteLanguages } from "./languages.js";
import { loggedWorkspaceOps } from "./operation-log.js";
import { loadReaderPlugins, type ReaderRuntime } from "./plugin-config.js";
import { createLocalPluginStorage } from "./plugins/local-storage.js";
import { createPluginHandler } from "./plugins.js";
import { prepareDocumentSources } from "./remote-manifests.js";
import { terminal } from "./terminal.js";
import { readWorkspaceSource, sourceFileBase } from "./workspace.js";

export interface WorkspaceDescription {
    id: string;
    label: string;
    branch?: string;
    readOnly?: boolean;
    revision?: DocumentRevision;
    manifest?: string;
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
    readOnly = false,
    shared?: string,
    versions = "latest",
) => {
    const primary = projectRoot(manifest);
    const selection = parseVersionSelection(readOnly ? versions : "*");
    const entries = new Map<
        string,
        {
            description: WorkspaceDescription;
            root: string;
            app: ReturnType<typeof createDocumentApplication>;
            git: ReturnType<typeof createGitHandler>;
            history: ReturnType<typeof createHistoryOp>;
            versions: ReturnType<typeof createDocumentVersions>;
            owner: string;
            sourceRoot: string;
        }
    >();
    const closes: (() => void)[] = [];
    const sectionCatalogs = new Map<string, ReturnType<typeof createDocumentVersions>>();
    type Session = {
        local: boolean;
        readOnly?: boolean;
        user?: Person;
        origin?: string;
        pluginSession?: string;
    };
    const plugins = await loadReaderPlugins(pluginModule);
    let workspace = plugins.workspace;
    let gitOrigin = plugins.gitOrigin;
    let previews = parsePreviewSettings({ domains: plugins.allowedDomains ?? [] });
    const personal = createLocalPluginStorage();
    const handlePlugins = createPluginHandler(
        plugins.plugins,
        plugins,
        personal.credentials,
        (revision) => notify("plugins", revision),
    );
    const extensions = createExtensionManager(primary, handlePlugins, plugins, personal);
    closes.push(extensions.dispose);
    const configure = () => {
        for (const { root, app } of entries.values())
            app.configure({
                workspace: workspace ?? readWorkspaceSource(root),
                previews,
                shared,
                downloads: !readOnly,
            });
        notify("change", { kind: "content", files: [] });
    };
    const reader: ReaderRuntime = {
        register: handlePlugins.register,
        unregister: handlePlugins.unregister,
        setWorkspace(source) {
            workspace = source === undefined ? undefined : parseWorkspaceSource(source);
            configure();
        },
        setGitOrigin(origin) {
            gitOrigin = origin === undefined ? undefined : validateGitOrigin(origin);
        },
        setAllowedDomains(domains) {
            if (!Array.isArray(domains)) throw new Error("Allowed domains must be a list");
            previews = parsePreviewSettings({ domains });
            configure();
        },
    };
    const add = async (
        root: string,
        id: string,
        owner = id,
        revision?: DocumentRevision,
        catalogOverride?: ReturnType<typeof createDocumentVersions>,
        section?: string,
        sourceRoot = root,
    ) => {
        const existing = entries.get(id);
        if (existing) return existing;
        const source = workspace ?? readWorkspaceSource(root);
        const app = createDocumentApplication(root, {
            prepareSources: prepareDocumentSources,
            frameBlocked,
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
            ...(section ? { manifest: section } : {}),
            label: source.protocol === "git" ? source.branch : basename(root),
            ...(source.protocol === "git" ? { branch: source.branch } : {}),
            ...(revision ? { revision, readOnly: true, label: revision.version } : {}),
        };
        const catalog =
            catalogOverride ?? entries.get(owner)?.versions ?? createDocumentVersions(root);
        const entry = {
            description,
            root,
            app,
            git: createGitHandler(root, () => gitOrigin),
            history: createHistoryOp(
                () => workspaceHistory(root, shared),
                shared === undefined ? {} : { idleMs: 5 * 60_000, leaveMs: 30_000 },
            ),
            versions: catalog,
            owner,
            sourceRoot,
        };
        entries.set(id, entry);
        const watcher = watchProject(root, "", (kind, files) =>
            notify("change", { kind, files, workspace: id }),
        );
        closes.push(watcher.close);
        app.configure({
            languages: revision ? DEFAULT_SITE_LANGUAGES : await loadSiteLanguages(root),
            workspace: source,
            previews,
            downloads: !readOnly,
            shared,
            watch: watcher.watchTextfiles,
            readOnly: !!revision,
        });
        return entry;
    };
    const entry = (input: Record<string, unknown>) => {
        const value = entries.get(typeof input.workspace === "string" ? input.workspace : "main");
        if (!value) throw new Error("Workspace is not open");
        return value;
    };
    let opening = false;
    const versionContext = async (current: ReturnType<typeof entry>, manifest?: unknown) => {
        await prepareDocumentSources(current.root);
        if (manifest === undefined) return { current, basePath: "" };
        sectionManifest(current.root, manifest);
        const selected = sectionManifest(current.sourceRoot, manifest);
        let catalog = sectionCatalogs.get(selected);
        if (!catalog) {
            catalog = createDocumentVersions(dirname(selected), basename(selected));
            sectionCatalogs.set(selected, catalog);
        }
        const pages = flattenTree(readManifest(current.root).tree);
        const mount = pages.find((page) => page.origin === manifest);
        const section = current.description.manifest
            ? join(dirname(current.description.manifest), String(manifest)).replaceAll("\\", "/")
            : String(manifest);
        const revision = current.description.revision;
        const selectedVersion = revision ? await catalog.versionAt(revision.revision) : undefined;
        return {
            current: {
                ...current,
                versions: catalog,
                sourceRoot: dirname(selected),
                description: {
                    ...current.description,
                    manifest: section,
                    revision:
                        revision && selectedVersion
                            ? { ...revision, version: selectedVersion }
                            : undefined,
                },
            },
            basePath: mount ? docPath(pages, mount.id) : "",
        };
    };
    const versionRows = async (current: ReturnType<typeof entry>) => {
        await prepareDocumentSources(current.sourceRoot);
        const all = await current.versions.list();
        const rows = selectVersions(all, selection);
        if (readOnly && !all.length && current.versions.enabled())
            throw new Error(
                "No published document versions. Commit Git sources or build a source snapshot first.",
            );
        if (readOnly && !rows.length && (all.length || versions !== "latest"))
            throw new Error("No document versions match the publication selection");
        return rows;
    };
    const openVersion = async (current: ReturnType<typeof entry>, value: string) => {
        const rows = await versionRows(current);
        const revision = value === "latest" ? rows[0] : rows.find((row) => row.version === value);
        if (!revision) throw new Error("Document version is not published");
        const owner = entries.get(current.owner);
        if (!owner) throw new Error("Version workspace is not open");
        if (revision.current && !readOnly) return owner;
        const id = `${owner.description.id}${current.description.manifest ? `#${current.description.manifest}` : ""}@${revision.revision}`;
        const opened = entries.get(id);
        if (opened) return opened;
        return add(
            await current.versions.open(revision.revision),
            id,
            owner.description.id,
            revision,
            current.versions,
            current.description.manifest,
            current.sourceRoot,
        );
    };
    const ops: WorkspaceOps<Session> = {
        versions: async (input) => {
            const { current, basePath } = await versionContext(entry(input), input.manifest);
            if (input.action === "open") {
                if (typeof input.version !== "string") throw new Error("Choose a document version");
                return (await openVersion(current, input.version)).description;
            }
            if (input.action !== "list") throw new Error("Invalid version action");
            const rows = await versionRows(current);
            return {
                versions: rows,
                basePath,
                selected:
                    current.description.revision?.version ??
                    (readOnly ? rows[0]?.version : rows.find((row) => row.current)?.version),
                current: rows.find((row) => row.current)?.version,
                selector: readOnly ? versions : "*",
                showSelector: rows.length > 1 && !(readOnly && latestVersionOnly(selection)),
            };
        },
        workspaces: async (input) => {
            if (input.action === "list")
                return [...entries.values()].map(({ description }) => description);
            if (shared !== undefined)
                throw new Error("Shared workspaces stay on their snapshot branch");
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
        http: async (input, session) => {
            if (
                typeof input.url !== "string" ||
                !input.url.startsWith("/") ||
                input.url.startsWith("//") ||
                !["GET", "POST"].includes(String(input.method)) ||
                typeof input.body !== "string"
            )
                throw new Error("Invalid document request");
            const result = await applicationRequest(
                entry(input).app,
                readOnly || session.readOnly ? "preview" : "edit",
                {
                    url: input.url,
                    method: String(input.method),
                    body: input.body,
                    headers:
                        input.headers && typeof input.headers === "object"
                            ? (input.headers as ApplicationRequest["headers"])
                            : {},
                },
            );
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
        git: (input, session) => {
            if (!session.local) throw new Error("Git requires a same-origin local editor request");
            if (input.action === "switch" || input.action === "branch")
                throw new Error("Open the branch in a separate workspace");
            return entry(input).git(input);
        },
        history: (input, session) => entry(input).history.op(input, session),
        extensions: (input, session) => {
            if (!session.local)
                throw new Error("Plugins require a same-origin local editor request");
            return extensions(input);
        },
        plugins: (input, session) => {
            if (!session.local || !session.origin)
                throw new Error("Plugins require a same-origin local editor request");
            if (!session.pluginSession || !handlePlugins.hasSession(session.pluginSession))
                session.pluginSession = handlePlugins.createSession();
            if (input.action === "connect") {
                if (typeof input.plugin !== "string") throw new Error("Invalid plugin ID");
                return {
                    url: handlePlugins.loginLink(
                        input.plugin,
                        session.origin,
                        session.pluginSession,
                    ),
                };
            }
            return handlePlugins.request(input, session.pluginSession, session.origin);
        },
    };
    if (shared !== undefined) {
        delete ops.git;
        ops.identify = (input, session) => {
            session.user = parsePerson(input);
            return session.user;
        };
    }
    const queues = new Map<string, Promise<unknown>>();
    const reads = new Map<string, Set<Promise<unknown>>>();
    const gitReads = new Map<string, Promise<unknown>>();
    const serial = Object.fromEntries(
        Object.entries(ops).map(([name, operation]) => [
            name,
            (input: Record<string, unknown>, session: Session, signal?: AbortSignal) => {
                if (readOnly || session.readOnly) assertReadOnlyOperation(name, input);
                const id = typeof input.workspace === "string" ? input.workspace : "main";
                const run = async () => {
                    signal?.throwIfAborted();
                    let target = entry(input);
                    if (
                        readOnly &&
                        target.description.revision &&
                        !["versions", "workspaces"].includes(name)
                    ) {
                        const rows = await versionRows(target);
                        if (
                            !rows.some(
                                (row) => row.revision === target.description.revision?.revision,
                            )
                        )
                            throw new Error("Document version is not published");
                    }
                    if (
                        readOnly &&
                        !["versions", "workspaces"].includes(name) &&
                        !target.description.revision
                    ) {
                        const rows = await versionRows(target);
                        if (rows.length)
                            target = await openVersion(target, rows[0]?.version ?? "latest");
                    }
                    if (target.description.readOnly) {
                        if (name !== "http" || input.method !== "GET")
                            assertReadOnlyOperation(name, input, !readOnly);
                    }
                    signal?.throwIfAborted();
                    return operation(
                        { ...input, workspace: target.description.id },
                        session,
                        signal,
                    );
                };
                const reading =
                    (name === "http" && input.method === "GET") ||
                    (name === "files" && ["read", "complete"].includes(String(input.action))) ||
                    (name === "git" && ["read", "branches", "diff"].includes(String(input.action)));
                const active = reads.get(id) ?? new Set<Promise<unknown>>();
                reads.set(id, active);
                // Reads share a snapshot between writes; slow remote Git reads do not hold up navigation.
                const before = reading
                    ? [queues.get(id), ...(name === "git" ? [gitReads.get(id)] : [])]
                    : [queues.get(id), ...active];
                const next = Promise.allSettled(before).then(run);
                if (reading) {
                    active.add(next);
                    void next.then(
                        () => active.delete(next),
                        () => active.delete(next),
                    );
                    if (name === "git")
                        gitReads.set(
                            id,
                            next.catch(() => {}),
                        );
                } else
                    queues.set(
                        id,
                        next.catch(() => {}),
                    );
                return next;
            },
        ]),
    );
    try {
        await plugins.setup?.(reader);
        const errors = await extensions.restore();
        for (const error of errors) terminal.error(`Plugin: ${error}`);
        await add(primary, "main");
    } catch (error) {
        for (const close of closes) close();
        throw error;
    }
    return {
        ops: serial,
        plugins: handlePlugins,
        left: (session: Session) => {
            for (const { history } of entries.values()) history.left(session);
        },
        close: () => {
            for (const close of closes) close();
            for (const { history } of entries.values()) void history.flush();
            for (const catalog of new Set(
                [...entries.values()]
                    .map((value) => value.versions)
                    .concat([...sectionCatalogs.values()]),
            ))
                catalog.close();
        },
    };
};

export const attachWorkspaceServer = async (
    server: Server,
    manifest: string,
    origin = "http://localhost:3000",
    pluginModule?: string,
    readOnly = false,
    path = "/server",
    shared?: string,
    versions = "latest",
    workingCopy = false,
) => {
    const allowed = clientOrigin(origin);
    let channel: ReturnType<typeof createWorkspaceServer<{ local: boolean }>> | undefined;
    // Development reads working files; each connection still enforces its read-only access.
    const manager = await nodeWorkspaceOperations(
        manifest,
        pluginModule,
        (event, data) => channel?.broadcast(event, data),
        readOnly && !workingCopy,
        shared,
        versions,
    );
    const activeChannel = createWorkspaceServer(loggedWorkspaceOps(manager.ops), {
        boot: crypto.randomUUID(),
        readOnly,
        ...(shared === undefined ? {} : { shared: true }),
    });
    channel = activeChannel;
    const sockets = new WebSocketServer({
        noServer: true,
        maxPayload: Math.ceil((MAX_FILE_UPLOAD_BYTES * 4) / 3) + 16_384,
    });
    const alive = new WeakSet<object>();
    const heartbeat = setInterval(() => {
        for (const ws of sockets.clients) {
            if (!alive.has(ws)) ws.terminate();
            else {
                alive.delete(ws);
                ws.ping();
            }
        }
    }, 30_000);
    heartbeat.unref();
    server.on("upgrade", (req, socket, head) => {
        if (
            !isLocalHost(req.headers.host ?? "") ||
            req.headers.origin !== allowed ||
            req.url !== path
        ) {
            socket.destroy();
            return;
        }
        sockets.handleUpgrade(req, socket, head, (ws) => {
            const session = {
                local: (req.headers.host ?? "").endsWith(`:${req.socket.localPort}`),
                origin: `${requestScheme(req)}://${req.headers.host}`,
                readOnly,
            };
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
                session,
            );
            alive.add(ws);
            ws.on("pong", () => alive.add(ws));
            const leave = () => {
                detach();
                manager.left(session);
            };
            ws.on("close", leave);
            ws.on("error", leave);
        });
    });
    let closed = false;
    const dispose = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        manager.close();
        for (const ws of sockets.clients) ws.terminate();
        sockets.close();
    };
    server.once("close", dispose);
    const close = server.close.bind(server);
    server.close = (callback) => {
        for (const ws of sockets.clients) ws.terminate();
        return close(callback);
    };
    return Object.assign(dispose, { plugins: manager.plugins });
};
