#!/usr/bin/env node
// CLI entry (shared by npx / mise). dev (with hot reload) is for mise run dev and isn't shown in
// usage. root defaults to cwd; relative paths are resolved against cwd.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
    type Compiled,
    type CompileOptions,
    compileSite,
    writeArtifact,
} from "./compiler/compile.js";
import { exportEntries } from "./compiler/export.js";
import { figureName } from "./compiler/figures.js";
import { createDocOps, isOpError, type OpResult } from "./compiler/ops.js";
import { zip } from "./compiler/zip.js";

const USAGE = `usage: document-system <command>

  preview [root] [port]              read-only viewer with document hot reload
  edit [root] [port]                 editor
  export json [root] [out] [--lang <iso6393>]  docs.json bundle (default <root>/dist/artifact/)
  export zip  [root] [out]           zip of the content (default <root>/dist/<root name>.zip)
  export html [root] [out] [--lang <iso6393>]  self-contained html, all assets embedded (default <root>/dist/index.html)
  code-language add <language|grammar.json> [--root <dir>]  register syntax highlighting
  json-schema ls                    list bundled docs.json schema versions
  json-schema <latest|version>       print a docs.json JSON Schema to stdout
  mcp [root]                         stdio MCP server (all read / write operations)

  doc ls
  doc add    <id> [--title <t>] [--parent <id>]
  doc move   <id> [--parent <id>] [--index <n>]   (no parent = top level, no index = last)
  doc rename <id> <newId>                         (doc: links are updated too)
  doc delete <id> [--force]
  figure ls
  figure add    <file> [--name <name>]
  figure delete <name> [--force]
    doc / figure: --root <dir> sets the docs root (default cwd)`;

const fail = (message: string): never => {
    console.error(message);
    process.exit(1);
};

const docsRoot = (arg: string | undefined): string => {
    const root = resolve(arg ?? ".");
    return existsSync(root) ? root : fail(`${root} does not exist`);
};

