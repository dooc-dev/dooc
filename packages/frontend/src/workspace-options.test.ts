import { beforeEach, expect, it, vi } from "vitest";
import { pageWorkspace } from "../../workspace/src/client.js";
import { type WorkspaceConnection, workspaceConnections } from "../../workspace/src/connection.js";
import type { GitChange, GitState } from "../../workspace/src/git-types.js";
import { readWorkspaceOptions } from "./workspace-options.js";

vi.mock("../../workspace/src/client.js", () => ({ pageWorkspace: vi.fn() }));
vi.mock("../../workspace/src/connection.js", () => ({ workspaceConnections: vi.fn() }));

const state = (branch: string, branches: string[], changes: GitChange[] = []): GitState => ({
    repo: "docs",
    branch,
    branches,
    changes,
    head: "head",
    version: "version",
    upstream: "",
    ahead: 0,
    behind: 0,
});
const connection = (id: string, family?: string, branch?: string): WorkspaceConnection => ({
    id,
    label: `Full ${id} label`,
    family,
    branch,
    client: { request: vi.fn(), on: vi.fn(), opened: vi.fn() },
    fetch: vi.fn(),
});
const clients = new Map<string, WorkspaceConnection["client"]>();
const provide = (id: string, value: GitState | Error) => {
    const request =
        value instanceof Error
            ? vi.fn().mockRejectedValue(value)
            : vi.fn().mockResolvedValue(value);
    clients.set(id, { request, on: vi.fn(), opened: vi.fn() });
    return request;
};
beforeEach(() => {
    clients.clear();
    vi.mocked(workspaceConnections).mockReturnValue([]);
    vi.mocked(pageWorkspace).mockImplementation((id) => {
        const client = clients.get(id ?? "local");
        if (!client) throw new Error("Workspace is not open");
        return client;
    });
});

it("unions branch refs within the active family and opens them from a worker that has the ref", async () => {
    vi.mocked(workspaceConnections).mockReturnValue([
        connection("main", "repo-a", "main"),
        connection("feature", "repo-a", "feature"),
        connection("offline", "repo-a", "offline"),
        connection("other", "repo-b", "main"),
    ]);
    const readMain = provide("main", state("main", ["main", "feature", "shared", "offline"]));
    provide("feature", state("feature", ["main", "feature", "shared", "feature/new"]));
    provide("offline", new Error("Disconnected"));
    provide("other", state("main", ["main", "unrelated"]));
    const options = await readWorkspaceOptions("main");
    expect(options.slice(0, 4)).toEqual([
        { id: "main", label: "Full main label" },
        { id: "feature", label: "Full feature label" },
        { id: "offline", label: "Full offline label" },
        { id: "other", label: "Full other label" },
    ]);
    expect(options.filter((option) => option.branch)).toEqual([
        {
            id: JSON.stringify(["branch", "repo-a", "shared"]),
            label: "shared/docs",
            branch: "shared",
            workspace: "main",
        },
        {
            id: JSON.stringify(["branch", "repo-a", "feature/new"]),
            label: "feature/new/docs",
            branch: "feature/new",
            workspace: "feature",
        },
    ]);
    expect(readMain).toHaveBeenCalledWith("git", { action: "branches" });
    const switched = await readWorkspaceOptions("feature");
    expect(switched.find(({ branch }) => branch === "shared")?.id).toBe(options[4]?.id);
});

it("retains an attached local workspace and reads only its branch family", async () => {
    vi.mocked(workspaceConnections).mockReturnValue([connection("remote", "remote", "main")]);
    provide("local", state("feature/slash", ["feature/slash", "local-only"]));
    provide("remote", state("main", ["main", "remote-only"]));
    const options = await readWorkspaceOptions("local", "feature/slash/local-project");
    expect(options).toEqual([
        { id: "local", label: "feature/slash/local-project" },
        { id: "remote", label: "Full remote label" },
        {
            id: JSON.stringify(["branch", "local", "local-only"]),
            label: "local-only/docs",
            branch: "local-only",
            workspace: "local",
        },
    ]);
    const switched = await readWorkspaceOptions("remote", "feature/slash/local-project");
    expect(switched[0]).toEqual(options[0]);
    expect(switched.filter((option) => option.branch).map(({ branch }) => branch)).toEqual([
        "remote-only",
    ]);
});

it("lists saved sibling workspaces even when their refs are absent from the open worker", async () => {
    let savedBranches = ["main"];
    vi.mocked(workspaceConnections).mockReturnValue([
        {
            ...connection("main", "repo-a", "main"),
            get branches() {
                return savedBranches;
            },
        },
    ]);
    provide("main", state("main", ["main"]));
    expect(await readWorkspaceOptions("main")).toEqual([{ id: "main", label: "Full main label" }]);
    savedBranches = ["main", "saved/feature"];
    expect(await readWorkspaceOptions("main")).toEqual([
        { id: "main", label: "Full main label" },
        {
            id: JSON.stringify(["branch", "repo-a", "saved/feature"]),
            label: "saved/feature/docs",
            branch: "saved/feature",
            workspace: "main",
        },
    ]);
});

