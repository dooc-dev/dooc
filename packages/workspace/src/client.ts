// Browser side of the workspace protocol. The UI calls request()/on() and never learns whether
// the server is behind a WebSocket or in a Worker.

import { workspaceConnection } from "./connection.js";
import { WORKSPACE_PATH, type WorkspacePort } from "./protocol.js";

export interface WorkspaceClient {
    request<T = unknown>(op: string, args?: Record<string, unknown>): Promise<T>;
    /** Returns the function that stops listening. */
    on(event: string, handler: (data: unknown) => void): () => void;
    /** Runs on every (re)connection; right away on a channel that is always connected. */
    opened(handler: () => void): void;
}

export const createWorkspaceClient = (port: WorkspacePort): WorkspaceClient => {
    let next = 0;
    const pending = new Map<
        number,
        { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    const listeners = new Map<string, Set<(data: unknown) => void>>();
    port.receive((message) => {
        if (typeof message !== "object" || message === null) return;
        const { id, value, error, event, data } = message as Record<string, unknown>;
        if (typeof event === "string") {
            for (const handler of listeners.get(event) ?? []) handler(data);
            return;
        }
        const request = typeof id === "number" ? pending.get(id) : undefined;
        if (!request) return;
        pending.delete(id as number);
        if (typeof error === "string") request.reject(new Error(error));
        else request.resolve(value);
    });
    port.closed?.(() => {
        for (const request of pending.values())
            request.reject(new Error("Workspace connection closed"));
        pending.clear();
    });
    return {
        request: <T>(op: string, args?: Record<string, unknown>) =>
            new Promise<T>((resolve, reject) => {
                const id = ++next;
                pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
                try {
                    port.send({ id, op, args });
                } catch (error) {
                    pending.delete(id);
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            }),
        on(event, handler) {
            const set = listeners.get(event) ?? new Set();
            listeners.set(event, set);
            set.add(handler);
            return () => set.delete(handler);
        },
        opened(handler) {
            if (port.opened) port.opened(handler);
            else handler();
        },
    };
};

/** JSON over a WebSocket that is kept open: a dropped connection is retried until it returns. */
export const webSocketPort = (url: string): WorkspacePort => {
    let receive: (message: unknown) => void = () => {};
    let closed: () => void = () => {};
    let opened: () => void = () => {};
    let socket: WebSocket;
    const connect = (): void => {
        const current = new WebSocket(url);
        socket = current;
        current.addEventListener("open", () => opened());
        current.addEventListener("message", (event) => {
            if (typeof event.data === "string") receive(JSON.parse(event.data));
        });
        current.addEventListener("close", () => {
            closed();
            // Short, so a restarted dev server is noticed quickly.
            setTimeout(connect, 300);
        });
    };
    connect();
    return {
        send(message) {
            const text = JSON.stringify(message);
            const current = socket;
            if (current.readyState === WebSocket.OPEN) current.send(text);
            // If this connection fails instead, `closed` rejects the request that was waiting.
            else if (current.readyState === WebSocket.CONNECTING)
                current.addEventListener("open", () => current.send(text), { once: true });
            else throw new Error("Workspace connection closed");
        },
        receive(handler) {
            receive = handler;
        },
        closed(handler) {
            closed = handler;
        },
        opened(handler) {
            opened = handler;
            if (socket.readyState === WebSocket.OPEN) handler();
        },
    };
};

let page: WorkspaceClient | undefined;

/** The workspace this page was served from. */
export const pageWorkspace = (id?: string): WorkspaceClient => {
    const connection = workspaceConnection(id);
    if (connection) return connection.client;
    if (id && id !== "local") throw new Error("Workspace is not open");
    page ??= createWorkspaceClient(
        webSocketPort(
            `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${WORKSPACE_PATH}`,
        ),
    );
    return page;
};
