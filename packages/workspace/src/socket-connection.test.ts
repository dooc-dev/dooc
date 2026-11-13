import { afterEach, expect, it, vi } from "vitest";
import { workspaceConnections } from "./connection.js";
import { connectServer } from "./socket-connection.js";

const client = vi.hoisted(() => ({ request: vi.fn(), on: vi.fn(), opened: vi.fn() }));
vi.mock("./client.js", () => ({
    createWorkspaceClient: () => client,
    pageWorkspace: () => client,
    webSocketPort: vi.fn(),
}));
afterEach(() => {
    globalThis.__doocConnections = undefined;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

it("reuses the attached local branch and preserves its HTTP transport", async () => {
    vi.stubGlobal("localStorage", { setItem: vi.fn() });
    const fetch = vi.fn().mockResolvedValue(new Response("local"));
    vi.stubGlobal("fetch", fetch);
    client.request.mockImplementation(async (_op, args) => {
        if (args.action === "list") return [{ id: "main", label: "main/docs", branch: "main" }];
        return { id: "worktree", label: "feature/docs", branch: "feature" };
    });

    const main = await connectServer("ws://localhost:5179/api/workspace", true);
    expect(main).toMatchObject({
        id: "local",
        family: "ws://localhost:5179/api/workspace",
        branch: "main",
    });
    expect(main.client).toBe(client);
    await main.fetch("/api/page");
    expect(fetch).toHaveBeenCalledWith("/api/page", undefined);
    const feature = await main.openBranch?.("feature");
    expect(feature?.branch).toBe("feature");
    expect(await feature?.openBranch?.("main")).toBe(main);
    expect(await main.openBranch?.("feature")).toBe(feature);
    await expect(main.openBranch?.("feature", true)).rejects.toThrow("already has a workspace");
    expect(workspaceConnections()).toEqual([main, feature]);
    expect(client.request).toHaveBeenCalledTimes(2);
});

it("keeps storage workspaces available without offering Git branch operations", async () => {
    vi.stubGlobal("localStorage", { setItem: vi.fn() });
    client.request.mockResolvedValue([{ id: "main", label: "Documents" }]);
    const storage = await connectServer("ws://localhost:5181/api/workspace");
    expect(storage).toMatchObject({
        family: "ws://localhost:5181/api/workspace",
        label: "Documents",
    });
    expect(storage.openBranch).toBeUndefined();
});

it("keeps the local draft identity when the chooser connects before branch navigation", async () => {
    vi.stubGlobal("document", { getElementById: () => ({}) });
    vi.stubGlobal("location", { origin: "http://localhost:5182" });
    vi.stubGlobal("localStorage", { setItem: vi.fn() });
    const fetch = vi.fn().mockResolvedValue(new Response("local"));
    vi.stubGlobal("fetch", fetch);
    client.request.mockResolvedValue([{ id: "main", label: "main/docs", branch: "main" }]);
    vi.resetModules();
    const { connectServer } = await import("./socket-connection.js");

    const chosen = await connectServer("http://localhost:5182");
    expect(chosen.id).toBe("local");
    expect(await connectServer("ws://localhost:5182/api/workspace", true)).toBe(chosen);
    expect(workspaceConnections()).toEqual([chosen]);
    await chosen.fetch("/api/save", { method: "POST" });
    expect(fetch).toHaveBeenCalledWith("/api/save", { method: "POST" });
});

it("does not treat a rendered standalone client as the attached local editor", async () => {
    vi.stubGlobal("document", { getElementById: () => ({}) });
    vi.stubGlobal("location", { origin: "http://localhost:5183" });
    vi.stubGlobal("localStorage", { setItem: vi.fn() });
    globalThis.__doocConnections = { active: "browser-workspace", items: new Map() };
    client.request.mockResolvedValue([{ id: "main", label: "main/docs", branch: "main" }]);
    vi.resetModules();
    const { connectServer } = await import("./socket-connection.js");

    const connection = await connectServer("ws://localhost:5183/api/workspace");
    expect(connection.id).toBe("ws://localhost:5183/api/workspace#main");
});
