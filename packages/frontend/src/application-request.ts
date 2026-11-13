import type { IncomingMessage, ServerResponse } from "node:http";
import type { createDocumentApplication, ServeMode } from "./document-application.js";

export interface ApplicationRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
}
export interface ApplicationResponse {
    status: number;
    headers: Record<string, string>;
    body: string | Uint8Array;
}

/** The document application uses the same bounded request/response contract in both hosts. */
export const applicationRequest = async (
    app: ReturnType<typeof createDocumentApplication>,
    mode: ServeMode,
    request: ApplicationRequest,
): Promise<ApplicationResponse> => {
    if (
        typeof request.url !== "string" ||
        !request.url.startsWith("/") ||
        request.url.startsWith("//") ||
        !["GET", "POST"].includes(request.method) ||
        typeof request.body !== "string"
    )
        throw new Error("Invalid document request");
    if (
        !request.headers ||
        typeof request.headers !== "object" ||
        Array.isArray(request.headers) ||
        Object.entries(request.headers).some(
            ([key, value]) =>
                !/^[-a-z0-9]+$/i.test(key) || typeof value !== "string" || /[\r\n\0]/.test(value),
        )
    )
        throw new Error("Invalid request headers");
    request = {
        ...request,
        headers: Object.fromEntries(
            Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value]),
        ),
    };
    if (new TextEncoder().encode(request.body).length > 5_000_000)
        throw new Error("Request body is too large");
    let status = 200;
    const headers: Record<string, string> = {};
    let body: string | Uint8Array = "";
    await app.handle(
        mode,
        request as unknown as IncomingMessage,
        {
            setHeader(name: string, value: string) {
                headers[name] = value;
            },
            writeHead(code: number, values: Record<string, string>) {
                status = code;
                Object.assign(headers, values);
            },
            end(value?: string | Uint8Array) {
                body = value ?? "";
            },
        } as unknown as ServerResponse,
    );
    return { status, headers, body };
};
