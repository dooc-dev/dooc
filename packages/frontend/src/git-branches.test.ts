import { afterEach, expect, it, vi } from "vitest";
import type { WorkspaceConnection } from "../../workspace/src/connection.js";
import { openWorkspaceBranch } from "./git-branches.js";

vi.mock("./i18n.js", () => ({ t: (value: string) => value }));
afterEach(() => vi.unstubAllGlobals());

it("opens the requested branch through its original connection and selects the originating pane", async () => {
    let complete!: (connection: WorkspaceConnection) => void;
    const openBranch = vi.fn(
        () =>
            new Promise<WorkspaceConnection>((resolve) => {
                complete = resolve;
            }),
    );
    const connection = { id: "a", openBranch } as unknown as WorkspaceConnection;
    const selection = vi.fn();
    const document = new EventTarget();
    document.addEventListener("dooc:select-workspace", (event) =>
        selection((event as CustomEvent).detail),
    );
    vi.stubGlobal("document", document);
    vi.stubGlobal("__doocConnections", { active: "a", items: new Map([["a", connection]]) });

    const opening = openWorkspaceBranch("feature", true, "a", "0");
    if (globalThis.__doocConnections) globalThis.__doocConnections.active = "b";
    complete({ id: "a-feature" } as WorkspaceConnection);
    await opening;

    expect(openBranch).toHaveBeenCalledWith("feature", true);
    expect(selection).toHaveBeenCalledWith({ id: "a-feature", from: "a", pane: "0" });
});

it("does not mutate a repository that cannot open an isolated branch workspace", async () => {
    vi.stubGlobal("__doocConnections", { active: "missing", items: new Map() });
    await expect(openWorkspaceBranch("feature")).rejects.toThrow(
        "Open a workspace to switch branches.",
    );
});

it("opens a saved sibling branch from its source while keeping the originating pane", async () => {
    const openBranch = vi.fn(async () => ({ id: "saved-feature" }));
    const selection = vi.fn();
    const document = new EventTarget();
    document.addEventListener("dooc:select-workspace", (event) =>
        selection((event as CustomEvent).detail),
    );
    vi.stubGlobal("document", document);
    vi.stubGlobal("__doocConnections", {
        active: "main",
        items: new Map([["sibling", { id: "sibling", openBranch }]]),
    });

    await openWorkspaceBranch("saved/feature", false, "main", "0", "sibling");

    expect(openBranch).toHaveBeenCalledWith("saved/feature", false);
    expect(selection).toHaveBeenCalledWith({ id: "saved-feature", from: "main", pane: "0" });
});
