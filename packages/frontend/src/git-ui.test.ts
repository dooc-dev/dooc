import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitState } from "../../workspace/src/git-types.js";

const workspaces = vi.hoisted(() => ({
    active: "a",
    clients: new Map<string, { request: ReturnType<typeof vi.fn> }>(),
    updateLocation: vi.fn(),
    openBranch: vi.fn(),
}));
vi.mock("../../workspace/src/client.js", () => ({
    pageWorkspace: (id: string) => workspaces.clients.get(id),
}));
vi.mock("../../workspace/src/connection.js", () => ({
    workspaceId: () => workspaces.active,
}));
vi.mock("./git-branches.js", () => ({
    openWorkspaceBranch: workspaces.openBranch,
    updateWorkspaceLocation: workspaces.updateLocation,
}));
vi.mock("./edit-dialog.js", () => ({ confirmDialog: async () => true }));
vi.mock("./i18n.js", () => ({ t: (value: string) => value }));

class Node extends EventTarget {
    dataset: Record<string, string> = {};
    attributes = new Map<string, string>();
    children: Node[] = [];
    parent?: Node;
    className = "";
    id = "";
    textContent = "";
    value = "";
    hidden = false;
    disabled = false;
    open = false;
    onclick?: (event: Event) => void;
    oninput?: (event: Event) => void;
    onchange?: (event: Event) => void;
    onsubmit?: (event: Event) => void;
    focus = vi.fn();
    constructor(readonly tag: string) {
        super();
    }
    setAttribute(key: string, value: string) {
        this.attributes.set(key, value);
    }
    removeAttribute(key: string) {
        this.attributes.delete(key);
    }
    append(...nodes: Node[]) {
        for (const node of nodes) {
            node.parent = this;
            this.children.push(node);
        }
    }
    replaceChildren(...nodes: Node[]) {
        this.children = [];
        this.append(...nodes);
    }
    all(): Node[] {
        return this.children.flatMap((node) => [node, ...node.all()]);
    }
    matches(selector: string): boolean {
        if (selector.startsWith("#")) return this.id === selector.slice(1);
        if (selector.startsWith(".")) return this.className.split(" ").includes(selector.slice(1));
        return this.tag === selector;
    }
    querySelectorAll(selector: string): Node[] {
        const [ancestor, descendant] = selector.split(" ");
        if (descendant)
            return this.all()
                .filter((node) => node.matches(ancestor ?? ""))
                .flatMap((node) => node.querySelectorAll(descendant));
        return this.all().filter((node) => node.matches(selector));
    }
    querySelector(selector: string): Node | undefined {
        return this.querySelectorAll(selector)[0];
    }
    closest(): undefined {
        return undefined;
    }
}
class Textarea extends Node {}

let host: Node;
const state = (): GitState => ({
    repo: "docs",
    branch: "main",
    head: "a".repeat(40),
    version: "revision",
    branches: ["main", "feature"],
    changes: [{ path: "guide.md", index: "M", worktree: " " }],
    upstream: "origin/main",
    ahead: 1,
    behind: 0,
    origin: {
        name: "GitHub",
        url: "https://github.com/example/docs",
        defaultBranch: "main",
        capabilities: ["fetch", "pull", "push", "createPr", "updatePr", "mergePr"],
        pullRequests: [
            {
                number: 7,
                title: "Existing PR",
                body: "Original body",
                url: "https://github.com/example/docs/pull/7",
                head: "feature",
                base: "main",
                headCommit: "b".repeat(40),
                draft: true,
                status: "REVIEW_REQUIRED",
            },
        ],
    },
});
const provider = (id: string, value = state()) => {
    const request = vi.fn(async (_op: string, input: Record<string, unknown>) =>
        input.action === "read" ? value : { ok: true },
    );
    workspaces.clients.set(id, { request });
    return { request, state: value };
};
const button = (label: string): Node => {
    const node = host.all().find((node) => node.attributes.get("aria-label") === label);
    expect(node).toBeDefined();
    return node as Node;
};
const field = (label: string, index = 0): Node => {
    const wrapper = host.all().filter((node) => node.tag === "label" && node.textContent === label)[
        index
    ];
    expect(wrapper).toBeDefined();
    return wrapper?.children[0] as Node;
};
const type = (node: Node, value: string) => {
    node.value = value;
    node.oninput?.(new Event("input"));
};
const mount = async () => {
    host = new Node("div");
    const { mountGit } = await import("./git-ui.js");
    const dispose = mountGit();
    await vi.waitFor(() => expect(host.querySelector(".git-commit")).toBeDefined());
    return dispose;
};

beforeEach(() => {
    vi.resetModules();
    workspaces.active = "a";
    workspaces.clients.clear();
    workspaces.updateLocation.mockClear();
    workspaces.openBranch.mockReset();
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("HTMLTextAreaElement", Textarea);
    vi.stubGlobal(
        "document",
        Object.assign(new EventTarget(), {
            getElementById: () => host,
            createElement: (tag: string) =>
                tag === "textarea" ? new Textarea(tag) : new Node(tag),
            createTextNode: (text: string) =>
                Object.assign(new Node("text"), { textContent: text }),
        }),
    );
});
afterEach(() => vi.unstubAllGlobals());

