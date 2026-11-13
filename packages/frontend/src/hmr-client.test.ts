import { afterEach, expect, it, vi } from "vitest";
import { mountHmr } from "./hmr-client.js";

const workspace = vi.hoisted(() => ({
    hello: { boot: "boot-1" },
    opened: () => {},
    change: (_data: unknown) => {},
}));
vi.mock("../../workspace/src/client.js", () => ({
    pageWorkspace: () => ({
        request: async () => workspace.hello,
        opened: (handler: () => void) => {
            workspace.opened = handler;
        },
        on: (_event: string, handler: (data: unknown) => void) => {
            workspace.change = handler;
        },
    }),
}));
afterEach(() => vi.unstubAllGlobals());

const mount = (mode: "preview" | "edit") => {
    const reload = vi.fn();
    const window: {
        __docsHmr?: { setDirty(v: boolean): void; onContent?(files: string[]): void };
    } = {};
    const badge = { style: {}, addEventListener: vi.fn() };
    const append = vi.fn();
    vi.stubGlobal("window", window);
    vi.stubGlobal("location", { reload });
    vi.stubGlobal("__doocConnections", { active: "a", items: new Map() });
    vi.stubGlobal(
        "document",
        Object.assign(new EventTarget(), {
            createElement: () => badge,
            body: { appendChild: append },
        }),
    );
    mountHmr(mode);
    const connect = async (boot: string) => {
        workspace.hello = { boot };
        workspace.opened();
        await Promise.resolve();
    };
    return { reload, window, append, connect };
};

it.each([
    "edit",
    "preview",
] as const)("%s: a changed client bundle and a restarted server reload the page", async (mode) => {
    const { reload, connect } = mount(mode);
    await connect("boot-1");
    // Reconnecting to the same process is not a restart.
    await connect("boot-1");
    expect(reload).not.toHaveBeenCalled();
    workspace.change({ kind: "client", files: ["src/viewer/ui-client.ts"] });
    expect(reload).toHaveBeenCalledTimes(1);
    await connect("boot-2");
    expect(reload).toHaveBeenCalledTimes(2);
});

it("applies content events only from the selected workspace", () => {
    const { window } = mount("edit");
    const original = workspace.change;
    const onContent = vi.fn();
    if (window.__docsHmr) window.__docsHmr.onContent = onContent;
    if (globalThis.__doocConnections) globalThis.__doocConnections.active = "b";
    document.dispatchEvent(new Event("dooc:workspace-changed"));
    original({ kind: "content", files: ["content/old.md"] });
    expect(onContent).not.toHaveBeenCalled();
    workspace.change({ kind: "content", files: ["content/new.md"] });
    expect(onContent).toHaveBeenCalledWith(["content/new.md"]);
});

it("edit: content goes to the editor, and a reload waits while there is unsaved text", () => {
    const { reload, window, append } = mount("edit");
    // No editor on this page yet: nothing can apply the change in place.
    workspace.change({ kind: "content", files: ["content/a.md"] });
    expect(reload).toHaveBeenCalledTimes(1);

    const onContent = vi.fn();
    if (window.__docsHmr) window.__docsHmr.onContent = onContent;
    workspace.change({ kind: "content", files: ["content/a.md"] });
    expect(onContent).toHaveBeenCalledWith(["content/a.md"]);
    expect(reload).toHaveBeenCalledTimes(1);

    window.__docsHmr?.setDirty(true);
    workspace.change({ kind: "client", files: [] });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(1);
    window.__docsHmr?.setDirty(false);
    expect(reload).toHaveBeenCalledTimes(2);
});
