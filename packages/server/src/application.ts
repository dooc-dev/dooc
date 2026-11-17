import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createServer, type RequestListener } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { manifestFile, projectRoot } from "../../engine/src/compiler/manifest.js";
import { MANIFEST_FILE } from "../../engine/src/core/content-metadata.js";
import { parseVersionSelection, selectVersions } from "../../engine/src/core/document-version.js";
import { validateRelayUrl } from "../../workspace/src/mcp-relay.js";
import { packageVersion } from "./assets.js";
import { createDocumentVersions } from "./document-versions.js";
import { startMcp } from "./mcp.js";
import { createMcpHandler } from "./mcp-http.js";
import { loadReaderPlugins } from "./plugin-config.js";
import { clientAssets, staticClientHandler, validateServerUrl } from "./static-client.js";
import { terminal } from "./terminal.js";
import { attachWorkspaceServer, clientOrigin } from "./workspace-server.js";

export interface ApplicationOptions {
    product: "editor" | "reader";
    action: "build" | "run";
    runtime: "node" | "web";
    client: boolean;
    server: boolean;
    mcp: boolean;
    mcpTransport?: "stdio" | "http";
    port: number;
    project: string;
    out: string;
    serverUrl?: string;
    relayUrl?: string;
    origin: string;
    pluginModule?: string;
    repo?: string;
    tls?: { cert: string; key: string };
    shared?: string;
    versions?: string;
}

export const applicationUsage = (product: "editor" | "reader") => `usage: dooc ${product} [options]
       dooc ${product} <build|run> <node|web> [options]

Shortcut: dooc ${product} [options] = dooc ${product} run node --all [options].
Reads ./dooc.yaml from the current directory; --project and --port override the defaults.

Explicit build/run commands default components to off. Choose one or more:
  --client                     static frontend
  --server                     Node workspace service or browser Worker
  --mcp                        Node MCP service or browser HTTPS relay connector
  --all                        select all three components
  --no-client --no-server --no-mcp  disable components, including those selected by --all

Options:
  --mcp-transport stdio|http    Node MCP transport (default: http; requires --mcp)
  --project <path>              workspace folder or manifest (default: ./dooc.yaml)
  --port <port>                 shared run port (default: 3000)
  --out <directory>             application assets in an empty directory (default: ./dooc-${product}-<runtime>)
  --server-url <ws-url>         separate Node workspace connection (requires --client)
  --relay-url <https-origin>    hosted relay for web MCP (requires --client --server --mcp)
  --client-origin <origin>      permitted browser origin (default: http://localhost:<port>)
  --reader-plugins <module>     Node workspace plugin module
  --repo <git-url>              clone a repository and resolve --project inside it (run node)
${product === "reader" ? "  --versions <selection>       published document versions (default: latest; '*' selects all)" : "  --shared <branch>             record shared editor snapshots (run node --server; no --mcp)"}
  --tls-cert <pem> --tls-key <pem>  serve HTTPS (run node; or DOOC_TLS_CERT / DOOC_TLS_KEY)
  --help, -h                    show this help

${product === "reader" ? "Reader workspace and MCP tools are read-only." : "Editor workspace and MCP tools can read and edit documents."}
Web MCP connects through Desktop or a hosted relay.
Web run --server requires --client to host the Worker. Web build can emit either component.
Node builds emit start.mjs and package.json when server or MCP is selected. Install their
dependencies, then run node start.mjs --project <path>. Documents are not copied into builds.
Node run uses one loopback port: /client/ (frontend), /server (WebSocket), /mcp (HTTP).
The enabled client opens at http://localhost:<port>/client/; / redirects there.
Web serves static assets at /. Stdio MCP uses stdin/stdout; logs go to stderr.
Stdio-only runs open no port. Closing stdin stops the selected components.
Examples:
  dooc ${product} --project docs/team.dooc.yaml
  dooc ${product} build web --client --server --out ./web-${product}
  dooc ${product} run node --mcp --mcp-transport stdio --project docs/dooc.yaml
  dooc ${product} run node --mcp --mcp-transport http --port 4000
Browser relays are started separately with dooc relay --help.
Document publishing uses dooc build; source archives use dooc zip.
DOOC_READER_PLUGINS supplies the Node run plugin module when --reader-plugins is omitted.

Source development (repository checkout):
  mise run ${product}                  generated playground on port ${product === "editor" ? "2000" : "2001"}, with hot reload
  mise run dev                     editor :2000 and reader :2001 as separate processes
Development reader and MCP preview working files with read-only permissions.
Regular reader commands use published versions; regular run defaults to port 3000.`;

