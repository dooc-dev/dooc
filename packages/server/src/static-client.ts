import type { RequestListener } from "node:http";
import { DARK_C, initializeThemes, LIGHT_C } from "../../frontend/src/theme-picker.js";
import { validateRelayUrl } from "../../workspace/src/mcp-relay.js";
import { prebuilt, readViewerAsset } from "./assets.js";
import { bundleClient } from "./serve.js";

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

const shell = (readOnly = false): string => {
    const theme = readOnly ? "theme" : "editor-theme";
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>dooc — Workspaces</title>
<script>var __name = (f) => f; (${initializeThemes.toString()})();</script>
<style>
:root { ${DARK_C} }
@media (prefers-color-scheme: light) { :root:not([data-${theme}="dark"]) { ${LIGHT_C} } }
:root[data-${theme}="light"] { ${LIGHT_C} }
body { margin: 0; background: var(--c-bg0); color: var(--c-fg); font: 15px/1.6 system-ui; }
#client-loading { display: grid; min-height: 100dvh; place-items: center; color: var(--c-fg-muted); font-size: 13px; }
main { max-width: 600px; margin: 15vh auto; padding: 24px; }
h1 { font-size: 26px; font-weight: 600; }
button { font: inherit; padding: 9px 16px; border: 1px solid var(--c-line); border-radius: 4px; background: transparent; color: inherit; cursor: pointer; }
button:focus-visible { outline: 2px solid var(--c-fg-muted); outline-offset: 3px; }
</style></head><body><div id="client-loading" role="status">Loading document…</div><main hidden><h1>dooc</h1><p>${readOnly ? "Read" : "Edit"} documents in a local folder, browser storage, or a connected workspace.</p><button id="open-workspace" type="button">Open a workspace</button></main><script src="/assets/client.js"></script></body></html>`;
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
                    shell(options.readOnly).replace(
                        "/assets/client.js",
                        `${options.basePath ?? ""}/assets/client.js`,
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
                readViewerAsset("fonts/udev-gothic-regular.woff2"),
            ],
            ["assets/fonts/LICENSE.txt", readViewerAsset("fonts/LICENSE.txt")],
        ] as [string, Buffer][])
            files.set(file, data);
        const entries = {
            edit: "edit-client.ts",
            ui: "ui-client.ts",
            code: "code-highlight.ts",
            "code-worker": "code-worker.ts",
            graph: "schema-graph-global.tsx",
        };
        for (const [name, entry] of Object.entries(entries)) {
            if (name === "edit" && options.readOnly) continue;
            files.set(`assets/${name}.js`, Buffer.from(await bundleClient(entry)));
        }
    }
    if (prebuilt) {
        if (options.client !== false && (options.mcp || options.relayUrl))
            files.set("assets/mcp.js", readViewerAsset("mcp-client.js"));
        if (options.client !== false)
            files.set("assets/client.js", readViewerAsset("client.global.js"));
        if (options.worker !== false)
            files.set(
                "assets/workspace-worker.js",
                readViewerAsset(
                    `workspace-${options.readOnly ? "viewer-" : ""}${options.mcp || options.relayUrl ? "mcp-" : ""}worker.global.js`,
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
            (!path.includes(".") || /^_(?:docs|files)\//.test(path));
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
