import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { prebuilt, readViewerAsset } from "./assets.js";
import { bundleClient } from "./serve.js";
import { terminal } from "./terminal.js";

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
    if (url.pathname === "/") url.pathname = "/api/workspace";
    return url.href;
};

const shell = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>dooc — Workspaces</title><style>body{margin:0;background:#fafaf8;color:#272727;font:15px/1.6 system-ui}main{max-width:600px;margin:15vh auto;padding:24px}h1{font-size:26px;font-weight:600}button{font:inherit;padding:9px 16px;border:1px solid #aaa;border-radius:4px;background:transparent;cursor:pointer}button:focus-visible{outline:2px solid #444;outline-offset:3px}</style><main><h1>dooc</h1><p>Edit documents in a local folder, browser storage, or a connected workspace.</p><button id="open-workspace" type="button">Open a workspace</button></main><script src="/assets/client.js"></script></html>`;

export const clientAssets = async (server?: string): Promise<Map<string, Buffer>> => {
    const files = new Map<string, Buffer>([
        ["index.html", Buffer.from(shell)],
        [
            "dooc-client.json",
            Buffer.from(JSON.stringify({ server: server ? validateServerUrl(server) : "" })),
        ],
        [
            "assets/fonts/udev-gothic-regular.woff2",
            readViewerAsset("fonts/udev-gothic-regular.woff2"),
        ],
        ["assets/fonts/LICENSE.txt", readViewerAsset("fonts/LICENSE.txt")],
    ]);
    const entries = {
        edit: "edit-client.ts",
        ui: "ui-client.ts",
        code: "code-highlight.ts",
        "code-worker": "code-worker.ts",
        graph: "schema-graph-global.tsx",
    };
    for (const [name, entry] of Object.entries(entries))
        files.set(`assets/${name}.js`, Buffer.from(await bundleClient(entry)));
    if (prebuilt) {
        for (const name of ["client", "workspace-worker"])
            files.set(`assets/${name}.js`, readViewerAsset(`${name}.global.js`));
    } else {
        const buildScript = new URL("../../../scripts/build/client.mjs", import.meta.url).href;
        const { buildBrowserWorkspace, buildClientEntry } = await import(buildScript);
        const [worker, client] = await Promise.all([
            buildBrowserWorkspace({ write: false }),
            buildClientEntry({ write: false }),
        ]);
        files.set("assets/workspace-worker.js", Buffer.from(worker.outputFiles[0].contents));
        files.set("assets/client.js", Buffer.from(client.outputFiles[0].contents));
    }
    return files;
};

export const buildStaticClient = async (directory: string, server?: string): Promise<void> => {
    const assets = await clientAssets(server);
    for (const [file, bytes] of assets) {
        const target = join(directory, file);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
    }
};

export const startStaticClient = async (port = 5180, socket?: string) => {
    const files = await clientAssets(socket);
    const server = createServer((req, res) => {
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
        const fallback =
            !path.startsWith("assets/") && !path.startsWith("api/") && !path.includes(".");
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
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
    });
    const address = server.address();
    terminal.ready(
        "client",
        socket ?? "Browser workspaces",
        `http://localhost:${typeof address === "object" && address ? address.port : port}/`,
    );
    return server;
};
