import type { RequestListener } from "node:http";
import { MAX_FILE_UPLOAD_BYTES } from "../../engine/src/core/files.js";
import { MCP_HTTP_VERSIONS } from "../../workspace/src/mcp.js";
import { isLocalHost } from "./editor-tools.js";
import { sendJson } from "./http-json.js";
import { createTools, handleRpc, type McpOptions } from "./mcp.js";
import { serveMcpHttp } from "./mcp-http-transport.js";

export const createMcpHandler = (
    root: string | (() => Promise<string>),
    options: McpOptions = {},
): RequestListener => {
    let currentRoot = typeof root === "string" ? root : "";
    let tools = currentRoot ? createTools(currentRoot, options) : undefined;
    let queue: Promise<unknown> = Promise.resolve();
    return (req, res) => {
        const host = req.headers.host ?? "";
        const scheme = "encrypted" in req.socket && req.socket.encrypted ? "https" : "http";
        if (
            !isLocalHost(host) ||
            (req.headers.origin !== undefined && req.headers.origin !== `${scheme}://${host}`)
        ) {
            sendJson(res, 403, { error: "MCP requires a local request from an allowed origin" });
            return;
        }
        if (req.url !== "/mcp") {
            sendJson(res, 404);
            return;
        }
        void serveMcpHttp(
            req,
            res,
            (message) => {
                const run = async () => {
                    const nextRoot = typeof root === "string" ? root : await root();
                    if (!tools || nextRoot !== currentRoot) {
                        currentRoot = nextRoot;
                        tools = createTools(currentRoot, options);
                    }
                    return handleRpc(tools, message, MCP_HTTP_VERSIONS);
                };
                const next = queue.then(run, run);
                queue = next.catch(() => {});
                return next;
            },
            Math.ceil((MAX_FILE_UPLOAD_BYTES * 4) / 3) + 16_384,
        );
    };
};
