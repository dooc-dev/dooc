// stdio MCP server that reads and writes the docs root (`dooc mcp [root]`). MCP is
// newline-delimited JSON-RPC 2.0 and we only use initialize / tools/list / tools/call, so we
// speak it directly without the SDK. stdout is for the protocol only; logs go to stderr.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { checkSite } from "./compiler/check.js";
import { CHECK_KINDS, type CheckKind } from "./compiler/check-types.js";
import { type CompileOptions, createCompiler } from "./compiler/compile.js";
import { exportBundle } from "./compiler/export.js";
import { filesSnapshot, updateFiles, uploadFile } from "./compiler/files.js";
import { addProjectFont, listProjectFonts, removeProjectFont } from "./compiler/fonts.js";
import { createDocOps, isOpError } from "./compiler/ops.js";
import { validateSubformatFile } from "./compiler/subformats.js";
import { readTextfile, textfilePath, writeTextfile } from "./compiler/textfile.js";
import { MANIFEST_FILE } from "./core/content-metadata.js";
import { localFile } from "./core/files.js";
import { docDisplayName } from "./core/taxonomy.js";
import { buildBundle } from "./viewer/build.js";
import { createGitHandler, validateGitOrigin } from "./viewer/git.js";
import type { GitOrigin } from "./viewer/git-types.js";
import { resourceIndex } from "./viewer/resource-library.js";

type Args = Record<string, unknown>;

interface Property {
    type: string | string[];
    description?: string;
    enum?: readonly string[];
    items?: Property;
    minimum?: number;
}

interface Tool {
    description: string;
    props: Record<string, Property>;
    required?: string[];
    run: (a: Args) => unknown;
}

const str = { type: "string" } as const;
const num = { type: "integer", minimum: 0 } as const;
const bool = { type: "boolean" } as const;
const strings = { type: "array", items: str } as const;

export interface McpOptions extends CompileOptions {
    gitOrigin?: GitOrigin;
}