it("keeps non-Git and unavailable connections and the active fallback", async () => {
    vi.mocked(workspaceConnections).mockReturnValue([connection("folder"), connection("offline")]);
    provide("folder", new Error("Not a Git repository"));
    provide("offline", new Error("Disconnected"));
    expect(await readWorkspaceOptions("missing")).toEqual([
        { id: "missing", label: "missing" },
        { id: "folder", label: "Full folder label" },
        { id: "offline", label: "Full offline label" },
    ]);
});

it("does not duplicate a registered local workspace or combine unknown families", async () => {
    vi.mocked(workspaceConnections).mockReturnValue([connection("local"), connection("other")]);
    provide("local", state("main", ["main", "local-feature"]));
    provide("other", state("main", ["main", "other-feature"]));
    const options = await readWorkspaceOptions("local", "Stale local label");
    expect(options[0]).toEqual({ id: "local", label: "Full local label" });
    expect(options.filter(({ id }) => id === "local")).toHaveLength(1);
    expect(options.filter((option) => option.branch).map(({ branch }) => branch)).toEqual([
        "local-feature",
    ]);
});

it("marks file additions green before modifications and distinguishes deletion-only workspaces", async () => {
    const changes: Record<string, GitChange[]> = {
        added: [{ path: "new.md", index: "A", worktree: "M" }],
        untracked: [
            { path: "old.md", index: "M", worktree: " " },
            { path: "new.md", index: "?", worktree: "?" },
        ],
        modified: [{ path: "edit.md", index: " ", worktree: "M" }],
        deleted: [
            { path: "a.md", index: "D", worktree: " " },
            { path: "b.md", index: " ", worktree: "D" },
        ],
        mixed: [
            { path: "a.md", index: "D", worktree: " " },
            { path: "b.md", index: "M", worktree: " " },
        ],
        clean: [],
    };
    vi.mocked(workspaceConnections).mockReturnValue(
        Object.keys(changes).map((id) => connection(id)),
    );
    for (const [id, files] of Object.entries(changes)) provide(id, state("main", ["main"], files));
    expect(
        Object.fromEntries(
            (await readWorkspaceOptions("clean")).map(({ id, change }) => [id, change]),
        ),
    ).toEqual({
        added: "added",
        untracked: "added",
        modified: "modified",
        deleted: "deleted",
        mixed: "modified",
        clean: undefined,
    });
});

it("marks missing manifests and adds branch creation for the current workspace", async () => {
    vi.mocked(workspaceConnections).mockReturnValue([connection("main", "repo", "main")]);
    provide("main", {
        ...state("main", ["main", "feature", "missing"]),
        branchWorkspaces: {
            manifest: "docs/site.dooc.yaml",
            unavailable: ["missing"],
            canCreate: true,
        },
    });
    const options = await readWorkspaceOptions("main");
    expect(options.find(({ branch }) => branch === "missing")).toMatchObject({
        missingManifest: "docs/site.dooc.yaml",
    });
    expect(options.find(({ branch }) => branch === "feature")?.missingManifest).toBeUndefined();
    expect(options.at(-1)).toEqual({
        id: JSON.stringify(["create", "main"]),
        label: "Create branch",
        create: true,
        workspace: "main",
    });
});

it("keeps saved browser siblings available and blocks creation from an uncommitted manifest", async () => {
    vi.mocked(workspaceConnections).mockReturnValue([
        { ...connection("main", "repo", "main"), branches: ["saved"] },
    ]);
    provide("main", {
        ...state("main", ["main", "saved", "missing"]),
        branchWorkspaces: {
            manifest: "docs/dooc.yaml",
            unavailable: ["saved", "missing"],
            canCreate: false,
        },
    });
    const options = await readWorkspaceOptions("main");
    expect(options.find(({ branch }) => branch === "saved")?.missingManifest).toBeUndefined();
    expect(options.find(({ branch }) => branch === "missing")?.missingManifest).toBe(
        "docs/dooc.yaml",
    );
    expect(options.at(-1)).toMatchObject({
        create: true,
        workspace: "main",
        missingManifest: "docs/dooc.yaml",
    });
});

it("uses a sibling provider that has the manifest when another provider lacks it", async () => {
    vi.mocked(workspaceConnections).mockReturnValue([
        connection("main", "repo", "main"),
        connection("feature", "repo", "feature"),
    ]);
    provide("main", {
        ...state("main", ["main", "shared"]),
        branchWorkspaces: { manifest: "dooc.yaml", unavailable: ["shared"], canCreate: true },
    });
    provide("feature", {
        ...state("feature", ["feature", "shared"]),
        branchWorkspaces: { manifest: "dooc.yaml", unavailable: [], canCreate: true },
    });
    const shared = (await readWorkspaceOptions("main")).filter(({ branch }) => branch === "shared");
    expect(shared).toHaveLength(1);
    expect(shared[0]?.workspace).toBe("feature");
    expect(shared[0]?.missingManifest).toBeUndefined();
});
