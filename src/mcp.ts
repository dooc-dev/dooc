// stdio MCP server that reads and writes the docs root (`dooc mcp [root]`). MCP is
// newline-delimited JSON-RPC 2.0 and we only use initialize / tools/list / tools/call, so we
// speak it directly without the SDK. stdout is for the protocol only; logs go to stderr.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { type CompileOptions, createCompiler } from "./compiler/compile.js";
import { loadDocsConfig } from "./compiler/config.js";
import { createDocOps, isOpError } from "./compiler/ops.js";
import { docDisplayName } from "./core/taxonomy.js";

type Args = Record<string, unknown>;

interface Tool {
    description: string;
    props: Record<string, { type: string; description: string }>;
    required?: string[];
    run: (a: Args) => unknown;
}

const str = { type: "string" } as const;
const num = { type: "number" } as const;
const bool = { type: "boolean" } as const;

export const createTools = (root: string, options: CompileOptions = {}): Record<string, Tool> => {
    const compiler = createCompiler(root, options);
    const ops = createDocOps(root);
    const optStr = (v: unknown): string | undefined =>
        typeof v === "string" && v !== "" ? v : undefined;
    const docErrors = (id: string): string[] =>
        compiler.compile().sources.get(`content/${id}.md`)?.errors ?? [];

    return {
        list_docs: {
            description:
                "The doc tree (in manifest display order) and the list of figures. Each doc has id / title / parent / depth.",
            props: {},
            run: () => {
                const { artifact } = compiler.compile();
                const depth = new Map<string, number>();
                return {
                    docs: artifact.docs.map((d) => {
                        const dep = d.parent == null ? 0 : (depth.get(d.parent) ?? 0) + 1;
                        depth.set(d.id, dep);
                        return {
                            id: d.id,
                            title: docDisplayName(d, d.id),
                            parent: d.parent,
                            depth: dep,
                        };
                    }),
                    figures: artifact.figures.map((f) => ({
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
                return compiler.compile().artifact.docs.flatMap((d) => {
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
                "A doc's raw md (including front-matter) and its validation errors. Fig.<name> references in the body can be read with read_figure.",
            props: { id: { ...str, description: "doc id" } },
            required: ["id"],
            run: (a) => {
                const id = String(a.id);
                const doc = compiler.compile().artifact.docs.find((d) => d.id === id);
                return doc
                    ? {
                          raw: readFileSync(`${ops.contentDir}/${id}.md`, "utf8"),
                          errors: docErrors(id),
                      }
                    : { error: `doc "${id}" not found`, status: 404 };
            },
        },
        read_figure: {
            description: "A figure's markup (SVG / HTML; raster images as an <img> data URI).",
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
                "List the validation errors across the whole docs root (check before export).",
            props: {},
            run: () => ({ errors: compiler.compile().errors }),
        },
        add_doc: {
            description:
                "Create a new doc (content/<id>.md, appended as the last child of parent in the manifest).",
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
                "Change a doc id (the file name / manifest / doc: links in all docs follow).",
            props: {
                id: { ...str, description: "Current id" },
                new_id: { ...str, description: "New id" },
            },
            required: ["id", "new_id"],
            run: (a) => ops.rename(String(a.id), String(a.new_id)),
        },
        delete_doc: {
            description:
                "Delete a doc. Docs with children cannot be deleted. Requires force if other docs reference it via doc: links.",
            props: {
                id: { ...str, description: "doc id" },
                force: { ...bool, description: "Delete even if referenced" },
            },
            required: ["id"],
            run: (a) => ops.remove(String(a.id), a.force === true),
        },
        add_figure: {
            description:
                "Add a figure to figures/ (svg / drawio.svg / html / png / webp / jpg). Give either path (a local file) or text (svg / html source). If the name is taken, -2 etc. is appended.",
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

type Rpc = { jsonrpc: "2.0"; id?: number | string; method: string; params?: Args };

/** One request → response (undefined for notifications). */
export const handleRpc = (tools: Record<string, Tool>, msg: Rpc): object | undefined => {
    if (msg.id === undefined) {
        return undefined;
    }
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
        case "initialize":
            return reply({
                protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
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
                    },
                })),
            });
        case "tools/call": {
            const tool = tools[String(msg.params?.name)];
            if (!tool) {
                return {
                    jsonrpc: "2.0",
                    id: msg.id,
                    error: { code: -32602, message: "unknown tool" },
                };
            }
            let result: unknown;
            try {
                result = tool.run((msg.params?.arguments ?? {}) as Args);
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

export const startMcp = async (root: string): Promise<void> => {
    // Only the default language matters here (docs are read / validated, not rendered).
    const { defaultLang } = await loadDocsConfig(root);
    const tools = createTools(root, { defaultLang });
    console.error(`dooc mcp: ${root}`);
    createInterface({ input: process.stdin }).on("line", (line) => {
        if (line.trim() === "") {
            return;
        }
        let msg: Rpc;
        try {
            msg = JSON.parse(line);
        } catch {
            process.stdout.write(
                `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`,
            );
            return;
        }
        const res = handleRpc(tools, msg);
        if (res) {
            process.stdout.write(`${JSON.stringify(res)}\n`);
        }
    });
};
