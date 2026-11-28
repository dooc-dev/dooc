#!/usr/bin/env node
// CLI entry shared by npx and mise. The manifest defaults to ./dooc.yaml; project paths use its parent directory.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { setDownloadProgressListener } from "../../engine/src/compiler/download-progress.js";
import { projectRoot } from "../../engine/src/compiler/manifest.js";
import {
    isManifestFile,
    MANIFEST_FILE,
    serializeManifest,
} from "../../engine/src/core/content-metadata.js";
import type { ExtensionSummary } from "../../engine/src/core/extension-package.js";
import { prebuilt } from "./assets.js";
import { outputFile, writeBuildOutput } from "./build-output.js";
import { terminal } from "./terminal.js";

process.env.NODE_ENV = prebuilt ? "production" : "development";

const USAGE = `usage: dooc <command> [options]

commands:
  editor [options]                    alias for editor run node --all
  reader [options]                    alias for reader run node --all (read-only)
  editor <build|run> <node|web>         build or run editor application components
  reader <build|run> <node|web>         build or run read-only application components
     --client --server --mcp           select components; explicit build/run defaults to none
     --all --no-client --no-server --no-mcp  select all, then apply exclusions
     --mcp-transport stdio|http        Node MCP transport (default: http)
     --project <path>                 workspace folder or manifest (default: ./dooc.yaml)
     --port <port>                    run port (default: 3000)
     --out <dir>                      application build: require an empty directory
     --server-url <ws-url>            client connection to a separate Node workspace
     --client-origin <origin>         allowed Node browser origin
     --relay-url <https-origin>       hosted relay for web MCP; omit for Desktop
     --reader-plugins <module>        Node workspace plugin module
     --repo <git-url>                 resolve --project inside a Git clone (run node)
     --versions <selection>           reader publication selection (default: latest)
     --tls-cert <pem> --tls-key <pem>  serve HTTPS (run node)
     --shared <branch>                editor snapshots (run node --server without --mcp)
  init [path]                          create a manifest in a directory or at a manifest path
  build [dooc.yaml] [out-dir]          build the reading page: <project>/build/index.html
     --mode static|live               HTML snapshot or runtime plugin API
     --auth external                  host supplies live HTML authentication and transport
     --source-url <url>               source directory URL for card copy links
     --download easy|normal|block     HTML download behavior (default: normal)
     --url_preview network|embed      keep URL references (default) or capture their content
     --reader-plugins <module>        inject an external build plugin module
  zip [dooc.yaml] [out-dir]            archive the workspace: <project>/dist/bundle.zip
     --url_preview network|embed      keep URL references (default) or capture their content
     --reader-plugins <module>        inject an external build plugin module (embed only)
  check [dooc.yaml] [options]          JSON consistency report (check --help for options)
  plugin                               manage local plugins
     pack <built-dir> [zip]            package bundled JS and assets as a plugin ZIP
     add <zip> [dooc.yaml] [port]      install a local plugin and print login links
     login <id> [dooc.yaml] [port]     open a local login flow for an installed plugin
     remove <zip> [dooc.yaml]          remove an installed plugin ZIP
  font                                 manage project fonts (.dooc/fonts/)
     add <file> [dooc.yaml]            register a font in the project
     list [dooc.yaml]                  list registered project fonts
     remove <name> [dooc.yaml]         remove a registered project font
  self                                 manage this dooc installation
     update                           update dooc to the latest release
     docs                             download GitHub docs and open the local reader
  relay                                browser MCP relay (relay --help for options)
     --stdio                          connect a Desktop MCP host to a browser workspace
  help, --help, -h                     show this help`;

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
if (["editor", "reader", "self", "build", "zip"].includes(command ?? ""))
    setDownloadProgressListener(terminal.download);
