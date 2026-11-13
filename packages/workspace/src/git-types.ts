export interface GitContext {
    root: string;
    branch: string;
    head: string;
}

export interface GitPullRequest {
    number: number;
    title: string;
    body: string;
    url: string;
    head: string;
    base: string;
    headCommit: string;
    draft: boolean;
    status: string;
    state?: "open" | "closed" | "merged";
}

export interface GitOriginState {
    url: string;
    defaultBranch: string;
    pullRequests: GitPullRequest[];
}

export type GitOriginAction =
    | { action: "fetch" | "pull" | "push" }
    | { action: "createPr"; title: string; body: string; base: string; draft: boolean }
    | { action: "updatePr"; number: number; title: string; body: string; previous: GitPullRequest }
    | {
          action: "mergePr";
          number: number;
          method: "merge" | "squash" | "rebase";
          previous: GitPullRequest;
      };

/** Injected by the host, never by dooc.yaml. The host owns credentials and remote policy. */
export interface GitOrigin {
    name: string;
    capabilities: readonly GitOriginAction["action"][];
    read(context: GitContext): Promise<GitOriginState>;
    execute(context: GitContext, request: GitOriginAction): Promise<void>;
}

export interface GitChange {
    path: string;
    index: string;
    worktree: string;
}

export interface GitState {
    repo: string;
    branch: string;
    head: string;
    version: string;
    branches: string[];
    branchWorkspaces?: { manifest: string; unavailable: string[]; canCreate: boolean };
    changes: GitChange[];
    localCapabilities?: string[];
    stash?: { id: string; label: string };
    upstream: string;
    ahead: number;
    behind: number;
    origin?: GitOriginState & { name: string; capabilities: readonly GitOriginAction["action"][] };
    originError?: string;
}
