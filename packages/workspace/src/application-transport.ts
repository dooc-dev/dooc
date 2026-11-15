import type { WorkspaceClient } from "./client.js";
import { clientPath, workspacePath } from "./client-path.js";

/** Requests stay on the connection captured here, even when another pane becomes active. */
export const workspaceHttp =
    (client: WorkspaceClient) =>
    async (input: string | URL, init?: RequestInit): Promise<Response> => {
        let url = new URL(input, location.href);
        if (url.origin !== location.origin) return fetch(input, init);
        if (typeof input !== "string" || /^[a-z]+:/i.test(input))
            url.pathname = workspacePath(url.pathname);
        const request = new Request(url, init);
        const body =
            request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
        for (let redirect = 0; redirect < 6; redirect++) {
            const result = await client.request<{
                status: number;
                headers: Record<string, string>;
                body: string | number[];
            }>("http", {
                url: url.pathname + url.search,
                method: request.method,
                headers: Object.fromEntries(request.headers),
                body,
            });
            const next = result.headers.location;
            if (next && [301, 302, 303, 307, 308].includes(result.status)) {
                url = new URL(next, url);
                if (url.origin !== location.origin)
                    throw new Error("Unexpected workspace redirect");
                continue;
            }
            const response = new Response(
                [204, 304].includes(result.status)
                    ? null
                    : typeof result.body === "string"
                      ? result.body
                      : new Uint8Array(result.body),
                { status: result.status, headers: result.headers },
            );
            const browserUrl = new URL(url);
            browserUrl.pathname = clientPath(url.pathname);
            Object.defineProperty(response, "url", { value: browserUrl.href });
            return response;
        }
        throw new Error("Too many workspace redirects");
    };
