import type { WorkspaceOps } from "../../workspace/src/server.js";
import { terminal } from "./terminal.js";

export const logHttpOperation = (
    method: string,
    url: string,
    status: number,
    body?: unknown,
): void => {
    const path = url.split(/[?#]/)[0] ?? "/";
    if (
        method !== "POST" ||
        !path.startsWith("/api/") ||
        ["/api/render", "/api/lint", "/api/code-tool"].includes(path)
    )
        return;
    if (path === "/api/textfile" && typeof body === "string") {
        try {
            if (["read", "preview", "validate"].includes(JSON.parse(body)?.action)) return;
        } catch {
            // Invalid requests still report their HTTP status.
        }
    }
    terminal.operation(`${method} ${path}`, `HTTP ${status}`);
};

/** Log actions without printing document bodies, credentials, or commit messages. */
export const loggedWorkspaceOps = <Session>(ops: WorkspaceOps<Session>): WorkspaceOps<Session> =>
    Object.fromEntries(
        Object.entries(ops).map(([name, operation]) => [
            name,
            async (input: Record<string, unknown>, session: Session) => {
                const action = typeof input.action === "string" ? input.action : "";
                const visible =
                    ["files", "git", "history", "workspaces"].includes(name) &&
                    !["read", "list", "complete", "diff", "branches", "contribute"].includes(
                        action,
                    );
                try {
                    const result = await operation(input, session);
                    if (name === "http" && result && typeof result === "object") {
                        const status = (result as { status?: unknown }).status;
                        if (typeof status === "number")
                            logHttpOperation(
                                String(input.method),
                                String(input.url),
                                status,
                                input.body,
                            );
                    } else if (visible) {
                        const detail = input.file ?? input.branch;
                        terminal.operation(
                            `${name} ${action}`,
                            typeof detail === "string" ? detail : undefined,
                        );
                    }
                    return result;
                } catch (error) {
                    if (visible || name === "http") terminal.warn(`${name} operation failed`);
                    throw error;
                }
            },
        ]),
    );