// json / html aren't written if there are validation errors.
const compileOrFail = (root: string, options: CompileOptions): Compiled => {
    const compiled = compileSite(root, options);
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

// Prints an operation's result (exit 1 on failure).
const report = <T extends object>(r: OpResult<T>, ok: (v: T) => string): void => {
    if (isOpError(r)) {
        fail(
            `error: ${r.error}${r.referencedBy ? `\n  referenced by: ${r.referencedBy.join(", ")}` : ""}`,
        );
    } else {
        console.log(ok(r));
    }
};

const [command, ...args] = process.argv.slice(2);
switch (command) {
    case "json-schema": {
        const [version, extra] = args;
        if (!version || extra) fail("usage: document-system json-schema <ls|latest|version>");
        const { getDocsJsonSchema, listDocsJsonSchemas } = await import(
            "./core/docs-json-schema.js"
        );
        try {
            console.log(
                version === "ls"
                    ? listDocsJsonSchemas().join("\n")
                    : JSON.stringify(getDocsJsonSchema(version), null, 2),
            );
        } catch (error) {
            fail(error instanceof Error ? error.message : String(error));
        }
        break;
    }
    case "dev":
    case "preview":
    case "edit": {
        process.env.DOCS_ROOT = docsRoot(args[0]);
        process.env.DOCS_HMR = command === "edit" ? "0" : "1";
        // serve.ts reads DOCS_ROOT at import time, so import it after the env is set.
        const { startServer } = await import("./viewer/serve.js");
        await startServer(command === "preview" ? "preview" : "edit", Number(args[1] ?? 5179));
        break;
    }
    case "export": {
        const { values, positionals } = parseArgs({
            args,
            allowPositionals: true,
            options: { lang: { type: "string" } },
        });
        const [format, rootArg, outArg] = positionals;
        const root = docsRoot(rootArg);
        const out = (fallback: string): string => resolve(outArg ?? join(root, "dist", fallback));
        // docs.config.mjs: default language + extra language adapters.
        const { loadSiteLanguages } = await import("./viewer/languages.js");
        const site = await loadSiteLanguages(root);
        if (format === "json") {
            const compiled = compileOrFail(root, {
                defaultLang: site.defaultLang,
                locale: values.lang,
            });
            writeArtifact(compiled, out("artifact"));
            console.log(
                `${out("artifact")} — ${compiled.artifact.docs.length} docs, figures ${compiled.figures.length}`,
            );
        } else if (format === "zip") {
            const entries = exportEntries(root);
            if (entries.length === 0) {
                fail(`${root}: no content/ figures/ found`);
            }
            writeOut(out(`${basename(root)}.zip`), zip(entries));
            console.log(`${out(`${basename(root)}.zip`)} — ${entries.length} files`);
        } else if (format === "html") {
            const compiled = compileOrFail(root, {
                defaultLang: site.defaultLang,
                locale: values.lang,
            });
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
            console.log(`${out("index.html")} — ${compiled.artifact.docs.length} docs`);
        } else {
            fail(`export format must be json | zip | html\n\n${USAGE}`);
        }
        break;
    }
    case "code-language": {
        const { values, positionals } = parseArgs({
            args,
            allowPositionals: true,
            options: { root: { type: "string" } },
        });
        const [action, rawInput, extra] = positionals;
        const input =
            rawInput || fail("code-language add requires a language name or grammar JSON file");
        if (action !== "add" || extra)
            fail(`usage: document-system code-language add <language|grammar.json> [--root <dir>]`);
        const { addCodeLanguage } = await import("./compiler/code-languages.js");
        try {
            console.log(`added ${await addCodeLanguage(docsRoot(values.root), input)}`);
        } catch (error) {
            fail(error instanceof Error ? error.message : String(error));
        }
        break;
    }
    case "mcp": {
        const { startMcp } = await import("./mcp.js");
        await startMcp(docsRoot(args[0]));
        break;
    }
    case "doc":
    case "figure": {
        const { values, positionals } = parseArgs({
            args,
            allowPositionals: true,
            options: {
                root: { type: "string" },
                title: { type: "string" },
                parent: { type: "string" },
                index: { type: "string" },
                name: { type: "string" },
                force: { type: "boolean" },
            },
        });
        const root = docsRoot(values.root);
        const ops = createDocOps(root);
        const [sub, a, b] = positionals;
        const need = (v: string | undefined, what: string): string =>
            v ?? fail(`${what} is required\n\n${USAGE}`);
        const op = `${command} ${sub}`;
        if (op === "doc ls" || op === "figure ls") {
            const { createTools } = await import("./mcp.js");
            const listed = createTools(root).list_docs?.run({}) as {
                docs: { id: string; title: string; depth: number }[];
                figures: { name: string; file: string }[];
            };
            for (const line of command === "doc"
                ? listed.docs.map((d) => `${"  ".repeat(d.depth)}${d.id}  ${d.title}`)
                : listed.figures.map((f) => `${f.name}  ${f.file}`)) {
                console.log(line);
            }
        } else if (op === "doc add") {
            const id = need(a, "id");
            report(
                ops.add(id, values.title ?? id, values.parent),
                (r) => `added content/${r.id}.md`,
            );
        } else if (op === "doc move") {
            const index = values.index == null ? undefined : Number(values.index);
            report(ops.move(need(a, "id"), values.parent, index), (r) => `moved ${r.id}`);
        } else if (op === "doc rename") {
            report(
                ops.rename(need(a, "id"), need(b, "newId")),
                (r) => `renamed → ${r.id} (doc: links updated in ${r.updatedRefs} file(s))`,
            );
        } else if (op === "doc delete") {
            report(ops.remove(need(a, "id"), values.force), (r) =>
                r.danglingRefs > 0
                    ? `deleted (unresolved doc: links in ${r.danglingRefs} file(s))`
                    : "deleted",
            );
        } else if (op === "figure add") {
            const src = resolve(need(a, "file"));
            if (!existsSync(src)) {
                fail(`${src} does not exist`);
            }
            const file = basename(src);
            const name =
                values.name == null ? file : `${values.name}${file.slice(figureName(file).length)}`;
            report(ops.addFigure(name, readFileSync(src)), (r) => `added figures/${r.file}`);
        } else if (op === "figure delete") {
            report(
                ops.removeFigure(need(a, "name"), values.force),
                (r) => `deleted figures/${r.file}`,
            );
        } else {
            fail(`unknown command: ${op}\n\n${USAGE}`);
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
