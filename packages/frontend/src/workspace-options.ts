import { pageWorkspace } from "../../workspace/src/client.js";
import { workspaceConnections } from "../../workspace/src/connection.js";
import type { GitState } from "../../workspace/src/git-types.js";

export interface WorkspaceOption {
    id: string;
    label: string;
    branch?: string;
    workspace?: string;
    change?: "added" | "modified" | "deleted";
    missingManifest?: string;
    create?: boolean;
}

export const readWorkspaceOptions = async (
    workspace: string,
    localLabel?: string,
): Promise<WorkspaceOption[]> => {
    const connections = workspaceConnections();
    const options: WorkspaceOption[] = connections.map(({ id, label }) => ({ id, label }));
    if (localLabel !== undefined && !options.some(({ id }) => id === "local"))
        options.unshift({ id: "local", label: localLabel });
    if (!options.some(({ id }) => id === workspace))
        options.unshift({ id: workspace, label: workspace });
    const reads = await Promise.allSettled(
        options.map(async ({ id }) =>
            pageWorkspace(id).request<GitState>("git", { action: "branches" }),
        ),
    );
    const states = new Map<string, GitState>();
    for (const [index, result] of reads.entries()) {
        const option = options[index];
        if (!option || result.status !== "fulfilled") continue;
        const state = result.value;
        states.set(option.id, state);
        if (state.branchWorkspaces?.unavailable.includes(state.branch))
            option.missingManifest = state.branchWorkspaces.manifest;
        if (state.changes.length)
            option.change = state.changes.some(({ index, worktree }) =>
                /[A?]/.test(index + worktree),
            )
                ? "added"
                : state.changes.every(({ index, worktree }) => /^[ D]+$/.test(index + worktree))
                  ? "deleted"
                  : "modified";
    }
    const family = connections.find(({ id }) => id === workspace)?.family;
    const related = connections.filter(
        (connection) =>
            connection.id === workspace || (family !== undefined && connection.family === family),
    );
    const sources = new Set([workspace, ...related.map(({ id }) => id)]);
    const opened = new Set([
        ...related.flatMap(({ branch }) => (branch ? [branch] : [])),
        ...[...sources].flatMap((id) => states.get(id)?.branch || []),
    ]);
    for (const id of sources) {
        const state = states.get(id);
        if (!state) continue;
        const saved = related.find((connection) => connection.id === id)?.branches ?? [];
        for (const branch of new Set([...state.branches, ...saved])) {
            if (!branch) continue;
            const missingManifest =
                !saved.includes(branch) && state.branchWorkspaces?.unavailable.includes(branch)
                    ? state.branchWorkspaces.manifest
                    : undefined;
            if (opened.has(branch)) {
                const option = options.find((option) => option.branch === branch);
                if (option?.missingManifest && !missingManifest) {
                    delete option.missingManifest;
                    option.workspace = id;
                }
                continue;
            }
            opened.add(branch);
            options.push({
                id: JSON.stringify(["branch", family ?? workspace, branch]),
                label: `${branch}/${state.repo}`,
                branch,
                workspace: id,
                ...(missingManifest ? { missingManifest } : {}),
            });
        }
    }
    const current = states.get(workspace)?.branchWorkspaces;
    if (current)
        options.push({
            id: JSON.stringify(["create", workspace]),
            label: "Create branch",
            create: true,
            workspace,
            ...(!current.canCreate ? { missingManifest: current.manifest } : {}),
        });
    return options;
};
