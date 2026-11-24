import { afterEach, expect, it, vi } from "vitest";
import { workspaceHttp } from "./application-transport.js";
import { createWorkspaceClient, type WorkspaceClient } from "./client.js";
import { clientPath, workspacePath } from "./client-path.js";
import { portPair } from "./protocol.js";
import { createWorkspaceServer } from "./server.js";

afterEach(() => vi.unstubAllGlobals());

it("keeps client routes separate from backend paths, including documents named client, server and mcp", async () => {
    vi.stubGlobal("__doocClientBase", "/client");
    vi.stubGlobal("location", new URL("http://localhost:3000/client/guide"));
    const request = vi.fn(async () => ({ status: 200, headers: {}, body: "Page" }));
    const fetch = workspaceHttp({ request } as unknown as WorkspaceClient);
    for (const path of ["/client", "/server", "/mcp", "/client/nested"])
        expect(workspacePath(clientPath(path))).toBe(path);
    const response = await fetch("http://localhost:3000/client/mcp?lang=eng#section");
    expect(request).toHaveBeenLastCalledWith(
        "http",
        expect.objectContaining({ url: "/mcp?lang=eng" }),
        expect.any(AbortSignal),
    );
    expect(response.url).toBe("http://localhost:3000/client/mcp?lang=eng#section");
    await fetch("/api/page?route=%2Fclient");
    expect(request).toHaveBeenLastCalledWith(
        "http",
        expect.objectContaining({ url: "/api/page?route=%2Fclient" }),
        expect.any(AbortSignal),
    );
    await fetch("/client");
    expect(request).toHaveBeenLastCalledWith(
        "http",
        expect.objectContaining({ url: "/client" }),
        expect.any(AbortSignal),
    );
    request.mockResolvedValueOnce({
        status: 302,
        headers: { location: "/server" } as Record<string, string>,
        body: "",
    });
    expect((await fetch("http://localhost:3000/client/")).url).toBe(
        "http://localhost:3000/client/server",
    );
    expect(clientPath("https://example.com/")).toBe("https://example.com/");
    expect(clientPath("//example.com/")).toBe("//example.com/");
});

it("aborts workspace HTTP before the server finishes and never follows a late redirect", async () => {
    vi.stubGlobal("location", new URL("http://localhost/client/"));
    let finish!: (value: unknown) => void;
    const http = vi.fn(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    const server = createWorkspaceServer({ http });
    const [near, far] = portPair();
    const detach = server.connect(far, {});
    const fetch = workspaceHttp(createWorkspaceClient(near));
    const controller = new AbortController();
    const response = fetch("/api/page", { signal: controller.signal });
    await vi.waitFor(() => expect(http).toHaveBeenCalledOnce());
    controller.abort();
    await expect(response).rejects.toMatchObject({ name: "AbortError" });
    finish({ status: 302, headers: { location: "/api/other" }, body: "" });
    await Promise.resolve();
    await expect(fetch("/api/page", { signal: controller.signal })).rejects.toMatchObject({
        name: "AbortError",
    });
    expect(http).toHaveBeenCalledOnce();
    detach();
});
