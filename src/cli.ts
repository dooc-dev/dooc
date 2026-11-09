#!/usr/bin/env node
// CLI entry shared by npx and mise. Root defaults to cwd; relative paths resolve against cwd.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { prebuilt } from "./viewer/assets.js";

process.env.NODE_ENV = prebuilt ? "production" : "development";

const USAGE = `usage: dooc <command>

  edit [root] [port]                 open dooc in edit mode
  view [root] [port]                 open dooc in view mode
    --viewer-plugins <module>        inject an external viewer plugin module
  build html [root] [out-dir]        build bundle.html (default <root>/dist)
  build zip [root] [out-dir]         build bundle.zip (default <root>/dist)
    --url_preview embed|network     URL handling for either format (default: embed)
  check [root] [options]            JSON consistency report (check --help for options)
  plugin pack <built-dir> [zip]     package bundled JS and assets as a plugin ZIP
  plugin add <zip> [root] [port]    install a local plugin and print login links
  plugin login <id> [root] [port]   open a local login flow for an installed plugin
  font add <file> [root]            register a font in the project (.dooc/fonts/)
  font list [root]                  list registered project fonts
  font remove <name> [root]         remove a registered project font
  mcp [root]                        stdio MCP server (all read / write operations)
    --git-origin <module>            inject gitOrigin from an external viewer plugin module
  help, --help, -h                  show this help`;

const fail = (message: string): never => {
    console.error(message);
    process.exit(1);
};

const docsRoot = (arg: string | undefined): string => {
    const root = resolve(arg ?? ".");
    return existsSync(root) ? root : fail(`${root} does not exist`);
};

const writeOut = (out: string, data: string | Buffer): void => {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, data);
};

