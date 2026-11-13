#!/usr/bin/env node
// CLI entry shared by npx and mise. The manifest defaults to ./dooc.yaml; project paths use its parent directory.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setDownloadProgressListener } from "../../engine/src/compiler/download-progress.js";
import { projectRoot } from "../../engine/src/compiler/manifest.js";
import {
    isManifestFile,
    MANIFEST_FILE,
    serializeManifest,
} from "../../engine/src/core/content-metadata.js";
import { prebuilt } from "./assets.js";
import { terminal } from "./terminal.js";

process.env.NODE_ENV = prebuilt ? "production" : "development";

const USAGE = `usage: dooc <command>

commands:
  init [path]                          create a manifest in a directory or at a manifest path
  edit [path] [port]                   edit a local workspace or a path in a Git repository
     --repo <git-url>                   resolve the path inside a cloned repository
     --viewer-plugins <module>         inject an external viewer plugin module
     --shared <branch>                 several people edit; snapshots are recorded on <branch>
     --tls-cert <pem> --tls-key <pem>  serve over HTTPS (or DOOC_TLS_CERT / DOOC_TLS_KEY)
  server [dooc.yaml] [port]            serve the workspace socket only (default: 5179)
     --client-origin <origin>           permit the static client origin (default: http://localhost:5180)
  client [port]                        serve the static client only (default: 5180)
     --server <ws-url>                  connect to an optional workspace server
  view [path] [port]                   view a local workspace or a path in a Git repository
     --repo <git-url>                   resolve the path inside a cloned repository
     --viewer-plugins <module>         inject an external viewer plugin module
     --tls-cert <pem> --tls-key <pem>  serve over HTTPS (or DOOC_TLS_CERT / DOOC_TLS_KEY)
  build                                build the selected bundle (default <project>/dist)
     html [dooc.yaml] [out-dir]        build bundle.html
        --mode static|live             HTML snapshot or runtime plugin API
        --auth external                host supplies live HTML authentication and transport
        --source-url <url>             source directory URL for card copy links
        --easy-download                enable resource downloads in HTML
     client [out-dir]                  build the standalone static editor
        --server <ws-url>               preconfigure an optional workspace socket
     zip [dooc.yaml] [out-dir]         build bundle.zip
     --url_preview embed|network       URL handling for either format (default: embed)
     --viewer-plugins <module>         inject an external build plugin module
  export [dooc.yaml] [out-dir]         collect source dependencies into bundle.zip
  check [dooc.yaml] [options]          JSON consistency report (check --help for options)
  plugin                               manage local plugins
     pack <built-dir> [zip]            package bundled JS and assets as a plugin ZIP
     add <zip> [dooc.yaml] [port]      install a local plugin and print login links
     login <id> [dooc.yaml] [port]     open a local login flow for an installed plugin
  font                                 manage project fonts (.dooc/fonts/)
     add <file> [dooc.yaml]            register a font in the project
     list [dooc.yaml]                  list registered project fonts
     remove <name> [dooc.yaml]         remove a registered project font
  self                                 manage this dooc installation
     update                           update dooc to the latest release
     docs                             download GitHub docs and open the local viewer
  mcp [dooc.yaml]                      stdio MCP server (all read / write operations)
     --git-origin <module>             inject gitOrigin from an external viewer plugin module
  help, --help, -h                     show this help

Details: dooc <command> --help (init, edit, view, server, client, build, export, check, plugin, font, self, mcp).
Default manifest: ./dooc.yaml. Named manifests (<name>.dooc.yaml) are also accepted.
Paths use the current directory, or the repository root when --repo is given.
Example: dooc view dooc-docs --repo https://github.com/dooc-dev/dooc.git
Paths and .dooc/ are relative to the selected manifest's directory.`;

const fail = (message: string): never => {
    terminal.close();
    console.error(message);
    process.exit(1);
};

