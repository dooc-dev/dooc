import { afterEach, expect, it, vi } from "vitest";
import { mountExtensions } from "./extensions-ui.js";

const browser = vi.hoisted(() => vi.fn(async (scope: string) => ({ scope, items: [] })));
vi.mock("./extensions-store.js", () => ({ browserExtensionRequest: browser }));
vi.mock("./i18n.js", () => ({ t: (value: string) => value }));
afterEach(() => {
    vi.unstubAllGlobals();
    browser.mockClear();
});

it("keeps unsupported extension requests in separate browser storage without calling server routes", async () => {
    const request = vi.fn(async () => ({ ops: ["http", "files", "git"] }));
    const fetch = vi.fn();
    vi.stubGlobal("__doocConnections", {
        active: "a",
        items: new Map([
            ["a", { client: { request }, fetch }],
            ["b", { client: { request }, fetch }],
        ]),
    });
    vi.stubGlobal("location", { hostname: "localhost", pathname: "/guide" });
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal(
        "document",
        Object.assign(new EventTarget(), {
            body: {},
            getElementById: (id: string) =>
                id === "nav-extensions" ? { dataset: { scope: "repo" }, setAttribute() {} } : null,
            querySelector: () => null,
            createElement: () =>
                Object.assign(new EventTarget(), { dataset: {}, setAttribute() {} }),
        }),
    );
    vi.stubGlobal(
        "MutationObserver",
        class {
            observe() {}
        },
    );
    mountExtensions();
    await vi.waitFor(() => expect(browser).toHaveBeenCalledWith("a:repo", { action: "list" }));
    if (globalThis.__doocConnections) globalThis.__doocConnections.active = "b";
    document.dispatchEvent(new Event("dooc:workspace-changed"));
    await vi.waitFor(() => expect(browser).toHaveBeenCalledWith("b:repo", { action: "list" }));
    expect(fetch).not.toHaveBeenCalled();
    expect(request.mock.calls).toEqual([["hello"], ["hello"]]);
});
