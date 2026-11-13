import type { WorkspaceClient } from "./client.js";

export interface WorkspaceConnection {
    id: string;
    label: string;
    family?: string;
    branch?: string;
    readonly branches?: readonly string[];
    client: WorkspaceClient;
    fetch(input: string | URL, init?: RequestInit): Promise<Response>;
    openBranch?(branch: string, create?: boolean): Promise<WorkspaceConnection>;
    close?(): void;
}

declare global {
    var __doocConnections:
        | {
              active: string;
              items: Map<string, WorkspaceConnection>;
          }
        | undefined;
}

const connections = () => (globalThis.__doocConnections ??= { active: "local", items: new Map() });

export const workspaceId = (): string => connections().active;
export const workspaceConnections = (): WorkspaceConnection[] => [...connections().items.values()];
export const workspaceConnection = (id = workspaceId()): WorkspaceConnection | undefined =>
    connections().items.get(id);

export const registerWorkspace = (connection: WorkspaceConnection): void => {
    if (connections().items.has(connection.id)) throw new Error("Workspace is already open");
    connections().items.set(connection.id, connection);
};

const openingBranches = new Map<string, Promise<WorkspaceConnection>>();

/** Reuse the branch's storage and drafts, including local folders that are never saved in the chooser. */
export const openBranchWorkspace = async (
    family: string,
    branch: string,
    create: boolean,
    open: () => Promise<WorkspaceConnection>,
): Promise<WorkspaceConnection> => {
    const existing = workspaceConnections().find(
        (connection) => connection.family === family && connection.branch === branch,
    );
    const key = JSON.stringify([family, branch]);
    const pending = openingBranches.get(key);
    if (create && (existing || pending)) throw new Error("Branch already has a workspace");
    if (existing) return existing;
    if (pending) return pending;
    const next = Promise.resolve()
        .then(open)
        .finally(() => openingBranches.delete(key));
    openingBranches.set(key, next);
    return next;
};

export const selectWorkspace = (id: string): void => {
    if (id !== "local" && !connections().items.has(id)) throw new Error("Workspace is not open");
    connections().active = id;
};

/** Self-contained because the page renderer also embeds this in inline event handlers. */
export function workspaceFetch(
    input: string | URL,
    init?: RequestInit,
    id?: string,
): Promise<Response> {
    const state = globalThis.__doocConnections;
    const connection = state?.items.get(id ?? state.active);
    return connection ? connection.fetch(input, init) : fetch(input, init);
}
