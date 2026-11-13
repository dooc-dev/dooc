export interface GitWorkspace {
    protocol: "git";
    branch: string;
    repo?: string;
}

export interface StorageWorkspace {
    protocol: "storage";
    folder: string;
    service: string;
    /** Service-owned SVG source, rendered as an image rather than inline markup. */
    icon?: string;
}

export type WorkspaceSource = GitWorkspace | StorageWorkspace;

export const workspaceLabel = (workspace: WorkspaceSource): string =>
    workspace.protocol === "git" ? workspace.branch : `${workspace.folder} / ${workspace.service}`;

export const parseWorkspaceSource = (value: unknown): WorkspaceSource => {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Workspace must be an object");
    const source = value as Record<string, unknown>;
    const text = (value: unknown): value is string =>
        typeof value === "string" &&
        value.trim().length > 0 &&
        [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
    if (
        source.protocol === "git" &&
        text(source.branch) &&
        (source.repo === undefined || text(source.repo))
    )
        return {
            protocol: "git",
            branch: source.branch,
            ...(source.repo === undefined ? {} : { repo: source.repo }),
        };
    if (
        source.protocol === "storage" &&
        text(source.folder) &&
        text(source.service) &&
        (source.icon === undefined || typeof source.icon === "string")
    )
        return {
            protocol: "storage",
            folder: source.folder,
            service: source.service,
            ...(source.icon === undefined ? {} : { icon: source.icon }),
        };
    throw new Error("Workspace requires a Git branch or a storage folder and service");
};
