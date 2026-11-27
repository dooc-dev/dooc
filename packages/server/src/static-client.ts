import type { RequestListener } from "node:http";
import { validateRelayUrl } from "../../workspace/src/mcp-relay.js";
import { prebuilt, readReaderAsset } from "./assets.js";
import { bundleClient, clientShell } from "./serve.js";

export const validateServerUrl = (value: string): string => {
    const url = new URL(value);
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    if (
        !["ws:", "wss:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    )
        throw new Error(
            "Server must be a ws:// or wss:// URL without credentials, query or fragment",
        );
    if (url.pathname === "/") url.pathname = "/server";
    return url.href;
};

export interface ClientOptions {
    versions?: string;
    runtime?: "node" | "web";
    readOnly?: boolean;
    client?: boolean;
    worker?: boolean;
    basePath?: string;
    relayUrl?: string;
    mcp?: boolean;
}

export const clientAssets = async (
    server?: string,
    options: ClientOptions = {},
): Promise<Map<string, Buffer>> => {
    const files = new Map<string, Buffer>();
    if (options.client === false && options.worker === false) return files;
    if (options.client !== false) {
        for (const [file, data] of [
            [
                "index.html",
                Buffer.from(
                    clientShell(options.readOnly).replaceAll(
                        "/assets/",
                        `${options.basePath ?? ""}/assets/`,
                    ),
                ),
            ],
            [
                "dooc-client.json",
                Buffer.from(
                    JSON.stringify({
                        server: server ? validateServerUrl(server) : "",
                        runtime: options.runtime,
                        readOnly: options.readOnly,
                        worker: options.worker !== false,
                        ...(options.versions === undefined ? {} : { versions: options.versions }),
                        ...(options.mcp ? { mcp: true } : {}),
                        ...(options.relayUrl
                            ? { relayUrl: validateRelayUrl(options.relayUrl) }
                            : {}),
                    }),
                ),
            ],
            [
                "assets/fonts/udev-gothic-regular.woff2",
                readReaderAsset("fonts/udev-gothic-regular.woff2"),
            ],
            ["assets/fonts/LICENSE.txt", readReaderAsset("fonts/LICENSE.txt")],
        ] as [string, Buffer][])
            files.set(file, data);
        const entries = {
            edit: "edit-client.ts",
            manifest: "manifest-client.ts",
            ui: "ui-client.ts",
            code: "code-highlight.ts",
            "code-worker": "code-worker.ts",
            graph: "schema-graph-global.tsx",
        };
        for (const [name, entry] of Object.entries(entries)) {
            if ((name === "edit" || name === "manifest") && options.readOnly) continue;
            files.set(`assets/${name}.js`, Buffer.from(await bundleClient(entry)));
        }
    }
    if (prebuilt) {
        if (options.client !== false && (options.mcp || options.relayUrl))
            files.set("assets/mcp.js", readReaderAsset("mcp-client.js"));
        if (options.client !== false)
            files.set("assets/client.js", readReaderAsset("client.global.js"));
        if (options.worker !== false)
            files.set(
                "assets/workspace-worker.js",
                readReaderAsset(
                    `workspace-${options.readOnly ? "reader-" : ""}${options.mcp || options.relayUrl ? "mcp-" : ""}worker.global.js`,
                ),
            );
    } else {
        const buildScript = new URL("../../../scripts/build/client.mjs", import.meta.url).href;
        const { buildBrowserWorkspace, buildClientEntry, buildMcpClient } = await import(
            buildScript
        );
        if (options.client !== false && (options.mcp || options.relayUrl)) {
            const mcp = await buildMcpClient({ write: false });
            files.set("assets/mcp.js", Buffer.from(mcp.outputFiles[0].contents));
        }
        if (options.worker !== false) {
            const worker = await buildBrowserWorkspace({
                write: false,
                define: {
                    DOOC_READ_ONLY: String(options.readOnly === true),
                    DOOC_MCP: String(!!(options.mcp || options.relayUrl)),
                },
            });
            files.set("assets/workspace-worker.js", Buffer.from(worker.outputFiles[0].contents));
        }
        if (options.client !== false) {
            const client = await buildClientEntry({ write: false });
            files.set("assets/client.js", Buffer.from(client.outputFiles[0].contents));
        }
    }
    return files;
};

export const staticClientHandler =
    (files: Map<string, Buffer>, basePath = ""): RequestListener =>
    (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405, { Allow: "GET, HEAD" });
            res.end();
            return;
        }
        let path: string;
        try {
            path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname).slice(
                1,
            );
        } catch {
            res.writeHead(400);
            res.end();
            return;
        }
        if (basePath) {
            if (`/${path}` !== basePath && !`/${path}`.startsWith(`${basePath}/`)) {
                res.writeHead(404);
                res.end("Not found");
                return;
            }
            path = path.slice(basePath.length);
        }
        const fallback =
            !path.startsWith("assets/") &&
            !path.startsWith("api/") &&
            (!path.includes(".") ||
                /^_(?:docs|files)\//.test(path) ||
                req.headers.accept?.includes("text/html"));
        const file = files.has(path) ? path : fallback ? "index.html" : "";
        const data = files.get(file);
        if (!data) {
            res.writeHead(404);
            res.end("Not found");
            return;
        }
        const type = file.endsWith(".js")
            ? "text/javascript"
            : file.endsWith(".html")
              ? "text/html"
              : file.endsWith(".json")
                ? "application/json"
                : file.endsWith(".woff2")
                  ? "font/woff2"
                  : "text/plain";
        res.writeHead(200, {
            "Content-Type": `${type}${type.startsWith("text/") ? "; charset=utf-8" : ""}`,
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-cache",
        });
        res.end(req.method === "HEAD" ? undefined : data);
    };
