import { workspaceHttp } from "./application-transport.js";
import {
    createWorkspaceClient,
    pageWorkspace,
    type WorkspaceClient,
    webSocketPort,
} from "./client.js";
import {
    openBranchWorkspace,
    registerWorkspace,
    type WorkspaceConnection,
    workspaceConnection,
    workspaceConnections,
    workspaceId,
} from "./connection.js";

interface ServerWorkspace {
    id: string;
    label: string;
    branch?: string;
    readOnly?: boolean;
    revision?: WorkspaceConnection["revision"];
}

const serverConnections = new Map<string, WorkspaceClient>();
const socketUrl = (value: string) => {
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
        throw new Error("Enter a ws:// or wss:// workspace address without credentials");
    if (url.pathname === "/") url.pathname = "/server";
    return url.href;
};

const localViewerUrl =
    typeof document !== "undefined" &&
    document.getElementById("boot") &&
    workspaceId() === "local" &&
    typeof location !== "undefined"
        ? socketUrl(`${location.origin}/api/workspace`)
        : undefined;

export async function connectServer(
    value: string,
    local = false,
    readOnly = false,
): Promise<WorkspaceConnection> {
    const url = socketUrl(value);
    local ||= url === localViewerUrl;
    let client = serverConnections.get(url);
    if (!client) {
        client = local ? pageWorkspace("local") : createWorkspaceClient(webSocketPort(url));
        serverConnections.set(url, client);
    }
    if (readOnly && !(await client.request<{ readOnly?: boolean }>("hello")).readOnly)
        throw new Error("Connect to a read-only workspace server");
    const all = await client.request<ServerWorkspace[]>("workspaces", {
        action: "list",
    });
    const shared = client;
    const attached = local || workspaceConnection("local")?.family === url;
    const bind = (info: ServerWorkspace): WorkspaceConnection => {
        const id = attached && info.id === "main" ? "local" : `${url}#${info.id}`;
        const found = workspaceConnections().find((item) => item.id === id);
        if (found) return found;
        const scoped: WorkspaceClient = {
            request: (op, args) => shared.request(op, { ...args, workspace: info.id }),
            on: (event, handler) =>
                shared.on(event, (data) => {
                    if (
                        !data ||
                        typeof data !== "object" ||
                        !("workspace" in data) ||
                        data.workspace === info.id
                    )
                        handler(data);
                }),
            opened: (handler) => shared.opened(handler),
        };
        const connection: WorkspaceConnection = {
            id,
            label: info.label,
            family: url,
            branch: info.branch,
            readOnly: readOnly || info.readOnly,
            revision: info.revision,
            client: id === "local" ? shared : scoped,
            fetch: id === "local" ? (input, init) => fetch(input, init) : workspaceHttp(scoped),
            openVersion: async (version) =>
                bind(await scoped.request("versions", { action: "open", version })),
            openBranch:
                !readOnly && !info.readOnly && info.branch
                    ? (branch, create = false) =>
                          openBranchWorkspace(url, branch, create, async () =>
                              bind(
                                  await scoped.request("workspaces", {
                                      action: "branch",
                                      branch,
                                      create,
                                  }),
                              ),
                          )
                    : undefined,
        };
        registerWorkspace(connection);
        return connection;
    };
    if (!all.length) throw new Error("Server has no open workspaces");
    const connections = all.map(bind);
    localStorage.setItem("dooc.client.server", url);
    const first = connections[0];
    if (!first) throw new Error("Server has no open workspaces");
    return first;
}