export const parseApplicationOptions = (
    product: "editor" | "reader",
    args: string[],
): ApplicationOptions | undefined => {
    const { positionals, values } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            client: { type: "boolean" },
            server: { type: "boolean" },
            mcp: { type: "boolean" },
            "mcp-transport": { type: "string" },
            all: { type: "boolean" },
            "no-client": { type: "boolean" },
            "no-server": { type: "boolean" },
            "no-mcp": { type: "boolean" },
            project: { type: "string" },
            port: { type: "string" },
            out: { type: "string" },
            "server-url": { type: "string" },
            "relay-url": { type: "string" },
            "client-origin": { type: "string" },
            "reader-plugins": { type: "string" },
            repo: { type: "string" },
            "tls-cert": { type: "string" },
            "tls-key": { type: "string" },
            shared: { type: "string" },
            versions: { type: "string" },
            help: { type: "boolean", short: "h" },
        },
    });
    if (values.help) return;
    if (values.versions !== undefined && product !== "reader")
        throw new Error("--versions applies to reader publication; editor history stays available");
    if (product === "reader") parseVersionSelection(values.versions ?? "latest");
    if (!positionals.length) {
        positionals.push("run", "node");
        values.all = true;
    }
    const [action, runtime] = positionals;
    if (
        positionals.length !== 2 ||
        (action !== "build" && action !== "run") ||
        (runtime !== "node" && runtime !== "web")
    )
        throw new Error(`Expected: dooc ${product} <build|run> <node|web>`);
    const selected = (name: "client" | "server" | "mcp") =>
        !values[`no-${name}`] && !!(values.all || values[name]);
    const client = selected("client"),
        server = selected("server"),
        mcp = selected("mcp");
    if (!client && !server && !mcp) throw new Error("Select --client, --server, --mcp, or --all");
    const mcpTransport = values["mcp-transport"];
    if (mcpTransport !== undefined) {
        if (mcpTransport !== "stdio" && mcpTransport !== "http")
            throw new Error("--mcp-transport must be stdio | http");
        if (runtime !== "node" || !mcp) throw new Error("--mcp-transport requires node --mcp");
    }
    const stdioOnly = mcpTransport === "stdio" && !client && !server;
    if (
        stdioOnly &&
        [values.port, values["client-origin"], values["tls-cert"], values["tls-key"]].some(
            (value) => value !== undefined,
        )
    )
        throw new Error("Stdio-only MCP does not use --port, --client-origin or TLS options");
    if (runtime === "web" && mcp && (!client || !server))
        throw new Error("Web MCP requires --client and --server");
    if (values["relay-url"] && (runtime !== "web" || !mcp))
        throw new Error("--relay-url requires web --mcp");
    if (runtime === "web" && action === "run" && server && !client)
        throw new Error(
            "Running a browser Worker requires --client; use build web --server to export the Worker",
        );
    if (action === "build" && values.port !== undefined)
        throw new Error("--port applies to run; build starts no listeners");
    if (action === "run" && values.out !== undefined) throw new Error("--out applies to build");
    if (
        runtime === "web" &&
        (values["server-url"] || values["client-origin"] || values["reader-plugins"])
    )
        throw new Error("--server-url, --client-origin and --reader-plugins apply to node");
    if (values["server-url"] && !client) throw new Error("--server-url requires --client");
    const nodeRun = action === "run" && runtime === "node";
    const cert =
        values["tls-cert"] ?? (nodeRun && !stdioOnly ? process.env.DOOC_TLS_CERT : undefined);
    const key = values["tls-key"] ?? (nodeRun && !stdioOnly ? process.env.DOOC_TLS_KEY : undefined);
    if ((values.repo !== undefined || cert || key || values.shared !== undefined) && !nodeRun)
        throw new Error("--repo, TLS and --shared apply to run node");
    if (values.repo !== undefined && !server && !mcp)
        throw new Error("--repo requires --server or --mcp");
    if (values.shared !== undefined && (product !== "editor" || !server || !values.shared.trim()))
        throw new Error("--shared requires an editor server and a branch name");
    if (values.shared !== undefined && mcp)
        throw new Error("--shared cannot use --mcp; shared edits require an identified editor");
    if (!cert !== !key) throw new Error("--tls-cert and --tls-key must be given together");
    const port = Number(values.port ?? 3000);
    if (!/^\d+$/.test(values.port ?? "3000") || !Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error("Choose a port between 1 and 65535");
    return {
        product,
        action,
        runtime,
        client,
        server,
        mcp,
        ...(mcpTransport === undefined ? {} : { mcpTransport }),
        port,
        project: values.project ?? MANIFEST_FILE,
        out: resolve(values.out ?? `dooc-${product}-${runtime}`),
        serverUrl: values["server-url"] ? validateServerUrl(values["server-url"]) : undefined,
        relayUrl: values["relay-url"] ? validateRelayUrl(values["relay-url"]) : undefined,
        origin: clientOrigin(
            values["client-origin"] ?? `${cert ? "https" : "http"}://localhost:${port}`,
        ),
        pluginModule:
            values["reader-plugins"] ?? (nodeRun ? process.env.DOOC_READER_PLUGINS : undefined),
        ...(values.repo === undefined ? {} : { repo: values.repo }),
        ...(cert && key ? { tls: { cert: resolve(cert), key: resolve(key) } } : {}),
        ...(values.shared === undefined ? {} : { shared: values.shared }),
        ...(product === "reader" ? { versions: values.versions ?? "latest" } : {}),
    };
};

