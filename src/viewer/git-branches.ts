import { confirmDialog, showNotice } from "./edit-dialog.js";
import type { GitState } from "./git-types.js";
import { t } from "./i18n.js";

export const gitRequest = async (input: Record<string, unknown>) => {
    const response = await fetch("/api/git", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || t("Git operation failed"));
    return data;
};

export const confirmBranchSwitch = async (state: GitState, branch: string): Promise<boolean> => {
    if (branch === state.branch) return false;
    if (!state.changes.length) return true;
    if (state.stash) {
        await showNotice(
            t("Stash is occupied. Commit the current changes before switching branches."),
        );
        return false;
    }
    return confirmDialog(
        t("Stash saved changes and switch to {branch}?", { branch }),
        t("Stash and switch"),
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
