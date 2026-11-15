import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

export const sendJson = (res: ServerResponse, status: number, body?: unknown): void => {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    });
    res.end(body === undefined ? undefined : JSON.stringify(body));
};

export const readJson = (req: IncomingMessage, limit: number): Promise<unknown> =>
    new Promise((resolve, reject) => {
        let size = 0;
        let chunks: Buffer[] = [];
        let failed = false;
        const fail = (error: Error) => {
            failed = true;
            chunks = [];
            reject(error);
        };
        req.on("error", () => fail(new HttpError(400, "Request interrupted")));
        req.on("aborted", () => fail(new HttpError(400, "Request interrupted")));
        if (Number(req.headers["content-length"]) > limit) {
            fail(new HttpError(413, "Request exceeds the message limit"));
            req.resume();
            return;
        }
        req.on("data", (chunk: Buffer) => {
            if (failed) return;
            size += chunk.length;
            if (size > limit) fail(new HttpError(413, "Request exceeds the message limit"));
            else chunks.push(chunk);
        });
        req.on("end", () => {
            if (failed) return;
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
                fail(new HttpError(400, "Invalid JSON"));
            }
            chunks = [];
        });
    });