const clientOptions = (options: ApplicationOptions) => ({
    runtime: options.runtime,
    readOnly: options.product === "reader",
    client: options.client,
    worker: options.runtime === "web" && options.server,
    basePath: options.runtime === "node" ? "/client" : "",
    ...(options.versions === undefined ? {} : { versions: options.versions }),
    ...(options.runtime === "web" && options.mcp ? { mcp: true } : {}),
    ...(options.relayUrl ? { relayUrl: options.relayUrl } : {}),
});

const socketUrl = (options: ApplicationOptions, path = "/server") =>
    options.runtime === "node"
        ? (options.serverUrl ?? `${options.tls ? "wss" : "ws"}://localhost:${options.port}${path}`)
        : undefined;

export const runApplication = async (options: ApplicationOptions, development = false) => {
    if (
        development &&
        (options.runtime !== "node" ||
            !options.client ||
            !options.server ||
            !options.mcp ||
            options.mcpTransport === "stdio")
    )
        throw new Error("Development requires run node --all with HTTP MCP");
    const serverPath = development && options.product === "reader" ? "/client" : "/server";
    const frontend = clientOptions(options);
    const client = options.client
        ? staticClientHandler(
              await clientAssets(socketUrl(options, serverPath), frontend),
              frontend.basePath,
          )
        : undefined;
    let mcp: ReturnType<typeof createMcpHandler> | undefined;
    let startStdio: (() => Promise<void>) | undefined;
    let done: Promise<void> | undefined;
    const stdioAbort = new AbortController();
    let plugins: Awaited<ReturnType<typeof attachWorkspaceServer>>["plugins"] | undefined;
    const listener: RequestListener = (req, res) => {
        const path = (req.url ?? "/").split("?")[0];
        if (options.runtime === "node") {
            // Plugin actions use workspace operations so reader permissions apply.
            if (plugins && path?.startsWith("/api/plugins/")) {
                void plugins(req, res);
                return;
            }
            if (path === "/mcp" && mcp) return mcp(req, res);
            if (path === "/" && client) {
                res.writeHead(302, { Location: `${frontend.basePath}/` });
                res.end();
                return;
            }
        }
        if (client) return client(req, res);
        res.writeHead(404);
        res.end("Not found");
    };
    const server = options.tls
        ? createSecureServer(
              { cert: readFileSync(options.tls.cert), key: readFileSync(options.tls.key) },
              listener,
          )
        : createServer(listener);
    server.requestTimeout = 30_000;
    let dispose = () => {};
    let disposeVersions = () => {};
    let disposeWorkspace = () => {};
    let closing: Promise<void> | undefined;
    const close = () =>
        (closing ??= (async () => {
            stdioAbort.abort();
            await done?.catch(() => {});
            dispose();
            disposeVersions();
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            });
            process.removeListener("exit", disposeWorkspace);
            disposeWorkspace();
        })());
    try {
        if (options.runtime === "node" && (options.server || options.mcp)) {
            let project = options.project;
            if (options.repo !== undefined) {
                // Inherited Git selectors must never redirect a remote workspace into the caller's repository.
                for (const key of Object.keys(process.env))
                    if (
                        /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(
                            key,
                        )
                    )
                        delete process.env[key];
                const { prepareGitWorkspace } = await import("./git-workspace.js");
                const workspace = await prepareGitWorkspace(
                    options.repo,
                    options.product === "editor" ? "edit" : "view",
                    { path: project },
                );
                project = workspace.manifest;
                disposeWorkspace = workspace.dispose;
                process.once("exit", disposeWorkspace);
                if (options.product === "editor")
                    terminal.info(
                        `${workspace.reused ? "Reusing" : "Saved"} workspace: ${workspace.root}`,
                    );
            } else if (/^file:/i.test(project)) {
                const url = new URL(project);
                if (url.username || url.password || url.search || url.hash)
                    throw new Error(
                        "Local file URLs must not contain credentials, query or fragment",
                    );
                project = fileURLToPath(url);
            } else if (
                !isAbsolute(project) &&
                !existsSync(resolve(project)) &&
                /^(?:[a-z][a-z\d+.-]*:|[^/\s]+@[^/\s]+:)/i.test(project)
            ) {
                throw new Error("Pass Git repository URLs with --repo <git-url>");
            }
            process.env.DOOC_REMOTE_WORKSPACE = options.repo === undefined ? "0" : "1";
            const input = existsSync(join(project, MANIFEST_FILE))
                ? join(project, MANIFEST_FILE)
                : project;
            const root = projectRoot(input);
            if (options.server) {
                const workspaceServer = await attachWorkspaceServer(
                    server,
                    join(root, manifestFile(root)),
                    options.origin,
                    options.pluginModule,
                    options.product === "reader",
                    serverPath,
                    options.shared,
                    options.versions,
                    development,
                );
                dispose = workspaceServer;
                plugins = workspaceServer.plugins;
            }
            if (options.mcp) {
                const { gitOrigin } = await loadReaderPlugins(options.pluginModule);
                const catalog = createDocumentVersions(root);
                disposeVersions = catalog.close;
                const selection = parseVersionSelection(options.versions ?? "latest");
                const mcpRoot =
                    options.product === "reader" && !development
                        ? async () => {
                              const all = await catalog.list();
                              const latest = selectVersions(all, selection)[0];
                              if (latest) return catalog.open(latest.revision);
                              if (!all.length && catalog.enabled())
                                  throw new Error(
                                      "No published document versions. Commit Git sources or build a source snapshot first.",
                                  );
                              if (all.length || (options.versions ?? "latest") !== "latest")
                                  throw new Error(
                                      "No document versions match the publication selection",
                                  );
                              return root;
                          }
                        : root;
                const mcpOptions = { readOnly: options.product === "reader", gitOrigin };
                if (options.mcpTransport === "stdio")
                    startStdio = () => startMcp(mcpRoot, mcpOptions, stdioAbort.signal);
                else mcp = createMcpHandler(mcpRoot, mcpOptions);
            }
        }
        if (!options.server || options.runtime === "web")
            server.on("upgrade", (_req, socket) => socket.destroy());
        if (client || options.server || mcp) {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(options.port, "127.0.0.1", resolve);
            });
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : options.port;
            const origin = `${options.tls ? "https" : "http"}://localhost:${port}`;
            const endpoints: Record<string, string> = {};
            if (client)
                endpoints[
                    development ? "Client" : options.product === "editor" ? "Editor" : "Reader"
                ] = `${origin}${frontend.basePath}/`;
            if (mcp) endpoints.MCP = `${origin}/mcp`;
            else if (startStdio) endpoints.MCP = "stdio";
            if (options.server && options.runtime === "node" && serverPath === "/server")
                endpoints[development ? "Server" : "Workspace"] =
                    `${options.tls ? "wss" : "ws"}://localhost:${port}${serverPath}`;
            terminal.ready(options.product, endpoints);
        }
        if (startStdio) {
            if (!client && !options.server) terminal.ready(options.product, { MCP: "stdio" });
            done = startStdio();
        }
        return { server, close, done };
    } catch (error) {
        await close();
        throw error;
    }
};

