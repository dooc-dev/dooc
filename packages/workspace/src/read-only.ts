export const assertReadOnlyOperation = (
    name: string,
    input: Record<string, unknown>,
    editor = false,
): void => {
    if (editor && name === "http" && input.method === "POST" && typeof input.url === "string") {
        const path = new URL(input.url, "http://workspace").pathname;
        if (path === "/api/render") return;
        if (path === "/api/textfile" && typeof input.body === "string") {
            const body = JSON.parse(input.body);
            if (body?.action === "read" || body?.action === "preview") return;
        }
    }
    if (
        (name === "http" && input.method === "GET") ||
        (name === "files" && ["read", "complete"].includes(String(input.action))) ||
        (name === "workspaces" && input.action === "list") ||
        (name === "versions" && ["list", "open"].includes(String(input.action))) ||
        (name === "extensions" && ["list", "read"].includes(String(input.action))) ||
        (name === "plugins" &&
            ["resolve", "status", "read", "actions", "connect", "disconnect"].includes(
                String(input.action),
            ))
    )
        return;
    throw new Error("This workspace is read-only");
};
