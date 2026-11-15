declare global {
    var __doocClientBase: string | undefined;
}

export const clientPath = (path: string): string =>
    path.startsWith("/") && !path.startsWith("//")
        ? `${globalThis.__doocClientBase ?? ""}${path}`
        : path;

export const workspacePath = (path: string): string => {
    const base = globalThis.__doocClientBase;
    return base && (path === base || path.startsWith(`${base}/`))
        ? path.slice(base.length) || "/"
        : path;
};