export const buildApplication = async (options: ApplicationOptions): Promise<void> => {
    if (existsSync(options.out) && readdirSync(options.out).length)
        throw new Error("Choose an empty output directory; existing files were kept");
    const clientFiles = await clientAssets(socketUrl(options), clientOptions(options));
    const assets =
        options.runtime === "node"
            ? new Map([...clientFiles].map(([path, bytes]) => [`client/${path}`, bytes]))
            : clientFiles;
    if (options.runtime === "node" && (options.server || options.mcp)) {
        const args = [
            "run",
            "node",
            ...(["client", "server", "mcp"] as const)
                .filter((name) => options[name])
                .map((name) => `--${name}`),
        ];
        if (options.mcpTransport) args.push("--mcp-transport", options.mcpTransport);
        if (options.project !== MANIFEST_FILE) args.push("--project", resolve(options.project));
        if (options.versions !== undefined) args.push("--versions", options.versions);
        if (options.serverUrl) args.push("--server-url", options.serverUrl);
        if (options.origin !== "http://localhost:3000")
            args.push("--client-origin", options.origin);
        if (options.pluginModule)
            args.push(
                "--reader-plugins",
                isAbsolute(options.pluginModule) || options.pluginModule.startsWith(".")
                    ? resolve(options.pluginModule)
                    : options.pluginModule,
            );
        assets.set(
            "start.mjs",
            Buffer.from(
                `import { applicationCommand } from "@dooc-dev/dooc/runtime";\ntry {\n    await applicationCommand(${JSON.stringify(options.product)}, [...${JSON.stringify(args)}, ...process.argv.slice(2)]);\n} catch (error) {\n    console.error(error instanceof Error ? error.message : String(error));\n    process.exitCode = 1;\n}\n`,
            ),
        );
        assets.set(
            "package.json",
            Buffer.from(
                `${JSON.stringify(
                    {
                        name: `dooc-${options.product}-${options.runtime}`,
                        private: true,
                        type: "module",
                        engines: { node: ">=22" },
                        scripts: { start: "node start.mjs" },
                        dependencies: { "@dooc-dev/dooc": packageVersion },
                    },
                    null,
                    2,
                )}\n`,
            ),
        );
    }
    mkdirSync(dirname(options.out), { recursive: true });
    const staging = mkdtempSync(join(dirname(options.out), `.${basename(options.out)}-`));
    try {
        for (const [file, bytes] of assets) {
            const target = join(staging, file);
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, bytes);
        }
        // An empty destination may be replaced; a concurrent writer must never lose its files.
        if (existsSync(options.out)) rmdirSync(options.out);
        renameSync(staging, options.out);
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
};

export const applicationCommand = async (
    product: "editor" | "reader",
    args: string[],
): Promise<void> => {
    const options = parseApplicationOptions(product, args);
    if (!options) {
        console.log(applicationUsage(product));
        return;
    }
    if (options.action === "build") {
        await buildApplication(options);
        console.log(options.out);
    } else {
        const running = await runApplication(options);
        const stop = () => {
            void running.close();
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        if (running.done) {
            try {
                await running.done;
            } finally {
                process.removeListener("SIGINT", stop);
                process.removeListener("SIGTERM", stop);
                await running.close();
            }
        }
    }
};
