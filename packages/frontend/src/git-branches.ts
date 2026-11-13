import { workspaceConnection, workspaceId } from "../../workspace/src/connection.js";
import type { GitState } from "../../workspace/src/git-types.js";
import { connectServer } from "../../workspace/src/socket-connection.js";
import { t } from "./i18n.js";

export const openWorkspaceBranch = async (
    branch: string,
    create = false,
    workspace = workspaceId(),
    pane?: string,
    source = workspace,
): Promise<void> => {
    const connection =
        workspaceConnection(source) ??
        (source === "local"
            ? await connectServer(
                  `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/workspace`,
                  true,
              )
            : undefined);
    if (!connection?.openBranch) throw new Error(t("Open a workspace to switch branches."));
    const next = await connection.openBranch(branch, create);
    document.dispatchEvent(
        new CustomEvent("dooc:select-workspace", {
            detail: { id: next.id, from: workspace, pane },
        }),
    );
};

export const updateWorkspaceLocation = (state: GitState): void => {
    const location = document.querySelector<HTMLElement>(
        '.workspace-location[data-workspace-protocol="git"]',
    );
    const repo = location?.querySelector(".git-repo-name");
    const branch = location?.querySelector(".git-branch-caption");
    const caption = `[${state.branch || state.head.slice(0, 7)}]`;
    if (branch) branch.textContent = caption;
    if (location) location.title = `${repo?.textContent ?? state.repo}${caption}`;
};
