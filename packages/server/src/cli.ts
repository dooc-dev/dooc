#!/usr/bin/env node
// CLI entry shared by npx and mise. The manifest defaults to ./dooc.yaml; project paths use its parent directory.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { setDownloadProgressListener } from "../../engine/src/compiler/download-progress.js";
import { projectRoot } from "../../engine/src/compiler/manifest.js";
import {
    isManifestFile,
    MANIFEST_FILE,
    serializeManifest,
} from "../../engine/src/core/content-metadata.js";
import { prebuilt } from "./assets.js";
import { writeBuildOutput } from "./build-output.js";
import { terminal } from "./terminal.js";

process.env.NODE_ENV = prebuilt ? "production" : "development";

const USAGE = `usage: dooc <command>

commands:
  editor [options]                    alias for editor run node --all (default: ./dooc.yaml)
  reader [options]                    alias for reader run node --all (default: ./dooc.yaml)
  editor <build|run> <node|web>         build or run selected editor components
  reader <build|run> <node|web>         build or run selected read-only reader components
     --client --server --mcp           select components (explicit build/run: all off by default)
     --all --no-client --no-server --no-mcp  select all, with explicit exclusions
     --mcp-transport stdio|http        Node MCP transport (default: http)
     --port <port>                     shared run port (default: 3000); node: /client/, /server, /mcp
     --project <path> --out <dir>       workspace path / empty build output directory
     --relay-url <https-origin>        optional hosted relay for web --mcp; omit for Desktop
     --repo <git-url>                   resolve --project inside a Git clone (run node)
     --tls-cert <pem> --tls-key <pem>  serve HTTPS (run node)
     --shared <branch>                 record shared editor snapshots on a branch (run node --server)
  init [path]                          create a manifest in a directory or at a manifest path
  build                                build the selected bundle (default <project>/dist)
     html [dooc.yaml] [out-dir]        build bundle.html
        --mode static|live             HTML snapshot or runtime plugin API
        --auth external                host supplies live HTML authentication and transport
        --source-url <url>             source directory URL for card copy links
        --download easy|normal|block    HTML download behavior (default: normal)
     zip [dooc.yaml] [out-dir]         build bundle.zip
     github [dooc.yaml] [out-dir]      build bundle.github.zip (Markdown and SVG/assets)
     --target github                  select GitHub output for html or zip
     --resources copy|reference        copy assets or link existing files (GitHub HTML only)
     --url_preview embed|network       URL handling (default: embed; ZIP requires embed)
     --reader-plugins <module>         inject an external build plugin module
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
     docs                             download GitHub docs and open the local reader
  relay                                browser MCP relay (relay --help for options)
     --stdio                          connect a Desktop MCP host to a browser workspace
  help, --help, -h                     show this help

Details: dooc <command> --help (editor, reader, init, build, export, check, plugin, font, self, relay).
Default manifest: ./dooc.yaml. Named manifests (<name>.dooc.yaml) are also accepted.
Paths use the current directory, or the repository root when --repo is given.
Example: dooc reader run node --client --server --project dooc-docs --repo https://github.com/dooc-dev/dooc.git
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
if (["editor", "reader", "self", "build"].includes(command ?? ""))
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
Documentation requires a network connection. Keep this command running while using the reader.

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
Existing files are never overwritten. Run dooc editor run node --client --server --project <manifest-path> to add your first document.

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
  Reload the reader after changing registered fonts. Default manifest: ./dooc.yaml.`);
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
                    "github-output": { type: "string" },
                    help: { type: "boolean", short: "h" },
                },
            });
            if (values.help) {
                console.log(`usage: dooc check [dooc.yaml] [options]

options:
  --only render,languages,themes,github  select checks (github requires --github-output)
                                 manifest validity is always checked
  --allow-shared-svg              allow identical SVG bytes across themes (missing variants still fail)
  --warnings-as-errors            fail on warnings as well as errors
  --github-output <zip|html>       also verify a GitHub build against its sources (path relative to manifest)
  --help, -h                      show this help

dooc.yaml example:
  system:
    default_lang: jpn
    languages: [jpn, eng]
    themes: [light, dark]
  center_contents: []

Checks:
  render     uses the reader compiler
  languages  checks availability and prose; translations: locales/<ISO 639-3>/<source path>
  themes     checks variants: themes/<theme>/<asset path>
  github     checks the build manifest, generated files and source fingerprints offline
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
                githubOutput: values["github-output"],
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
                    url_preview: { type: "string" },
                    target: { type: "string" },
                    resources: { type: "string" },
                    "reference-base": { type: "string" },
                    mode: { type: "string" },
                    auth: { type: "string" },
                    "reader-plugins": { type: "string" },
                    "source-url": { type: "string" },
                    download: { type: "string" },
                    help: { type: "boolean", short: "h" },
                },
            });
            if (values.help) {
                console.log(`usage: dooc build <html|zip|github> [dooc.yaml] [out-dir] [options]

commands:
  html [dooc.yaml] [out-dir]   build bundle.html
     --mode static|live        HTML snapshot or runtime plugin API
     --auth external           host supplies live HTML authentication and transport
     --source-url <url>        HTTP(S) directory URL for card copy links
                               paths are relative to dooc.yaml; overrides GitHub origin/HEAD
     --download easy|normal|block
                               easy: add resource download buttons; normal: browser defaults
                               block: suppress in-page downloads (not browser policy)
                               default: normal
  zip [dooc.yaml] [out-dir]    build bundle.zip
  github [dooc.yaml] [out-dir] alias for zip --target github

options:
  --target github              GitHub-compatible HTML body or Markdown ZIP
  --resources copy|reference   GitHub HTML: copy files (default) or reference existing sources
  --reference-base <path>      path from the HTML output directory to the manifest directory
                              reference mode only; default: relative path from out-dir
  --url_preview embed|network  URL handling (default: embed; ZIP: embed; live HTML: network)
    embed                     snapshot URL content and assets into the selected artifact
    network                   preserve URL references without downloading them at build time
  --reader-plugins <module>    inject trusted build plugins
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
  ZIP always includes local files and captured URL content, with rewritten references.
  GitHub: export static pages and SVG images; network previews become links, without reader JS.
  Only embedded references such as ![](url) are downloaded; ordinary hyperlinks remain links.
  Snapshots use public HTTPS without credentials or redirects. Static HTML captures the server's
  HTML and declarative assets; it does not execute the source site's JavaScript or perform login.
  Remote files are limited to 2 MiB each and 64 MiB / 256 assets total.
  A failed download or invalid source stops the build before replacing the selected artifact.
  Use HTML --url_preview network or dooc export to preserve remote references without downloads.`);
                break;
            }
            const [format, rootArg, outArg] = positionals;
            if (format !== "html" && format !== "zip" && format !== "github")
                throw new Error("build format must be html | zip | github");
            if (positionals.length > 3)
                throw new Error(`build ${format} accepts a dooc.yaml path and an output directory`);
            const urlPreview = values.url_preview ?? (values.mode === "live" ? "network" : "embed");
            if (urlPreview !== "embed" && urlPreview !== "network")
                throw new Error("--url_preview must be embed | network");
            const root = projectRoot(rootArg);
            const github = format === "github" || values.target === "github";
            const directory = resolve(outArg ?? join(root, "dist"));
            const out = join(
                directory,
                `bundle.${github ? "github." : ""}${format === "github" ? "zip" : format}`,
            );
            const { buildBundle } = await import("./build.js");
            const bundle = await buildBundle(root, {
                format,
                target: values.target as "github" | undefined,
                resources: values.resources as "copy" | "reference" | undefined,
                referenceBase:
                    values["reference-base"] ??
                    (values.resources === "reference"
                        ? relative(directory, root).replaceAll("\\", "/") || "."
                        : undefined),
                urlPreview,
                mode: values.mode as "static" | "live" | undefined,
                auth: values.auth as "external" | undefined,
                pluginModule: values["reader-plugins"],
                sourceUrl: values["source-url"],
                download: values.download as "easy" | "normal" | "block" | undefined,
            });
            writeBuildOutput(out, bundle);
            bundle.commitVersion?.();
            for (const warning of bundle.warnings ?? []) console.warn(`Warning: ${warning}`);
            console.log(
                `${out} — ${bundle.docs} docs${bundle.version ? `, version ${bundle.version}` : ""} (url_preview=${urlPreview})`,
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
