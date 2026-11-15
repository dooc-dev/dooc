import type { IncomingMessage, ServerResponse } from "node:http";
import { MCP_HTTP_VERSIONS } from "../../workspace/src/mcp.js";
import { HttpError, readJson, sendJson } from "./http-json.js";

export const serveMcpHttp = async (
    req: IncomingMessage,
    res: ServerResponse,
    execute: (message: unknown) => Promise<object | undefined>,
    limit: number,
): Promise<void> => {
    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        sendJson(res, 405);
        return;
    }
    if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
        sendJson(res, 415);
        return;
    }
    const accept = req.headers.accept ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
        sendJson(res, 406);
        return;
    }
    const version = req.headers["mcp-protocol-version"];
    if (
        version !== undefined &&
        (typeof version !== "string" || !MCP_HTTP_VERSIONS.includes(version))
    ) {
        sendJson(res, 400, {
            error: "Unsupported MCP protocol version",
            supported: MCP_HTTP_VERSIONS,
        });
        return;
    }
    try {
        const message = await readJson(req, limit);
        if (res.destroyed) return;
        if (
            message &&
            typeof message === "object" &&
            "jsonrpc" in message &&
            message.jsonrpc === "2.0" &&
            "id" in message &&
            ["string", "number"].includes(typeof message.id) &&
            !("method" in message) &&
            ("result" in message || "error" in message)
        ) {
            sendJson(res, 202);
            return;
        }
        const result = await execute(message);
        sendJson(res, result === undefined ? 202 : 200, result);
    } catch (error) {
        sendJson(
            res,
            error instanceof HttpError ? error.status : 500,
            error instanceof HttpError && error.status === 400
                ? { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }
                : { error: error instanceof HttpError ? error.message : "MCP request failed" },
        );
    }
};
