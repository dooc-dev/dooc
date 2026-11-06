#!/usr/bin/env node
// CLI entry shared by npx and mise. Root defaults to cwd; relative paths resolve against cwd.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Compiled, compileSite } from "./compiler/compile.js";
import { exportEntries } from "./compiler/export.js";
import { zip } from "./compiler/zip.js";
import { prebuilt } from "./viewer/assets.js";

process.env.NODE_ENV = prebuilt ? "production" : "development";

const USAGE = `usage: dooc <command>

  edit [root] [port]                 open dooc in edit mode
  view [root] [port]                 open dooc in view mode
  export zip  [root] [out]           zip of the content (default <root>/dist/<root name>.zip)
  export html [root] [out]           single HTML file with everything embedded (default <root>/dist/index.html)
  mcp [root]                        stdio MCP server (all read / write operations)
  help, --help, -h                  show this help`;

const fail = (message: string): never => {
    console.error(message);
    process.exit(1);
};

const docsRoot = (arg: string | undefined): string => {
    const root = resolve(arg ?? ".");
    return existsSync(root) ? root : fail(`${root} does not exist`);
};

// HTML isn't written if there are validation errors.
const compileOrFail = (root: string): Compiled => {
    const compiled = compileSite(root);
    if (compiled.errors.length > 0) {
        for (const e of compiled.errors) {
            console.error(`error: ${e}`);
        }
        fail(`\ncontent validation failed (${compiled.errors.length} error)`);
    }
    return compiled;
};

const writeOut = (out: string, data: string | Buffer): void => {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, data);
};

const [command, ...args] = process.argv.slice(2);
switch (command) {
    case "view":
    case "edit": {
        process.env.DOCS_ROOT = docsRoot(args[0]);
        process.env.DOCS_HMR = "1";
        // serve.ts reads DOCS_ROOT at import time, so import it after the env is set.
        const { startServer } = await import("./viewer/serve.js");
        await startServer(command === "view" ? "preview" : "edit", Number(args[1] ?? 5179));
        break;
    }
    case "export": {
        const { positionals } = parseArgs({
            args,
            allowPositionals: true,
        });
        const [format, rootArg, outArg] = positionals;
        if (format !== "zip" && format !== "html") {
            fail(`export format must be zip | html\n\n${USAGE}`);
        }
        const root = docsRoot(rootArg);
        const out = (fallback: string): string => resolve(outArg ?? join(root, "dist", fallback));
        // docs.config.mjs supplies optional language adapters.
        const { loadSiteLanguages } = await import("./viewer/languages.js");
        const site = await loadSiteLanguages(root);
        if (format === "zip") {
            const entries = exportEntries(root);
            if (entries.length === 0) {
                fail(`${root}: no content/ figures/ found`);
            }
            writeOut(out(`${basename(root)}.zip`), zip(entries));
            console.log(`${out(`${basename(root)}.zip`)} — ${entries.length} files`);
        } else {
            const compiled = compileOrFail(root);
            const { bundleClient, publishHtml, siteFrom } = await import("./viewer/serve.js");
            const html = publishHtml(
                {
                    ...siteFrom(compiled, site.languages),
                    codeLanguages: site.codeLanguages,
                    codeGrammars: site.codeGrammars,
                },
                await bundleClient("core/schema-graph-global.tsx", true),
                undefined,
                await bundleClient("viewer/code-highlight.ts", true),
            );
            writeOut(out("index.html"), html);
            console.log(`${out("index.html")} — ${compiled.docs.length} docs`);
        }
        break;
    }
    case "mcp": {
        const { startMcp } = await import("./mcp.js");
        await startMcp(docsRoot(args[0]));
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
