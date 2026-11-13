import { afterEach, expect, it, vi } from "vitest";
import { pageWorkspace } from "./client.js";
import {
    openBranchWorkspace,
    registerWorkspace,
    selectWorkspace,
    type WorkspaceConnection,
    workspaceFetch,
    workspaceId,
} from "./connection.js";

afterEach(() => {
    globalThis.__doocConnections = undefined;
    vi.unstubAllGlobals();
});

it("keeps a request bound to its workspace when the active pane changes", async () => {
    const left = { request: vi.fn(), on: vi.fn(), opened: vi.fn() };
    const right = { request: vi.fn(), on: vi.fn(), opened: vi.fn() };
    const leftFetch = vi.fn().mockResolvedValue(new Response("left"));
    const rightFetch = vi.fn().mockResolvedValue(new Response("right"));
    registerWorkspace({ id: "left", label: "main", client: left, fetch: leftFetch });
    registerWorkspace({ id: "right", label: "feature", client: right, fetch: rightFetch });
    selectWorkspace("left");
    const selected = pageWorkspace();
    const pending = workspaceFetch("/api/save", { method: "POST" });
    selectWorkspace("right");
    expect(selected).toBe(left);
    expect(pageWorkspace()).toBe(right);
    expect(await (await pending).text()).toBe("left");
    await workspaceFetch("/api/page", undefined, "left");
    expect(leftFetch).toHaveBeenCalledTimes(2);
    expect(rightFetch).not.toHaveBeenCalled();
    expect(workspaceId()).toBe("right");
    expect(() => selectWorkspace("missing")).toThrow("not open");
    expect(() => pageWorkspace("missing")).toThrow("not open");
});

it("preserves same-origin requests for the combined local viewer", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("local"));
    vi.stubGlobal("fetch", fetch);
    await workspaceFetch("/api/page");
    expect(fetch).toHaveBeenCalledWith("/api/page", undefined);
});

const branchConnection = (branch: string): WorkspaceConnection => ({
    id: `folder-${branch}`,
    label: `${branch}/Documents`,
    family: "picked-folder",
    branch,
    client: { request: vi.fn(), on: vi.fn(), opened: vi.fn() },
    fetch: vi.fn(),
});

it("reuses the original local-folder branch without a saved chooser entry", async () => {
    const original = branchConnection("main");
    registerWorkspace(original);
    const reopen = vi.fn();
    expect(await openBranchWorkspace("picked-folder", "main", false, reopen)).toBe(original);
    await expect(openBranchWorkspace("picked-folder", "main", true, reopen)).rejects.toThrow(
        "already has a workspace",
    );
    expect(reopen).not.toHaveBeenCalled();
});

it("shares a pending branch open but rejects duplicate creation", async () => {
    const connection = branchConnection("feature");
    let complete!: () => void;
    const open = vi.fn(
        () =>
            new Promise<WorkspaceConnection>((resolve) => {
                complete = () => {
                    registerWorkspace(connection);
                    resolve(connection);
                };
            }),
    );
    const first = openBranchWorkspace("picked-folder", "feature", true, open);
    const second = openBranchWorkspace("picked-folder", "feature", false, open);
    await expect(openBranchWorkspace("picked-folder", "feature", true, open)).rejects.toThrow(
        "already has a workspace",
    );
    complete();
    expect(await first).toBe(connection);
    expect(await second).toBe(connection);
    expect(open).toHaveBeenCalledTimes(1);
});

it("allows retrying a branch after opening fails", async () => {
    const open = vi.fn().mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(openBranchWorkspace("picked-folder", "feature", false, open)).rejects.toThrow(
        "Storage unavailable",
    );
    const connection = branchConnection("feature");
    open.mockResolvedValueOnce(connection);
    expect(await openBranchWorkspace("picked-folder", "feature", false, open)).toBe(connection);
    expect(open).toHaveBeenCalledTimes(2);
});