switch (command) {
    case "editor":
    case "reader": {
        try {
            const { applicationCommand } = await import("./application.js");
            await applicationCommand(command, args);
        } catch (error) {
            fail(error instanceof Error ? error.message : String(error));
        }
        break;
    }
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
  docs    download documentation from GitHub and open the local read-only reader

Homebrew and mise installations must be updated through their package manager.
Documentation requires a network connection. The local reader uses port 5179.
GitHub's dooc-docs/ is extracted into the OS temporary directory and removed on exit.
Keep this command running while using the reader.

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
Creates a root document with an automatic table of contents. Existing files are never overwritten.
Run dooc editor --project <manifest-path> to add your first document.

options:
  --help, -h  show this help`);
                break;
            }
            if (positionals.length > 1) throw new Error("init accepts at most one path");
            const target = resolve(positionals[0] ?? ".");
            file = isManifestFile(basename(target)) ? target : join(target, MANIFEST_FILE);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, serializeManifest([], { format: "document" }), { flag: "wx" });
            console.log(
                `Created ${file}\nRun dooc editor run node --client --server --project '${file.replaceAll("'", "'\\''")}' to add your first document.`,
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
  remove <zip> [dooc.yaml]             remove an installed plugin ZIP and its approval

options:
  --help, -h  show this help

Package:
  ZIP root: package.json with name, version, type: module and main pointing to bundled .js/.mjs.
  Optional icon: path to a bundled SVG asset up to 64 KiB.
  Include relative assets (SVG, JSON, etc.); dependencies must already be bundled.
  Limit: 16 MiB / 256 files. Default output: <built-dir>.zip.

Storage and login:
  Default manifest: ./dooc.yaml; named manifests are accepted. Default login port: 5179.
  Installed ZIPs: <project>/.dooc/plugins/.
  Personal logins and plugin approvals: ~/.dooc/plugins/ (override with DOOC_USER_DIR).
  Add/login starts a local editor and prints browser login links. Keep it running while signing in.
  Remove takes the installed ZIP file name, without a directory, and does not execute plugins.
  Saved logins are kept; sign out in the Plugins tool to disconnect an account.
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
            } else if (action === "remove" && value && positionals.length <= 3) {
                const { extensionFile } = await import(
                    "../../engine/src/core/extension-package.js"
                );
                const file = extensionFile(value);
                const { createExtensionManager } = await import("./extensions.js");
                const { createPluginHandler } = await import("./plugins.js");
                const { createLocalPluginStorage } = await import("./plugins/local-storage.js");
                const manager = createExtensionManager(
                    projectRoot(rootArg),
                    createPluginHandler([]),
                    { plugins: [], mocks: {} },
                    createLocalPluginStorage(),
                );
                try {
                    const { items } = (await manager({ action: "list" })) as {
                        items: ExtensionSummary[];
                    };
                    const item = items.find((item) => item.file === file);
                    if (!item) throw new Error(`Plugin not found: ${file}`);
                    await manager({ action: "delete", file, hash: item.hash });
                    console.log(`Removed plugin: ${file}`);
                } finally {
                    manager.dispose();
                }
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
                    "usage: dooc plugin pack <built-dir> [zip] | add <zip> [dooc.yaml] [port] | login <id> [dooc.yaml] [port] | remove <zip> [dooc.yaml]",
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
  list [dooc.yaml]            list registered project fonts as JSON
  remove <name> [dooc.yaml]    remove a registered project font

options:
  --help, -h  show this help

Fonts:
  Fonts are copied to <project>/.dooc/fonts/ and included in ZIP and HTML bundles.
  Supported formats: TTF, OTF, WOFF, WOFF2. Existing names are never overwritten.
  Reload the reader after changing registered fonts. Default manifest: ./dooc.yaml.
  Named manifests (<name>.dooc.yaml) are accepted. Use a listed file name with remove.`);
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

Default manifest: ./dooc.yaml; <name>.dooc.yaml is also accepted.

options:
  --only <checks>                 comma-separated or repeated: render,languages,themes
                                 manifest validity is always checked
  --allow-shared-svg              allow identical SVG bytes across themes (missing variants still fail)
  --warnings-as-errors            fail on warnings as well as errors
  --help, -h                      show this help

dooc.yaml example:
  system:
    default_lang: jpn
    languages: [jpn, eng]
    themes: [light, dark]
  document: {}