it("keeps commit, branch and PR drafts separate by workspace and branch", async () => {
    const a = provider("a");
    provider("b");
    let dispose = await mount();
    type(field("Commit message"), "Commit A");
    type(button("New branch"), "branch-a");
    type(field("Title", 1), "PR draft A");
    dispose?.();

    workspaces.active = "b";
    dispose = await mount();
    expect(field("Commit message").value).toBe("");
    expect(button("New branch").value).toBe("");
    expect(field("Title", 1).value).toBe("Existing PR");
    type(field("Commit message"), "Commit B");
    dispose?.();

    workspaces.active = "a";
    a.state.branch = "feature";
    dispose = await mount();
    expect(field("Commit message").value).toBe("");
    expect(button("New branch").value).toBe("");
    expect(field("Title", 1).value).toBe("Existing PR");
    dispose?.();

    a.state.branch = "main";
    dispose = await mount();
    expect(field("Commit message").value).toBe("Commit A");
    expect(button("New branch").value).toBe("branch-a");
    expect(field("Title", 1).value).toBe("PR draft A");
    dispose?.();
});

it("keeps an in-flight action and its refresh on the mounted workspace", async () => {
    const a = provider("a");
    const b = provider("b");
    const dispose = await mount();
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
        complete = resolve;
    });
    a.request.mockImplementation(async (_op, input) => {
        if (input.action === "commit") await pending;
        return input.action === "read" ? a.state : { ok: true };
    });
    type(field("Commit message"), "Commit to A");
    host.querySelector(".git-commit")?.onsubmit?.(new Event("submit"));
    expect(a.request).toHaveBeenLastCalledWith("git", {
        action: "commit",
        message: "Commit to A",
        version: "revision",
    });
    workspaces.active = "b";
    complete();
    await vi.waitFor(() => expect(a.request).toHaveBeenCalledTimes(3));
    expect(b.request).not.toHaveBeenCalled();
    expect(workspaces.updateLocation).toHaveBeenCalledTimes(1);
    dispose?.();
});

it("keeps two mounted pane views bound to separate workspaces", async () => {
    const a = provider("a");
    const b = provider("b");
    const disposeA = await mount();
    type(field("Commit message"), "Commit from pane A");
    const firstHost = host;
    workspaces.active = "b";
    const disposeB = await mount();
    type(field("Commit message"), "Draft in pane B");

    firstHost.querySelector(".git-commit")?.onsubmit?.(new Event("submit"));
    await vi.waitFor(() => expect(a.request).toHaveBeenCalledTimes(3));
    expect(a.request).toHaveBeenCalledWith("git", {
        action: "commit",
        message: "Commit from pane A",
        version: "revision",
    });
    expect(b.request).toHaveBeenCalledTimes(1);
    expect(field("Commit message").value).toBe("Draft in pane B");
    disposeA?.();
    disposeB?.();
});

it("makes PR creation discoverable and shows PR status without expanding a row", async () => {
    provider("a");
    const dispose = await mount();
    const create = button("Create pull request");
    expect(create.parent?.className).toBe("git-toolbar");
    create.onclick?.(new Event("click"));
    const panels = host.all().filter((node) => node.tag === "section");
    expect(panels.find((node) => node.attributes.get("aria-label") === "Changes")?.hidden).toBe(
        true,
    );
    expect(
        panels.find((node) => node.attributes.get("aria-label") === "Pull requests")?.hidden,
    ).toBe(false);
    expect(
        panels.find((node) => node.attributes.get("aria-label") === "Synchronization")?.hidden,
    ).toBe(false);
    const status = host.all().find((node) => node.textContent === "Open · Draft · REVIEW_REQUIRED");
    expect(status?.parent?.tag).toBe("summary");
    expect(status?.parent?.parent?.open).toBe(false);
    expect(field("Title").focus).toHaveBeenCalled();
    dispose?.();
});

it("opens an isolated branch workspace without switching the mounted repository", async () => {
    const a = provider("a");
    const dispose = await mount();
    const branch = host.querySelector(".git-branches select");
    if (!branch) throw new Error("Missing branch selector");
    branch.value = "feature";
    branch.onchange?.(new Event("change"));
    await vi.waitFor(() =>
        expect(workspaces.openBranch).toHaveBeenCalledWith("feature", false, "a", undefined),
    );
    expect(a.request).toHaveBeenCalledTimes(1);
    dispose?.();
});

it("shows merged PRs without merge actions and hides unsupported stash controls", async () => {
    const value = state();
    value.localCapabilities = ["stage", "unstage", "commit"];
    const pr = value.origin?.pullRequests[0];
    if (pr) pr.state = "merged";
    provider("a", value);
    const dispose = await mount();
    expect(host.querySelector(".git-stash")).toBeUndefined();
    expect(host.all().find((node) => node.attributes.get("aria-label") === "Save")?.disabled).toBe(
        true,
    );
    expect(host.all().some((node) => node.textContent === "Merged · REVIEW_REQUIRED")).toBe(true);
    expect(
        host.all().some((node) => node.attributes.get("aria-label") === "Merge pull request"),
    ).toBe(false);
    dispose?.();
});
