import { afterEach, expect, it, vi } from "vitest";
import { workspaceHttp } from "./application-transport.js";
import type { WorkspaceClient } from "./client.js";
import { clientPath, workspacePath } from "./client-path.js";

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
    );
    expect(response.url).toBe("http://localhost:3000/client/mcp?lang=eng#section");
    await fetch("/api/page?route=%2Fclient");
    expect(request).toHaveBeenLastCalledWith(
        "http",
        expect.objectContaining({ url: "/api/page?route=%2Fclient" }),
    );
    await fetch("/client");
    expect(request).toHaveBeenLastCalledWith("http", expect.objectContaining({ url: "/client" }));
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
