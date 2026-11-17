// Node adapters for the shared MCP tool catalog and JSON-RPC dispatcher.
import { dirname, relative } from "node:path";
import { createInterface } from "node:readline";
import type { CompileOptions } from "../../engine/src/compiler/compile.js";
import { addProjectFont } from "../../engine/src/compiler/fonts.js";
import { textfilePath } from "../../engine/src/compiler/textfile.js";
import { createMcpOperations } from "../../frontend/src/mcp-operations.js";
import type { GitOrigin } from "../../workspace/src/git-types.js";
import { parsePerson } from "../../workspace/src/history.js";
import { type Args, handleRpc } from "../../workspace/src/mcp.js";
import { createMcpTools } from "../../workspace/src/mcp-tools.js";
import { buildBundle } from "./build.js";
import { outputFile, writeBuildOutput } from "./build-output.js";
import { createGitHandler, validateGitOrigin } from "./git.js";
import { folderHistory, gitHistory, workspaceHistory } from "./history.js";
import { prepareDocumentSources } from "./remote-manifests.js";

export { handleRpc, MCP_HTTP_VERSIONS } from "../../workspace/src/mcp.js";
export interface McpOptions extends CompileOptions {
    gitOrigin?: GitOrigin;
    readOnly?: boolean;
}
export const createTools = (root: string, options: McpOptions = {}) => {
    const origin = options.gitOrigin && validateGitOrigin(options.gitOrigin);
    const git = createGitHandler(root, () => origin);
    const optStr = (v: unknown): string | undefined =>
        typeof v === "string" && v !== "" ? v : undefined;
    const operations: Record<string, (args: Args) => unknown> = {
        ...createMcpOperations(root, options),
        build: async (a) => {
            const github = a.format === "github" || a.target === "github";
            if (a.format !== "html" && a.format !== "zip" && a.format !== "github")
                throw new Error("build format must be html | zip | github");
            const file = relative(
                root,
                outputFile(root, a.format === "html" ? "html" : "zip", github),
            ).replaceAll("\\", "/");
            const bundle = await buildBundle(root, {
                format: a.format as "html" | "zip" | "github",
                target: a.target as "github" | undefined,
                resources: a.resources as "copy" | "reference" | undefined,
                referenceBase: a.reference_base as string | undefined,
                urlPreview: (a.url_preview ?? (a.mode === "live" ? "network" : "embed")) as
                    | "embed"
                    | "network",
                mode: a.mode as "static" | "live" | undefined,
                auth: a.auth as "external" | undefined,
                sourceUrl: a.source_url as string | undefined,
                download: a.download as "easy" | "normal" | "block" | undefined,
                previews: options.previews,
            });
            const path = textfilePath(root, file);
            writeBuildOutput(path, bundle);
            bundle.commitVersion?.();
            return {
                file,
                path,
                bytes: Buffer.byteLength(bundle.data),
                docs: bundle.docs,
                ...(bundle.version ? { version: bundle.version } : {}),
                ...(bundle.revision ? { revision: bundle.revision } : {}),
                ...(bundle.warnings?.length ? { warnings: bundle.warnings } : {}),
                ...(bundle.files
                    ? { files: bundle.files.map(({ name }) => `${dirname(file)}/${name}`) }
                    : {}),
                url_preview: a.url_preview ?? (a.mode === "live" ? "network" : "embed"),
            };
        },
        add_font: (a) => ({ file: addProjectFont(root, a.path as string) }),
        git: git,
        history: async (a) => {
            const user = optStr(a.user);
            if (a.action === "snapshot") {
                const message = optStr(a.message)?.trim();
                if (!message) throw new Error("A snapshot needs a message");
                return workspaceHistory(root).snapshot(
                    message,
                    user ? { author: parsePerson({ name: user }) } : undefined,
                );
            }
            const name = user?.toLowerCase();
            const stores = { git: gitHistory(root), dooc: folderHistory(root) };
            // shortcut: filters the newest 200 commits, page through git log when a user's older edits are needed.
            const snapshots = (
                await Promise.all(
                    (["git", "dooc"] as const)
                        .filter((source) => !a.source || a.source === source)
                        .map(async (source) =>
                            (await stores[source].list()).map((s) => ({ source, ...s })),
                        ),
                )
            )
                .flat()
                .filter(
                    (s) =>
                        !name ||
                        [s.author, ...(s.coAuthors ?? [])].some(
                            (person) => person?.toLowerCase() === name,
                        ),
                )
                .sort((x, y) => Date.parse(y.time) - Date.parse(x.time));
            return { snapshots };
        },
    };
    return createMcpTools(async (name, args) => {
        await prepareDocumentSources(root);
        return operations[name]?.(args);
    }, options.readOnly);
};

export const startMcp = async (
    root: string | (() => Promise<string>),
    options: McpOptions = {},
    signal?: AbortSignal,
): Promise<void> => {
    let currentRoot = typeof root === "string" ? root : "";
    let tools = currentRoot ? createTools(currentRoot, options) : undefined;
    // Process requests in order so asynchronous builds and Git mutations cannot race edits.
    for await (const line of createInterface({ input: process.stdin, signal })) {
        if (signal?.aborted) break;
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
        const nextRoot = typeof root === "string" ? root : await root();
        if (!tools || nextRoot !== currentRoot) {
            currentRoot = nextRoot;
            tools = createTools(currentRoot, options);
        }
        const res = await handleRpc(tools, msg);
        if (res) {
            process.stdout.write(`${JSON.stringify(res)}\n`);
        }
    }
};