export const createTools = (root: string, options: McpOptions = {}): Record<string, Tool> => {
    const compiler = createCompiler(root, options);
    const ops = createDocOps(root);
    const origin = options.gitOrigin && validateGitOrigin(options.gitOrigin);
    const git = createGitHandler(root, () => origin);
    const fileArg = (value: unknown): string => {
        if (!localFile(value)) throw new Error("Expected a local bundle file path");
        if (
            !localFile(
                relative(realpathSync(root), textfilePath(root, value)).split("\\").join("/"),
            )
        )
            throw new Error("Expected a local bundle file path");
        return value;
    };
    const optStr = (v: unknown): string | undefined =>
        typeof v === "string" && v !== "" ? v : undefined;
    const docErrors = (id: string): string[] => {
        const compiled = compiler.compile();
        const file = compiled.docs.find((doc) => doc.id === id)?.file;
        return file ? (compiled.sources.get(file)?.errors ?? []) : [];
    };

    return {
        export: {
            description:
                "Collect dooc.yaml and its source dependencies into dist/bundle.zip, without executing plugins or fetching remote data.",
            props: {},
            required: [],
            run: () => {
                const file = "dist/bundle.zip";
                const data = exportBundle(root);
                const path = textfilePath(root, file);
                mkdirSync(dirname(path), { recursive: true });
                const temp = join(dirname(path), `.export-${randomUUID()}.tmp`);
                try {
                    writeFileSync(temp, data, { flag: "wx" });
                    renameSync(temp, path);
                } finally {
                    rmSync(temp, { force: true });
                }
                return { file, path, bytes: data.length };
            },
        },
        build: {
            description:
                "Build dist/bundle.html or dist/bundle.zip. url_preview=embed snapshots embedded URL content; network preserves URL references. Defaults to embed. Returns the output path, byte count and document count.",
            props: {
                format: { ...str, enum: ["html", "zip"] },
                url_preview: { ...str, enum: ["embed", "network"] },
                mode: { ...str, enum: ["static", "live"] },
                auth: { ...str, enum: ["external"] },
                source_url: {
                    ...str,
                    description:
                        "Public source directory URL for card copy links in HTML, relative to dooc.yaml.",
                },
            },
            required: ["format"],
            run: async (a) => {
                const file = `dist/bundle.${a.format}`;
                textfilePath(root, file);
                const bundle = await buildBundle(root, {
                    format: a.format as "html" | "zip",
                    urlPreview: (a.url_preview ?? (a.mode === "live" ? "network" : "embed")) as
                        | "embed"
                        | "network",
                    mode: a.mode as "static" | "live" | undefined,
                    auth: a.auth as "external" | undefined,
                    sourceUrl: a.source_url as string | undefined,
                });
                const path = textfilePath(root, file);
                mkdirSync(dirname(path), { recursive: true });
                const temp = join(dirname(path), `.bundle-${randomUUID()}.tmp`);
                try {
                    writeFileSync(temp, bundle.data, { flag: "wx" });
                    renameSync(temp, path);
                } finally {
                    rmSync(temp, { force: true });
                }
                return {
                    file,
                    path,
                    bytes: Buffer.byteLength(bundle.data),
                    docs: bundle.docs,
                    url_preview: a.url_preview ?? (a.mode === "live" ? "network" : "embed"),
                };
            },
        },
        list_files: {
            description:
                "List bundle files, sizes, layout and document mappings. Save revision for update_files.",
            props: {},
            run: () => filesSnapshot(root),
        },
        read_file: {
            description:
                "Read a local UTF-8 bundle file, including dooc.yaml, translations and theme variants. Save content as the base for write_file.",
            props: { file: str },
            required: ["file"],
            run: (a) => ({ file: fileArg(a.file), content: readTextfile(root, fileArg(a.file)) }),
        },
        write_file: {
            description:
                "Create or update a local UTF-8 bundle file. base must equal the content from read_file, or null to create a new file. Conflicting edits are never overwritten.",
            props: { file: str, content: str, base: { type: ["string", "null"] } },
            required: ["file", "content", "base"],
            run: (a) => {
                validateSubformatFile(root, fileArg(a.file), a.content as string);
                return writeTextfile(
                    root,
                    fileArg(a.file),
                    a.content as string,
                    a.base as string | null,
                )
                    ? { file: a.file, ok: true }
                    : { error: "File changed. Read it again before writing.", status: 409 };
            },
        },
        upload_file: {
            description:
                "Import a binary or text file from base64 data using the bundle file layout. Existing files are preserved with a unique name. Maximum 64 MiB.",
            props: { name: str, data: { ...str, description: "Canonical base64 file bytes" } },
            required: ["name", "data"],
            run: (a) => uploadFile(root, a),
        },
        update_files: {
            description:
                "Rename a file (file, name), move files/folders (paths, directory), change automatic layout (enabled), or restructure by extension. Updates document references and variants. Requires revision from list_files.",
            props: {
                action: { ...str, enum: ["rename", "move", "layout", "restructure"] },
                revision: str,
                file: str,
                name: str,
                paths: strings,
                directory: str,
                enabled: bool,
            },
            required: ["action", "revision"],
            run: (a) => updateFiles(root, a),
        },
        list_resources: {
            description:
                "List Statics: codeblocks (including term definitions and local text-file embeds, with normalized format and reference locations), URLs from Markdown links, and URL previews from Markdown images, with source files and line numbers.",
            props: {},
            run: () =>
                resourceIndex(
                    root,
                    filesSnapshot(root).files.map((file) => file.path),
                ),
        },
        list_fonts: {
            description:
                "List registered project fonts. Editor and viewer font selection remains a browser display preference.",
            props: {},
            run: () => ({ fonts: listProjectFonts(root) }),
        },
        add_font: {
            description:
                "Copy a local TTF, OTF, WOFF or WOFF2 font into .dooc/fonts. Existing names are never overwritten.",
            props: { path: { ...str, description: "Local source font path" } },
            required: ["path"],
            run: (a) => ({ file: addProjectFont(root, a.path as string) }),
        },
        delete_font: {
            description: "Remove a registered project font by the name returned by list_fonts.",
            props: { name: str },
            required: ["name"],
            run: (a) => {
                removeProjectFont(root, a.name as string);
                return { ok: true };
            },
        },
        git: {
            description:
                "Git workflow in the repository containing this bundle. Read first; every other action except branches requires that state's version. diff/stage/unstage use path; commit uses message; branch creates and switches to branch; switch accepts stash=true to save dirty work in the single stash slot. Origin operations require an externally injected provider. createPr needs title/body/base/draft; updatePr needs number/title/body/revision; mergePr needs number/method/revision. PR revision must be JSON.stringify of the PR returned by read. Read again after each action.",
            props: {
                action: {
                    ...str,
                    enum: [
                        "read",
                        "branches",
                        "diff",
                        "stage",
                        "unstage",
                        "commit",
                        "branch",
                        "switch",
                        "stash",
                        "restoreStash",
                        "fetch",
                        "pull",
                        "push",
                        "createPr",
                        "updatePr",
                        "mergePr",
                    ],
                },
                version: str,
                path: str,
                message: str,
                branch: str,
                stash: bool,
                title: str,
                body: str,
                base: str,
                draft: bool,
                number: { ...num, minimum: 1 },
                revision: str,
                method: { ...str, enum: ["merge", "squash", "rebase"] },
            },
            required: ["action"],
            run: git,
        },
        list_docs: {
            description:
                "The doc tree (in manifest display order) and figures. Each doc has id / file / title / parent / depth.",
            props: {},
            run: () => {
                const { docs, figures } = compiler.compile();
                const depth = new Map<string, number>();
                return {
                    docs: docs.map((d) => {
                        const dep = d.parent == null ? 0 : (depth.get(d.parent) ?? 0) + 1;
                        depth.set(d.id, dep);
                        return {
                            id: d.id,
                            file: d.subformat ? MANIFEST_FILE : d.file,
                            ...(d.subformat ? { subformat: d.subformat.ext } : {}),
                            title: docDisplayName(d, d.id),
                            parent: d.parent,
                            depth: dep,
                        };
                    }),
                    figures: figures.map((f) => ({
                        name: f.name,
                        file: f.file,
                        title: f.title,
                    })),
                };
            },
        },
        search_docs: {
            description:
                "Find docs by case-insensitive substring match on id / title / body. Includes a snippet around each match.",
            props: { query: { ...str, description: "Search query" } },
            required: ["query"],
            run: (a) => {
                const q = String(a.query ?? "").toLowerCase();
                return compiler.compile().docs.flatMap((d) => {
                    const title = docDisplayName(d, d.id);
                    const i = d.body.toLowerCase().indexOf(q);
                    if (i === -1 && !`${d.id}\n${title}`.toLowerCase().includes(q)) {
                        return [];
                    }
                    const snippet =
                        i === -1 ? "" : d.body.slice(Math.max(0, i - 60), i + q.length + 60);
                    return [{ id: d.id, title, snippet }];
                });
            },
        },
        read_doc: {
            description:
                "A doc's raw md (including front-matter) and its validation errors. Figure links use file paths; list_docs maps each file to its read_figure name.",
            props: { id: { ...str, description: "doc id" } },
            required: ["id"],
            run: (a) => {
                const id = String(a.id);
                const compiled = compiler.compile();
                const doc = compiled.docs.find((d) => d.id === id);
                if (doc?.subformat)
                    return {
                        file: MANIFEST_FILE,
                        subformat: doc.subformat,
                        errors: compiled.sources.get(doc.file)?.errors ?? [],
                    };
                return doc
                    ? {
                          file: doc.file,
                          raw: readTextfile(root, doc.file),
                          errors: compiled.sources.get(doc.file)?.errors ?? [],
                      }
                    : { error: `doc "${id}" not found`, status: 404 };
            },
        },
        read_figure: {
            description:
                "A figure's markup (SVG / HTML / DXF geometry; images, video and PDF embedded as data URIs).",
            props: { name: { ...str, description: "Figure name (without extension)" } },
            required: ["name"],
            run: (a) =>
                compiler.compile().figures.find((f) => f.name === a.name) ?? {
                    error: `figure "${String(a.name)}" not found`,
                    status: 404,
                },
        },
        check: {
            description:
                "Check rendering, translations and theme variants before building. Returns the CLI CheckReport plus the legacy errors list.",
            props: {
                only: { type: "array", items: { ...str, enum: CHECK_KINDS } },
                allow_shared_svg: bool,
                warnings_as_errors: bool,
            },
            run: (a) => {
                const report = checkSite(root, {
                    only: a.only as CheckKind[] | undefined,
                    allowSharedSvg: a.allow_shared_svg === true,
                    warningsAsErrors: a.warnings_as_errors === true,
                });
                return {
                    ...report,
                    errors: report.diagnostics
                        .filter((d) => d.severity === "error")
                        .map((d) => `${d.file}: ${d.message}`),
                };
            },
        },
        add_doc: {
            description:
                "Create a new doc using the file layout, appended as the last child of parent in the manifest.",
            props: {
                id: { ...str, description: "New id (lowercase alphanumerics and hyphens)" },
                title: { ...str, description: "Title" },
                parent: { ...str, description: "Parent doc id (omit = top level)" },
            },
            required: ["id", "title"],
            run: (a) => ops.add(String(a.id), String(a.title), optStr(a.parent)),
        },
        write_doc: {
            description:
                "Overwrite the entire raw text of an existing doc (including front-matter). Returns the validation errors after writing.",
            props: {
                id: { ...str, description: "doc id" },
                content: { ...str, description: "Full md text (from ---\\ntitle: ...\\n---)" },
            },
            required: ["id", "content"],
            run: (a) => {
                const r = ops.write(String(a.id), String(a.content));
                return isOpError(r) ? r : { ...r, errors: docErrors(r.id) };
            },
        },
        move_doc: {
            description: "Move a doc (with its children) to position index under parent.",
            props: {
                id: { ...str, description: "doc id" },
                parent: { ...str, description: "New parent (omit = top level)" },
                index: { ...num, description: "Position among siblings (omit = last)" },
            },
            required: ["id"],
            run: (a) =>
                ops.move(
                    String(a.id),
                    optStr(a.parent),
                    typeof a.index === "number" ? a.index : undefined,
                ),
        },
        rename_doc: {
            description:
                "Change a doc id (the file name / manifest / file links in all docs follow).",
            props: {
                id: { ...str, description: "Current id" },
                new_id: { ...str, description: "New id" },
            },
            required: ["id", "new_id"],
            run: (a) => ops.rename(String(a.id), String(a.new_id)),
        },
        delete_doc: {
            description:
                "Delete a doc. Docs with children cannot be deleted. Requires force if other docs reference it via file links.",
            props: {
                id: { ...str, description: "doc id" },
                force: { ...bool, description: "Delete even if referenced" },
            },
            required: ["id"],
            run: (a) => ops.remove(String(a.id), a.force === true),
        },
        add_figure: {
            description:
                "Add a figure to figures/ (svg / drawio.svg / html / png / webp / jpg / gif / mp4 / webm / pdf / dxf). Give either path (a local file) or text (svg / html / dxf source). If the name is taken, -2 etc. is appended.",
            props: {
                file: {
                    ...str,
                    description:
                        "Figure file name (e.g. overview.svg; the extension determines the kind)",
                },
                path: { ...str, description: "Absolute path of the local file to copy from" },
                text: { ...str, description: "svg / html source" },
            },
            required: ["file"],
            run: (a) => {
                const path = optStr(a.path);
                const text = optStr(a.text);
                if ((path == null) === (text == null)) {
                    return { error: "specify exactly one of path or text", status: 400 };
                }
                return ops.addFigure(
                    String(a.file),
                    path == null ? Buffer.from(text ?? "", "utf8") : readFileSync(path),
                );
            },
        },
        delete_figure: {
            description: "Delete a figure. Requires force if a doc references it.",
            props: {
                name: { ...str, description: "Figure name (without extension)" },
                force: { ...bool, description: "Delete even if referenced" },
            },
            required: ["name"],
            run: (a) => ops.removeFigure(String(a.name), a.force === true),
        },
    };
};