Checks:
  Defaults: render, languages and themes.
  Git-hosted child manifests are resolved first and can require Git and network access.
  Embedded remote content is not fetched or verified by these checks.
  render     uses the reader compiler
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
            const root = projectRoot(positionals[0]);
            const { prepareDocumentSources } = await import("./remote-manifests.js");
            await prepareDocumentSources(root);
            report = checkSite(root, {
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
    case "export":
        fail("dooc export was removed. Use dooc zip, which collects the same source files.");
        break;
    case "build":
    case "zip": {
        const format = command === "zip" ? "zip" : "html";
        try {
            const { positionals, values } = parseArgs({
                args,
                allowPositionals: true,
                options: {
                    url_preview: { type: "string" },
                    mode: { type: "string" },
                    auth: { type: "string" },
                    "reader-plugins": { type: "string" },
                    "source-url": { type: "string" },
                    download: { type: "string" },
                    split: { type: "boolean" },
                    compress: { type: "boolean" },
                    "max-file-size": { type: "string" },
                    "max-build-size": { type: "string" },
                    "warnings-as-errors": { type: "boolean" },
                    help: { type: "boolean", short: "h" },
                },
            });
            if (values.help) {
                console.log(
                    format === "html"
                        ? `usage: dooc build [dooc.yaml] [out-dir] [options]

Build the reading page as one HTML file: <project>/build/index.html.
A named manifest (<name>.dooc.yaml) builds <project>/build/<name>/index.html.
Serve the output folder as it is. Use dooc zip for an archive of the workspace.
The manifest defaults to ./dooc.yaml; explicit relative output paths use the current directory.

options:
  --mode static|live           HTML snapshot or runtime plugin API
  --auth external              host supplies live HTML authentication and transport
  --source-url <url>           HTTP(S) directory URL for card copy links
                               paths are relative to dooc.yaml; overrides GitHub origin/HEAD
  --download easy|normal|block
                               easy: add resource download buttons; normal: browser defaults
                               block: suppress in-page downloads (not browser policy)
                               default: normal
  --url_preview network|embed  URL handling (default: network; static HTML: embed)
    network                    preserve URL references without downloading them at build time
    embed                      snapshot URL content and assets into the HTML
  --reader-plugins <module>    inject trusted build plugins
  --split                     separate pages, JS, CSS and resources; serve over HTTP(S)
  --compress                  optimize image/video previews using FFmpeg; implies --split
                               PNG: lossless WebP; JPEG/WebP/video: lossy; sources stay intact
  --max-file-size <size>       per-output-file byte limit, e.g. 25MiB; implies --split
  --max-build-size <size>      total unique output bytes, e.g. 100MiB; implies --split
                               no limits by default; includes HTML, JS, CSS and resources
  --warnings-as-errors        stop if a requested compressor is unsupported or unavailable
  --help, -h                   show this help

Output:
  Assets go in dooc-assets/ before the HTML entry point is replaced.
  Older assets and unrelated files are preserved; use a fresh output folder for deployment.
  Source files are never rewritten.

HTML modes:
  static  resolve enabled local plugins using build-time credentials and embed their views
          installed, enabled packages are discovered automatically
  live    expose window.dooc.setPluginTransport(request), without a login UI or credentials
  Examples:
    dooc build --mode static
    dooc build --mode live --auth external

URL handling:
  network: fetch URLs when opened (text requires CORS). embed: captured previews work offline.
  Git-hosted child manifests are resolved in both modes and can require Git and network access.
  Only embedded references such as ![](url) are downloaded; ordinary hyperlinks remain links.
  Snapshots use public HTTPS without credentials or redirects. Static HTML captures the server's
  HTML and declarative assets; it does not execute the source site's JavaScript or perform login.
  Remote files are limited to 2 MiB each and 64 MiB / 256 assets total.
  A failed download or invalid source stops the build before replacing the artifact.`
                        : `usage: dooc zip [dooc.yaml] [out-dir] [options]

Archive the workspace: <project>/dist/bundle.zip.
A named manifest (<name>.dooc.yaml) writes <project>/dist/<name>/bundle.zip.
The manifest defaults to ./dooc.yaml; explicit relative output paths use the current directory.

options:
  --url_preview network|embed  URL handling (default: network)
    network                    collect dooc.yaml and its source files as authored
                               configuration and plugins are not executed; embeds are not captured
    embed                      also capture embedded URL content and rewrite its references
  --reader-plugins <module>    inject trusted build plugins (embed only)
  --help, -h                   show this help

Output:
  Source files are never rewritten. The archive is kept apart from dooc build's HTML folder,
  so serving that folder does not publish it.

URL handling:
  Git-hosted child manifests are resolved in both modes and can require Git and network access.
  Their source files are included under dooc-imports/ while authored manifest URLs are retained.
  Only embedded references such as ![](url) are downloaded; ordinary hyperlinks remain links.
  Snapshots use public HTTPS without credentials or redirects.
  Remote files are limited to 2 MiB each and 64 MiB / 256 assets total.
  A failed download or invalid source stops the build before replacing the artifact.`,
                );
                break;
            }
            const [rootArg, outArg] = positionals;
            // The format used to be a subcommand; a manifest path can never have these names.
            if (rootArg === "html" || rootArg === "zip" || rootArg === "github")
                throw new Error(
                    rootArg === "html"
                        ? "dooc build no longer takes a format: use dooc build [dooc.yaml] [out-dir]"
                        : rootArg === "zip"
                          ? "dooc build zip was replaced by dooc zip"
                          : "GitHub output was removed: use dooc build or dooc zip",
                );
            if (positionals.length > 2)
                throw new Error(`${command} accepts a dooc.yaml path and an output directory`);
            // Remote content is left alone unless the artifact cannot work without a snapshot.
            const urlPreview =
                values.url_preview ?? (values.mode === "static" ? "embed" : "network");
            if (urlPreview !== "embed" && urlPreview !== "network")
                throw new Error("--url_preview must be network | embed");
            const root = projectRoot(rootArg);
            const out = outputFile(root, format, outArg && resolve(outArg));
            if (format === "zip" && urlPreview === "network") {
                if (
                    Object.entries(values).some(
                        ([name, value]) => name !== "url_preview" && value !== undefined,
                    )
                )
                    throw new Error("These options need dooc zip --url_preview embed");
                const { exportBundle } = await import("../../engine/src/compiler/export.js");
                const { prepareDocumentSources } = await import("./remote-manifests.js");
                await prepareDocumentSources(root);
                writeOut(out, exportBundle(root));
                console.log(out);
                break;
            }
            const { buildBundle } = await import("./build.js");
            const bundle = await buildBundle(root, {
                format,
                urlPreview,
                mode: values.mode as "static" | "live" | undefined,
                auth: values.auth as "external" | undefined,
                pluginModule: values["reader-plugins"],
                sourceUrl: values["source-url"],
                download: values.download as "easy" | "normal" | "block" | undefined,
                split: values.split,
                compress: values.compress,
                maxFileSize: values["max-file-size"],
                maxBuildSize: values["max-build-size"],
                warningsAsErrors: values["warnings-as-errors"],
            });
            writeBuildOutput(out, bundle);
            bundle.commitVersion?.();
            for (const warning of bundle.warnings ?? []) console.warn(`Warning: ${warning}`);
            console.log(
                `${out} — ${bundle.docs} docs${bundle.version ? `, version ${bundle.version}` : ""}${bundle.files ? `, ${bundle.files.size + 1} files, ${bundle.bytes} bytes` : ""} (url_preview=${urlPreview})`,
            );
        } catch (error) {
            fail(error instanceof Error ? error.message : String(error));
        }
        break;
    }
    case "relay": {
        try {
            const { relayCommand } = await import("./mcp-relay.js");
            await relayCommand(args);
        } catch (error) {
            fail(error instanceof Error ? error.message : String(error));
        }
        break;
    }
    case "mcp":
        fail(
            "dooc mcp has moved: use dooc editor run node --mcp --mcp-transport stdio (or reader for read-only access). Browser relays use dooc relay.",
        );
        break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
        console.log(USAGE);
        break;
    default:
        fail(`unknown command: ${command}\n\n${USAGE}`);
}
