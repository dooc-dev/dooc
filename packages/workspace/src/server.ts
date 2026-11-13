// Host-neutral workspace server: routes protocol requests to operations and pushes events to every
// connected port. It knows nothing about Node or the browser; the host supplies the operations.
import {
    WORKSPACE_PROTOCOL,
    type WorkspaceEvent,
    type WorkspaceHello,
    type WorkspacePort,
    type WorkspaceResponse,
} from "./protocol.js";

/** `session` is whatever the host attached to the connection (who is asking, how far to trust). */
export type WorkspaceOps<Session> = Record<
    string,
    (args: Record<string, unknown>, session: Session) => unknown
>;

export interface WorkspaceServer<Session> {
    /** Returns the function that detaches the port. */
    connect(port: WorkspacePort, session: Session): () => void;
    broadcast(event: string, data: unknown): void;
}

export const createWorkspaceServer = <Session>(
    ops: WorkspaceOps<Session>,
    info: Pick<WorkspaceHello, "boot" | "shared"> = {},
): WorkspaceServer<Session> => {
    const ports = new Set<WorkspacePort>();
    const hello: WorkspaceHello = {
        protocol: WORKSPACE_PROTOCOL,
        ops: Object.keys(ops),
        ...info,
    };
    return {
        connect(port, session) {
            ports.add(port);
            port.receive((message) => {
                if (!ports.has(port) || typeof message !== "object" || message === null) return;
                const { id, op, args } = message as Record<string, unknown>;
                // Without an id there is nothing to answer.
                if (typeof id !== "number") return;
                const reply = (response: WorkspaceResponse) => {
                    if (ports.has(port)) port.send(response);
                };
                void (async () => {
                    if (op === "hello") return hello;
                    if (typeof op !== "string" || !Object.hasOwn(ops, op))
                        throw new Error(`Unknown workspace operation: ${String(op)}`);
                    return ops[op]?.(
                        typeof args === "object" && args !== null && !Array.isArray(args)
                            ? (args as Record<string, unknown>)
                            : {},
                        session,
                    );
                })().then(
                    (value) => reply({ id, value }),
                    (error: unknown) =>
                        reply({
                            id,
                            error: error instanceof Error ? error.message : String(error),
                        }),
                );
            });
            return () => {
                ports.delete(port);
            };
        },
        broadcast(event, data) {
            const message: WorkspaceEvent = { event, data };
            for (const port of ports) port.send(message);
        },
    };
};