const writeOut = (out: string, data: string | Buffer): void => {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, data);
};

const [command, ...args] = process.argv.slice(2);
if (["edit", "view", "self", "build", "server"].includes(command ?? ""))
    setDownloadProgressListener(terminal.download);
switch (command) {
    case "self": {
        try {
            const { positionals, values } = parseArgs({
                args,
                allowPositionals: true,
                options: { help: { type: "boolean", short: "h" } },
            });
            if (values.help) {
                console.log(`usage: dooc self <command>

commands:
  update  update a standalone executable or global npm installation to the latest release
  docs    download documentation from GitHub and open the local read-only viewer

Homebrew and mise installations must be updated through their package manager.
Documentation requires a network connection. Keep this command running while using the viewer.

options:
  --help, -h  show this help`);
                break;
            }
            if (positionals.length !== 1 || !["update", "docs"].includes(positionals[0] ?? ""))
                throw new Error("Expected: dooc self update or dooc self docs");
            const { prepareSelfDocs, selfUpdate } = await import("./self.js");
            if (positionals[0] === "update") {
                selfUpdate();
            } else {
                terminal.info("Downloading documentation from GitHub...");
                const { root, dispose } = await prepareSelfDocs();
                process.once("exit", dispose);
                process.once("SIGINT", () => process.exit(130));
                process.once("SIGTERM", () => process.exit(143));
                process.env.DOCS_ROOT = root;
                process.env.DOCS_HMR = "0";
                const { startServer } = await import("./serve.js");
                await startServer("preview", 5179, undefined, { open: true });
            }
        } catch (error) {
            fail(error instanceof Error ? error.message : String(error));
        }
        break;
    }
    case "init": {
        let file = resolve(MANIFEST_FILE);
        try {
            const { positionals, values } = parseArgs({
                args,
                allowPositionals: true,
                options: { help: { type: "boolean", short: "h" } },
            });
            if (values.help) {
                console.log(`usage: dooc init [path]

Create dooc.yaml in the selected directory (default: current directory), or specify
a dooc.yaml / <name>.dooc.yaml file path. Missing directories are created.
Existing files are never overwritten. Run dooc edit <manifest-path> to add your first document.

options:
  --help, -h  show this help`);
                break;
            }
            if (positionals.length > 1) throw new Error("init accepts at most one path");
            const target = resolve(positionals[0] ?? ".");
            file = isManifestFile(basename(target)) ? target : join(target, MANIFEST_FILE);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, serializeManifest([], { format: "nested" }), { flag: "wx" });
            console.log(
                `Created ${file}\nRun dooc edit '${file.replaceAll("'", "'\\''")}' to add your first document.`,
            );
        } catch (error) {
            fail(
                error instanceof Error && "code" in error && error.code === "EEXIST"
                    ? `${file} already exists; nothing was overwritten.`
                    : error instanceof Error
                      ? error.message
                      : String(error),
            );
        }
        break;
    }
    case "plugin": {
        try {
            const { positionals, values } = parseArgs({
                args,
                allowPositionals: true,
                options: { help: { type: "boolean", short: "h" } },
            });
            const [action, value, rootArg, portArg] = positionals;
            if (values.help) {
                console.log(`usage: dooc plugin <command>

commands:
  pack <built-dir> [output.zip]        package bundled JS and assets as a plugin ZIP
  add <zip> [dooc.yaml] [port]         install a local plugin and print login links
  login <plugin-id> [dooc.yaml] [port]  open a local login flow for an installed plugin

options:
  --help, -h  show this help

Package:
  ZIP root: package.json with name, version, type: module and main pointing to bundled .js/.mjs.
  Optional icon: path to a bundled SVG asset up to 64 KiB.
  Include relative assets (SVG, JSON, etc.); dependencies must already be bundled.
  Limit: 16 MiB / 256 files. Default output: <built-dir>.zip.

Storage and login:
  Installed ZIPs: <project>/.dooc/plugins/.
  Personal logins and plugin approvals: ~/.dooc/plugins/ (override with DOOC_USER_DIR).
  Add/login starts a local editor and prints browser login links. Keep it running while signing in.
  Tokens stay on this computer and never enter exported documents.`);
                break;
            }
            if (action === "pack" && value && positionals.length <= 3) {
                const { packExtension } = await import("./extension-pack.js");
                const { extensionFile } = await import(
                    "../../engine/src/core/extension-package.js"
                );
                const output = resolve(rootArg ?? `${resolve(value)}.zip`);
                extensionFile(basename(output));
                writeOut(output, await packExtension(resolve(value), output));
                console.log(output);
            } else if (
                (action === "add" || action === "login") &&
                value &&
                positionals.length <= 4
            ) {
                const { extensionFile, MAX_EXTENSION_BYTES } = await import(
                    "../../engine/src/core/extension-package.js"
                );
                const port = Number(portArg ?? 5179);
                if (!Number.isInteger(port) || port < 1024 || port > 65535)
                    throw new Error("Choose a local port between 1024 and 65535");
                process.env.DOCS_ROOT = projectRoot(rootArg);
                process.env.DOCS_HMR = "1";
                const { startServer } = await import("./serve.js");
                if (action === "add") {
                    const file = extensionFile(basename(value));
                    const data = readFileSync(resolve(value));
                    if (data.length > MAX_EXTENSION_BYTES)
                        throw new Error("Choose a ZIP smaller than 16 MiB");
                    await startServer("edit", port, undefined, {
                        file,
                        data: data.toString("base64"),
                    });
                } else {
                    if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw new Error("Invalid plugin ID");
                    await startServer("edit", port, undefined, { login: value });
                }
            } else
                throw new Error(
                    "usage: dooc plugin pack <built-dir> [zip] | add <zip> [dooc.yaml] [port] | login <id> [dooc.yaml] [port]",
                );
        } catch (error) {
            fail(error instanceof Error ? error.message : String(error));
        }
        break;
    }
    case "font": {
        const { addProjectFont, listProjectFonts, removeProjectFont } = await import(
            "../../engine/src/compiler/fonts.js"
        );
        try {
            const { positionals, values } = parseArgs({
                args,
                allowPositionals: true,
                options: { help: { type: "boolean", short: "h" } },
            });
            if (values.help) {
                console.log(`usage: dooc font <command>

commands:
  add <file> [dooc.yaml]       register a font in the project
  list [dooc.yaml]             list registered project fonts
  remove <name> [dooc.yaml]    remove a registered project font

options:
  --help, -h  show this help

Fonts:
  Fonts are copied to <project>/.dooc/fonts/ and included in ZIP and HTML bundles.
  Supported formats: TTF, OTF, WOFF, WOFF2. Existing names are never overwritten.
  Reload the viewer after changing registered fonts. Default manifest: ./dooc.yaml.`);
                break;
            }
            const [action, value, rootArg] = positionals;
            if (action === "list" && positionals.length <= 2) {
                console.log(JSON.stringify(listProjectFonts(projectRoot(value)), null, 2));
            } else if (action === "add" && value && positionals.length <= 3) {
                console.log(addProjectFont(projectRoot(rootArg), resolve(value)));
            } else if (action === "remove" && value && positionals.length <= 3) {
                removeProjectFont(projectRoot(rootArg), value);
                console.log(`Removed font: ${value}`);
            } else
                throw new Error(
                    "usage: dooc font add <file> [dooc.yaml] | list [dooc.yaml] | remove <name> [dooc.yaml]",
                );
        } catch (error) {
            fail(error instanceof Error ? error.message : String(error));
        }
        break;
    }
    case "check": {
        const { checkSite } = await import("../../engine/src/compiler/check.js");
        let report: import("../../engine/src/compiler/check.js").CheckReport;
        try {
            const { positionals, values } = parseArgs({
                args,
                allowPositionals: true,
                options: {
                    only: { type: "string", multiple: true },
                    "allow-shared-svg": { type: "boolean" },
                    "warnings-as-errors": { type: "boolean" },
                    help: { type: "boolean", short: "h" },
                },
            });
            if (values.help) {
                console.log(`usage: dooc check [dooc.yaml] [options]

options:
  --only render,languages,themes  select checks (default: all three)
                                 manifest validity is always checked
  --allow-shared-svg              allow identical SVG bytes across themes (missing variants still fail)
  --warnings-as-errors            fail on warnings as well as errors
  --help, -h                      show this help

dooc.yaml example:
  system:
    default_lang: jpn
    languages: [jpn, eng]
    themes: [light, dark]
  center_contents: []

Checks:
  render     uses the viewer compiler
  languages  checks availability and prose; translations: locales/<ISO 639-3>/<source path>
  themes     checks variants: themes/<theme>/<asset path>
  Site declarations determine the expected languages and themes, never CLI overrides.

Report:
  stdout: one JSON CheckReport with schemaVersion=1, checks, diagnostics, summary and exitCode.
  Diagnostic codes, relative file paths, sourceFile, language, theme and one-based lines are
  machine-readable; message text is for humans. Prose detection is heuristic and offline.
  Short text, unsupported formats and remote content are reported as unchecked/inconclusive.
  Exit codes: 0 passed; 1 errors (or warnings with --warnings-as-errors); 2 invocation/execution failure.
  Node API: import { checkSite } from "@dooc-dev/dooc/check".`);
                break;
            }
            if (positionals.length > 1) throw new Error("check accepts at most one dooc.yaml path");
            report = checkSite(projectRoot(positionals[0]), {
                ...(values.only
                    ? {
                          only: values.only.flatMap((value) =>
                              value.split(","),
                          ) as import("../../engine/src/compiler/check.js").CheckKind[],
                      }
                    : {}),
                allowSharedSvg: values["allow-shared-svg"],
                warningsAsErrors: values["warnings-as-errors"],
            });
        } catch (error) {
            report = {
                schemaVersion: 1,
                root: resolve("."),
                checks: [],
                languages: [],
                themes: [],
                diagnostics: [
                    {
                        check: "config",
                        code: "INVOCATION_INVALID",
                        severity: "error",
                        file: ".",
                        message: error instanceof Error ? error.message : String(error),
                    },
                ],
                summary: { errors: 1, warnings: 0, info: 0 },
                exitCode: 2,
            };
        }
        console.log(JSON.stringify(report, null, 2));
        process.exitCode = report.exitCode;
        break;
    }
    case "server":
    case "client": {
        try {
            const { positionals, values } = parseArgs({
                args,
                allowPositionals: true,
                options: {
                    "client-origin": { type: "string" },
                    server: { type: "string" },
                    "viewer-plugins": { type: "string" },
                    help: { type: "boolean", short: "h" },
                },
            });
            if (values.help) {
                console.log(
                    command === "server"
                        ? "usage: dooc server [dooc.yaml] [port] [--client-origin http://localhost:5180] [--viewer-plugins module]\nServes /api/workspace over WebSocket on loopback. No frontend assets."
                        : "usage: dooc client [port] [--server ws://localhost:5179/api/workspace]\nServes static assets only. Open local storage or connect to an optional workspace server.",
                );
                break;
            }
            if (positionals.length > (command === "server" ? 2 : 1))
                throw new Error("Too many positional arguments");
            const port = Number(
                positionals[command === "server" ? 1 : 0] ?? (command === "server" ? 5179 : 5180),
            );
            if (!Number.isInteger(port) || port < 1024 || port > 65535)
                throw new Error("Choose a port between 1024 and 65535");
            if (command === "server") {
                const { startWorkspaceServer } = await import("./workspace-server.js");
                await startWorkspaceServer(
                    positionals[0] ?? "dooc.yaml",
                    port,
                    values["client-origin"],
                    values["viewer-plugins"],
                );
            } else {
                const { startStaticClient } = await import("./static-client.js");
                await startStaticClient(port, values.server);
            }
        } catch (error) {
            fail(error instanceof Error ? error.message : String(error));
        }
        break;
    }
    case "view":
    case "edit": {
        try {
            const { positionals, values } = parseArgs({
                args,
                allowPositionals: true,
                options: {
                    "viewer-plugins": { type: "string" },
                    "tls-cert": { type: "string" },
                    "tls-key": { type: "string" },
                    shared: { type: "string" },
                    repo: { type: "string" },
                    help: { type: "boolean", short: "h" },
                },
            });
            if (values.help) {
                console.log(`usage: dooc ${command} [path] [port] [options]

path:
  ./dooc.yaml               manifest (default); folders are also accepted
  ./docs                    folder containing dooc.yaml
  docs/team.dooc.yaml       named manifest
  file:///home/me/docs      local folder or manifest URL (without --repo)

Paths use the current directory, or the cloned repository root with --repo.
The repository's default branch is opened. Use the clone URL supplied by your Git host.

Remote sources require Git. Cloning finishes before the server starts.
Edit clones retain Git history and local changes, and reopen without fetching or resetting.
View clones are temporary and removed on exit.

options:
  --repo <git-url>            clone an HTTPS/SSH Git repository and resolve path inside it
  --viewer-plugins <module>   load an explicit local viewer plugin module
  --tls-cert <pem>            HTTPS certificate (requires --tls-key)
  --tls-key <pem>             HTTPS key (requires --tls-cert)
  --shared <branch>           record shared-workspace snapshots on a branch
  --help, -h                 show this help

Example: dooc ${command} dooc-docs --repo https://github.com/dooc-dev/dooc.git`);
                break;
            }
            if (positionals.length > 2) throw new Error("Too many positional arguments");
            const port = Number(positionals[1] ?? 5179);
            if (!Number.isInteger(port) || port < 0 || port > 65535)
                throw new Error("Choose a port between 0 and 65535");
            const cert = values["tls-cert"] ?? process.env.DOOC_TLS_CERT;
            const key = values["tls-key"] ?? process.env.DOOC_TLS_KEY;
            if (!cert !== !key) throw new Error("--tls-cert and --tls-key must be given together");
            let source = positionals[0];
            const remote = values.repo !== undefined;
            if (values.repo !== undefined) {
                // A caller's Git context must never redirect operations outside the cloned repo.
                for (const key of Object.keys(process.env))
                    if (
                        /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(
                            key,
                        )
                    )
                        delete process.env[key];
                const { prepareGitWorkspace } = await import("./git-workspace.js");
                const workspace = await prepareGitWorkspace(values.repo, command, {
                    path: source,
                });
                process.once("exit", workspace.dispose);
                process.once("SIGINT", () => process.exit(130));
                process.once("SIGTERM", () => process.exit(143));
                source = workspace.manifest;
                if (command === "edit")
                    terminal.info(
                        `${workspace.reused ? "Reusing" : "Saved"} workspace: ${workspace.root}`,
                    );
            } else if (source && /^file:/i.test(source)) {
                const url = new URL(source);
                if (url.username || url.password || url.search || url.hash)
                    throw new Error(
                        "Local file URLs must not contain credentials, query or fragment",
                    );
                source = fileURLToPath(url);
            } else if (
                source &&
                !isAbsolute(source) &&
                !existsSync(resolve(source)) &&
                /^(?:[a-z][a-z\d+.-]*:|[^/\s]+@[^/\s]+:)/i.test(source)
            ) {
                throw new Error("Pass Git repository URLs with --repo <git-url>");
            }
            if (source && existsSync(resolve(source)) && statSync(resolve(source)).isDirectory())
                source = join(source, MANIFEST_FILE);
            process.env.DOCS_ROOT = projectRoot(source);
            process.env.DOCS_HMR = remote && command === "view" ? "0" : "1";
            process.env.DOOC_REMOTE_WORKSPACE = remote ? "1" : "0";
            // serve.ts reads DOCS_ROOT at import time, so import it after the env is set.
            const { startServer } = await import("./serve.js");
            await startServer(
                command === "view" ? "preview" : "edit",
                port,
                values["viewer-plugins"] ?? process.env.DOOC_VIEWER_PLUGINS,
                ...(remote || (cert && key) || values.shared !== undefined
                    ? [
                          {
                              ...(remote ? { open: true } : {}),
                              ...(cert && key
                                  ? { tls: { cert: resolve(cert), key: resolve(key) } }
                                  : {}),
                              ...(values.shared === undefined ? {} : { shared: values.shared }),
                          },
                      ]
                    : []),
            );
        } catch (error) {
            fail(error instanceof Error ? error.message : String(error));
        }
        break;
    }
    case "export": {
        try {
            const { positionals, values } = parseArgs({
                args,
                allowPositionals: true,
                options: { help: { type: "boolean", short: "h" } },
            });
            if (values.help) {
                console.log(`usage: dooc export [dooc.yaml] [out-dir]

Collect the workspace's source dependencies into bundle.zip.
Default manifest: ./dooc.yaml; named manifests are also accepted.
Default output directory: <project>/dist.
Configuration and plugins are not executed. Remote URLs stay unchanged; nothing is downloaded.

options:
  --help, -h  show this help`);
                break;
            }
            if (positionals.length > 2)
                throw new Error("export accepts a dooc.yaml path and an output directory");
            const root = projectRoot(positionals[0]);
            const out = join(resolve(positionals[1] ?? join(root, "dist")), "bundle.zip");
            const { exportBundle } = await import("../../engine/src/compiler/export.js");
            writeOut(out, exportBundle(root));
            console.log(out);
        } catch (error) {
            fail(error instanceof Error ? error.message : String(error));
        }
        break;
    }
    case "build": {
        try {
            const { positionals, values } = parseArgs({
                args,
                allowPositionals: true,
                options: {
                    server: { type: "string" },
                    url_preview: { type: "string" },
                    mode: { type: "string" },
                    auth: { type: "string" },
                    "viewer-plugins": { type: "string" },
                    "source-url": { type: "string" },
                    "easy-download": { type: "boolean" },
                    help: { type: "boolean", short: "h" },
                },
            });
            if (values.help) {
                console.log(`usage: dooc build <html|zip|client> [dooc.yaml] [out-dir] [options]

commands:
  html [dooc.yaml] [out-dir]   build bundle.html
     --mode static|live        HTML snapshot or runtime plugin API
     --auth external           host supplies live HTML authentication and transport
     --source-url <url>        HTTP(S) directory URL for card copy links
                               paths are relative to dooc.yaml; overrides GitHub origin/HEAD
     --easy-download           enable resource downloads (default: off)
  client [out-dir]            build a standalone static editor (default: ./dooc-client)
     --server <ws-url>         optional workspace socket
  zip [dooc.yaml] [out-dir]    build bundle.zip

options (html and zip):
  --url_preview embed|network  URL handling (default: embed; live HTML: network)
    embed                     snapshot URL content and assets into the selected artifact
    network                   preserve URL references without downloading them at build time
  --viewer-plugins <module>    inject trusted build plugins
  --help, -h                  show this help

Output:
  A bundle is dooc.yaml and its managed content. Builds only the selected format.
  Default output directory: <project>/dist. Source files are never rewritten.
  Use dooc export for source dependencies without plugin execution or remote downloads.

HTML modes:
  static  resolve enabled local plugins using build-time credentials and embed their views
          installed, enabled packages are discovered automatically
  live    expose window.dooc.setPluginTransport(request), without a login UI or credentials
  Examples:
    dooc build html --mode static
    dooc build html --mode live --auth external

URL handling:
  HTML embed: no network when opened. HTML network: fetch URLs when opened (text requires CORS).
  ZIP embed: save URL content and rewrite references. ZIP network: keep the original URLs.
  Only embedded references such as ![](url) are downloaded; ordinary hyperlinks remain links.
  Snapshots use public HTTPS without credentials or redirects. Static HTML captures the server's
  HTML and declarative assets; it does not execute the source site's JavaScript or perform login.
  Remote files are limited to 2 MiB each and 64 MiB / 256 assets total.
  A failed download or invalid source stops the build before replacing the selected artifact.
  Use --url_preview network with either format to build without downloading URL content.`);
                break;
            }
            const [format, rootArg, outArg] = positionals;
            if (format === "client") {
                if (positionals.length > 2)
                    throw new Error("build client accepts one output directory");
                const { buildStaticClient } = await import("./static-client.js");
                const out = resolve(rootArg ?? "dooc-client");
                await buildStaticClient(out, values.server);
                console.log(`${out} — static client (serve index.html for document routes)`);
                break;
            }
            if (format !== "html" && format !== "zip")
                throw new Error("build format must be html | zip | client");
            if (positionals.length > 3)
                throw new Error(`build ${format} accepts a dooc.yaml path and an output directory`);
            const urlPreview = values.url_preview ?? (values.mode === "live" ? "network" : "embed");
            if (urlPreview !== "embed" && urlPreview !== "network")
                throw new Error("--url_preview must be embed | network");
            const root = projectRoot(rootArg);
            const out = join(resolve(outArg ?? join(root, "dist")), `bundle.${format}`);
            const { buildBundle } = await import("./build.js");
            const bundle = await buildBundle(root, {
                format,
                urlPreview,
                mode: values.mode as "static" | "live" | undefined,
                auth: values.auth as "external" | undefined,
                pluginModule: values["viewer-plugins"],
                sourceUrl: values["source-url"],
                easyDownload: values["easy-download"],
            });
            writeOut(out, bundle.data);
            console.log(`${out} — ${bundle.docs} docs (url_preview=${urlPreview})`);
        } catch (error) {
            fail(error instanceof Error ? error.message : String(error));
        }
        break;
    }
    case "mcp": {
        try {
            const { positionals, values } = parseArgs({
                args,
                allowPositionals: true,
                options: {
                    "git-origin": { type: "string" },
                    help: { type: "boolean", short: "h" },
                },
            });
            if (values.help) {
                console.log(`usage: dooc mcp [dooc.yaml] [options]

options:
  --git-origin <module>  inject gitOrigin from an external viewer plugin module
  --help, -h            show this help

Server:
  Exposes docs, files, Library, fonts, check, build and Git over stdio.
  Build accepts format=html|zip and url_preview=embed|network (default embed).

Git origin:
  The external module's default export must contain gitOrigin (the same provider used by edit/view).
  Only gitOrigin is used; viewer setup and data plugins are not started.
  Authentication stays in the provider.`);
                break;
            }
            if (positionals.length > 1) throw new Error("mcp accepts at most one dooc.yaml path");
            const { startMcp } = await import("./mcp.js");
            const { loadViewerPlugins } = await import("./plugin-config.js");
            const { gitOrigin } = await loadViewerPlugins(values["git-origin"]);
            if (values["git-origin"] && !gitOrigin)
                throw new Error("Module must provide gitOrigin");
            await startMcp(projectRoot(positionals[0]), { gitOrigin });
        } catch (error) {
            fail(error instanceof Error ? error.message : String(error));
        }
        break;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
        console.log(USAGE);
        break;
    default:
        fail(`unknown command: ${command}\n\n${USAGE}`);
}