const [command, ...args] = process.argv.slice(2);
switch (command) {
    case "plugin": {
        try {
            const { positionals, values } = parseArgs({
                args,
                allowPositionals: true,
                options: { help: { type: "boolean", short: "h" } },
            });
            const [action, value, rootArg, portArg] = positionals;
            if (values.help) {
                console.log(`usage: dooc plugin pack <built-dir> [output.zip]
       dooc plugin add <zip> [root] [port]
       dooc plugin login <plugin-id> [root] [port]

ZIP root: package.json with name, version, type: module and main pointing to bundled .js/.mjs.
Optional icon: path to a bundled SVG asset up to 64 KiB.
Include relative assets (SVG, JSON, etc.); dependencies must already be bundled. Limit: 16 MiB / 256 files.
Default output: <built-dir>.zip. Installed ZIPs: <root>/.dooc/plugins/.
Personal logins and plugin approvals: ~/.dooc/plugins/ (override with DOOC_USER_DIR).
Add/login starts a local editor and prints browser login links. Keep it running while signing in.
Tokens stay on this computer and never enter exported documents.`);
                break;
            }
            if (action === "pack" && value && positionals.length <= 3) {
                const { packExtension } = await import("./viewer/extension-pack.js");
                const { extensionFile } = await import("./core/extension-package.js");
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
                    "./core/extension-package.js"
                );
                const port = Number(portArg ?? 5179);
                if (!Number.isInteger(port) || port < 1024 || port > 65535)
                    throw new Error("Choose a local port between 1024 and 65535");
                process.env.DOCS_ROOT = docsRoot(rootArg);
                process.env.DOCS_HMR = "1";
                const { startServer } = await import("./viewer/serve.js");
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
                    "usage: dooc plugin pack <built-dir> [zip] | add <zip> [root] [port] | login <id> [root] [port]",
                );
        } catch (error) {
            fail(error instanceof Error ? error.message : String(error));
        }
        break;
    }
    case "font": {
        const { addProjectFont, listProjectFonts, removeProjectFont } = await import(
            "./compiler/fonts.js"
        );
        try {
            const { positionals, values } = parseArgs({
                args,
                allowPositionals: true,
                options: { help: { type: "boolean", short: "h" } },
            });
            if (values.help) {
                console.log(
                    "usage: dooc font add <file> [root] | list [root] | remove <name> [root]\n\nFonts are copied to <root>/.dooc/fonts/ and included in ZIP and HTML bundles.\nSupported formats: TTF, OTF, WOFF, WOFF2. Existing names are never overwritten.\nReload the viewer after changing registered fonts. Default root: current directory.",
                );
                break;
            }
            const [action, value, rootArg] = positionals;
            if (action === "list" && positionals.length <= 2) {
                console.log(JSON.stringify(listProjectFonts(docsRoot(value)), null, 2));
            } else if (action === "add" && value && positionals.length <= 3) {
                console.log(addProjectFont(docsRoot(rootArg), resolve(value)));
            } else if (action === "remove" && value && positionals.length <= 3) {
                removeProjectFont(docsRoot(rootArg), value);
                console.log(`Removed font: ${value}`);
            } else
                throw new Error(
                    "usage: dooc font add <file> [root] | list [root] | remove <name> [root]",
                );
        } catch (error) {
            fail(error instanceof Error ? error.message : String(error));
        }
        break;
    }
    case "check": {
        const { checkSite } = await import("./compiler/check.js");
        let report: import("./compiler/check.js").CheckReport;
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
                console.log(`usage: dooc check [root] [options]

  --only render,languages,themes  select checks (default: all three)
                                 manifest validity is always checked
  --allow-shared-svg        allow identical SVG bytes across themes (missing variants still fail)
  --warnings-as-errors      fail on warnings as well as errors
  --help, -h                show this help

dooc.yaml example:
  defaultLang: jpn
  languages: [jpn, eng]
  themes: [light, dark]

Translations: locales/<ISO 639-3>/<source path>.
Theme variants: themes/<theme>/<asset path>.
stdout: one JSON CheckReport with schemaVersion=1, checks, diagnostics, summary and exitCode.
render uses the viewer compiler; languages checks availability and prose; themes checks variants.
Site declarations determine the expected languages and themes, never CLI overrides.
Diagnostic codes, relative file paths, sourceFile, language, theme and one-based lines are
machine-readable; message text is for humans. Prose detection is heuristic and offline.
Short text, unsupported formats and remote content are reported as unchecked/inconclusive.
Exit codes: 0 passed; 1 errors (or warnings with --warnings-as-errors); 2 invocation/execution failure.
Node API: import { checkSite } from "@dooc-dev/dooc/check".`);
                break;
            }
            if (positionals.length > 1) throw new Error("check accepts at most one root path");
            report = checkSite(resolve(positionals[0] ?? "."), {
                ...(values.only
                    ? {
                          only: values.only.flatMap((value) =>
                              value.split(","),
                          ) as import("./compiler/check.js").CheckKind[],
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
    case "view":
    case "edit": {
        const { positionals, values } = parseArgs({
            args,
            allowPositionals: true,
            options: { "viewer-plugins": { type: "string" } },
        });
        process.env.DOCS_ROOT = docsRoot(positionals[0]);
        process.env.DOCS_HMR = "1";
        // serve.ts reads DOCS_ROOT at import time, so import it after the env is set.
        const { startServer } = await import("./viewer/serve.js");
        await startServer(
            command === "view" ? "preview" : "edit",
            Number(positionals[1] ?? 5179),
            values["viewer-plugins"] ?? process.env.DOOC_VIEWER_PLUGINS,
        );
        break;
    }
    case "build": {
        try {
            const { positionals, values } = parseArgs({
                args,
                allowPositionals: true,
                options: {
                    url_preview: { type: "string", default: "embed" },
                    help: { type: "boolean", short: "h" },
                },
            });
            if (values.help) {
                console.log(`usage: dooc build html [root] [out-dir] [--url_preview embed|network]
       dooc build zip  [root] [out-dir] [--url_preview embed|network]

A bundle is dooc.yaml and its managed content. Builds only the selected format.
Default output directory: <root>/dist. Source files are never rewritten.
  --url_preview embed    snapshot URL content and assets into the selected artifact (default)
  --url_preview network  preserve URL references without downloading them at build time

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
            if (format !== "html" && format !== "zip")
                throw new Error("build format must be html | zip");
            if (positionals.length > 3)
                throw new Error(`build ${format} accepts a root and an output directory`);
            const urlPreview = values.url_preview;
            if (urlPreview !== "embed" && urlPreview !== "network")
                throw new Error("--url_preview must be embed | network");
            const root = docsRoot(rootArg);
            const out = join(resolve(outArg ?? join(root, "dist")), `bundle.${format}`);
            const { buildBundle } = await import("./viewer/build.js");
            const bundle = await buildBundle(root, { format, urlPreview });
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
                console.log(
                    "usage: dooc mcp [root] [--git-origin <module>]\n\nExposes docs, files, Statics, fonts, check, build and Git over stdio.\nBuild accepts format=html|zip and url_preview=embed|network (default embed).\nThe external module's default export must contain gitOrigin (the same provider used by edit/view).\nOnly gitOrigin is used; viewer setup and data plugins are not started. Authentication stays in the provider.",
                );
                break;
            }
            if (positionals.length > 1) throw new Error("mcp accepts at most one root path");
            const { startMcp } = await import("./mcp.js");
            const { loadViewerPlugins } = await import("./viewer/plugin-config.js");
            const { gitOrigin } = await loadViewerPlugins(values["git-origin"]);
            if (values["git-origin"] && !gitOrigin)
                throw new Error("Module must provide gitOrigin");
            await startMcp(docsRoot(positionals[0]), { gitOrigin });
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
