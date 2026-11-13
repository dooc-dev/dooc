// The workspace protocol: every file, history and collaboration request the UI makes goes through
// these messages, so the same UI talks to a server in Node (WebSocket) or in a browser Worker.
// Messages are plain structured values; each transport picks its own encoding.

export const WORKSPACE_PROTOCOL = 1;
export const WORKSPACE_PATH = "/api/workspace";

export interface WorkspaceRequest {
    id: number;
    op: string;
    args?: Record<string, unknown>;
}

export type WorkspaceResponse = { id: number; value: unknown } | { id: number; error: string };

export interface WorkspaceEvent {
    event: string;
    data: unknown;
}

/** One end of a message channel. */
export interface WorkspacePort {
    send(message: unknown): void;
    receive(handler: (message: unknown) => void): void;
    /** Called when the channel drops; requests in flight can never be answered after it. */
    closed?(handler: () => void): void;
    /** Called each time the channel (re)connects; absent on channels that never drop. */
    opened?(handler: () => void): void;
}

export interface WorkspaceHello {
    protocol: number;
    /** Operation groups this server offers; the UI hides what is missing. */
    ops: string[];
    /** Identifies the server process; a different value after a reconnect means it restarted. */
    boot?: string;
    /** Several people edit this workspace at once, so each connection should identify itself. */
    shared?: boolean;
}

/** Two connected ports in one thread (tests, and a server hosted next to its client). */
export const portPair = (): [WorkspacePort, WorkspacePort] => {
    const handlers: (((message: unknown) => void) | undefined)[] = [undefined, undefined];
    const end = (self: number): WorkspacePort => ({
        // Delivered asynchronously and as a copy, like a real channel.
        send: (message) => {
            const copy = structuredClone(message);
            queueMicrotask(() => handlers[1 - self]?.(copy));
        },
        receive: (handler) => {
            handlers[self] = handler;
        },
    });
    return [end(0), end(1)];
};
