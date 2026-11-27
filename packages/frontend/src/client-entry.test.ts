import { afterEach, expect, it, vi } from "vitest";
import { connectServer } from "../../workspace/src/socket-connection.js";
import { mountClientHtml } from "./client-mount.js";

vi.mock("../../workspace/src/socket-connection.js", () => ({ connectServer: vi.fn() }));
vi.mock("./client-mount.js", () => ({
    mountClientLinks: vi.fn(),
    mountClientHtml: vi.fn((html: string) => html),
}));
afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

it.each([
    false,
    true,
])("opens the configured Node document directly (readOnly=%s)", async (readOnly) => {
    vi.resetModules();
    const server = "ws://localhost:3000/server";
    const write = vi.fn();
    const open = vi.fn();
    vi.stubGlobal("document", {
        currentScript: null,
        documentElement: { dataset: {} },
        getElementById: () => null,
        body: { dataset: {} },
        addEventListener: vi.fn(),
        open,
        write,
        close: vi.fn(),
    });
    vi.stubGlobal("location", { href: "http://localhost:3000/client/", hash: "" });
    vi.stubGlobal("history", { replaceState: vi.fn() });
    vi.stubGlobal("__doocConnections", undefined);
    vi.stubGlobal("__doocClientSettings", undefined);
    vi.stubGlobal("__doocClientBase", "/client");
    vi.stubGlobal("__doocDesktopConnection", undefined);
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ runtime: "node", server, readOnly })),
    );
    let ready: (response: Response) => void = () => {};
    const response = new Promise<Response>((resolve) => {
        ready = resolve;
    });
    let readyNav!: (response: Response) => void;
    const navigation = new Promise<Response>((resolve) => {
        readyNav = resolve;
    });
    const connection = {
        id: "configured",
        label: "Documents",
        fetch: vi.fn().mockReturnValueOnce(navigation).mockReturnValue(response),
        client: { request: vi.fn(), on: vi.fn(), opened: vi.fn() },
    };
    const { registerWorkspace } = await import("../../workspace/src/connection.js");
    registerWorkspace(connection);
    vi.mocked(connectServer).mockResolvedValue(connection);

    await import("./client-entry.js");
    await vi.waitFor(() => expect(connection.fetch).toHaveBeenCalled());
    expect(open).not.toHaveBeenCalled();
    expect(connection.fetch).toHaveBeenCalledTimes(1);
    expect(connection.fetch).toHaveBeenCalledWith("/api/nav?route=%2F", {
        signal: expect.any(AbortSignal),
    });
    readyNav(Response.json({ siteTitle: "Guide", html: "" }));
    await vi.waitFor(() => expect(connection.fetch).toHaveBeenCalledTimes(2));
    expect(open).not.toHaveBeenCalled();
    ready(new Response("<body><main>Opened document</main></body>"));
    await vi.waitFor(() => expect(write).toHaveBeenCalled());
    expect(vi.mocked(mountClientHtml).mock.invocationCallOrder[0]).toBeLessThan(
        open.mock.invocationCallOrder[0] ?? 0,
    );
    expect(connectServer).toHaveBeenCalledWith(server, false, readOnly);
    expect(connection.fetch).toHaveBeenCalledWith("http://localhost:3000/client/", {
        signal: expect.any(AbortSignal),
    });
    expect(write.mock.calls[0]?.[0]).toContain("Opened document");
    expect(write.mock.calls[0]?.[0].includes('data-dooc-reader="true"')).toBe(readOnly);
});