const record = (value: unknown): value is Args =>
    value !== null && typeof value === "object" && !Array.isArray(value);

const validateProperty = (name: string, value: unknown, schema: Property): void => {
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (
        !types.some((t) => (t === "integer" ? Number.isSafeInteger(value) : t === type)) ||
        (schema.enum && !schema.enum.includes(value as string)) ||
        (schema.minimum !== undefined && Number(value) < schema.minimum)
    )
        throw new Error(`Invalid argument: ${name}`);
    if (schema.items && Array.isArray(value))
        for (const item of value) validateProperty(name, item, schema.items);
};

/** One request → response (undefined for notifications). */
export const handleRpc = async (
    tools: Record<string, Tool>,
    msg: unknown,
): Promise<object | undefined> => {
    const error = (code: number, message: string) => ({
        jsonrpc: "2.0",
        id:
            record(msg) && (typeof msg.id === "string" || typeof msg.id === "number")
                ? msg.id
                : null,
        error: { code, message },
    });
    if (
        !record(msg) ||
        msg.jsonrpc !== "2.0" ||
        typeof msg.method !== "string" ||
        (msg.id !== undefined && typeof msg.id !== "string" && typeof msg.id !== "number")
    )
        return error(-32600, "invalid request");
    if (msg.id === undefined) {
        return undefined;
    }
    if (msg.params !== undefined && !record(msg.params)) return error(-32602, "invalid params");
    const params = (msg.params ?? {}) as Args;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
        case "initialize":
            return reply({
                protocolVersion: params.protocolVersion ?? "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "dooc", version: "0" },
            });
        case "ping":
            return reply({});
        case "tools/list":
            return reply({
                tools: Object.entries(tools).map(([name, t]) => ({
                    name,
                    description: t.description,
                    inputSchema: {
                        type: "object",
                        properties: t.props,
                        required: t.required ?? [],
                        additionalProperties: false,
                    },
                })),
            });
        case "tools/call": {
            if (typeof params.name !== "string" || !Object.hasOwn(tools, params.name))
                return error(-32602, "unknown tool");
            const tool = tools[params.name];
            if (!tool) return error(-32602, "unknown tool");
            let result: unknown;
            try {
                const args = params.arguments === undefined ? {} : params.arguments;
                if (!record(args)) throw new Error("Tool arguments must be an object");
                for (const name of tool.required ?? [])
                    if (!Object.hasOwn(args, name)) throw new Error(`Missing argument: ${name}`);
                for (const [name, value] of Object.entries(args)) {
                    if (!Object.hasOwn(tool.props, name))
                        throw new Error(`Unknown argument: ${name}`);
                    const schema = tool.props[name];
                    if (schema) validateProperty(name, value, schema);
                }
                result = await tool.run(args);
            } catch (e) {
                result = { error: e instanceof Error ? e.message : String(e) };
            }
            return reply({
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                isError: isOpError(result),
            });
        }
        default:
            return {
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32601, message: "method not found" },
            };
    }
};

export const startMcp = async (root: string, options: McpOptions = {}): Promise<void> => {
    const tools = createTools(root, options);
    console.error(`dooc mcp: ${root}`);
    // Process requests in order so asynchronous builds and Git mutations cannot race edits.
    for await (const line of createInterface({ input: process.stdin })) {
        if (line.trim() === "") {
            continue;
        }
        let msg: unknown;
        try {
            msg = JSON.parse(line);
        } catch {
            process.stdout.write(
                `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`,
            );
            continue;
        }
        const res = await handleRpc(tools, msg);
        if (res) {
            process.stdout.write(`${JSON.stringify(res)}\n`);
        }
    }
};
