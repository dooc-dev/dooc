import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { clientAssets, staticClientHandler } from "./static-client.js";

vi.mock("./assets.js", () => ({
    prebuilt: true,
    readReaderAsset: (name: string) => Buffer.from(name),
}));
vi.mock("./serve.js", () => ({ bundleClient: vi.fn(async (name: string) => name) }));
vi.mock("./terminal.js", () => ({ terminal: { ready: vi.fn() } }));
afterEach(() => vi.clearAllMocks());

it("emits only selected assets and chooses a separate read-only Worker", async () => {
    expect([...(await clientAssets(undefined, { client: false, worker: false }))]).toEqual([]);
    const worker = await clientAssets(undefined, { client: false, worker: true, readOnly: true });
    expect([...worker.keys()]).toEqual(["assets/workspace-worker.js"]);
    expect(worker.get("assets/workspace-worker.js")?.toString()).toBe(
        "workspace-reader-worker.global.js",
    );
    const reader = await clientAssets("ws://localhost:4001", {
        runtime: "node",
        readOnly: true,
        worker: false,
    });
    expect(reader.has("assets/edit.js")).toBe(false);
    expect(reader.has("assets/manifest.js")).toBe(false);
    expect(reader.has("assets/workspace-worker.js")).toBe(false);
    expect(reader.has("assets/client.js")).toBe(true);
    expect(JSON.parse(reader.get("dooc-client.json")?.toString() ?? "{}")).toEqual({
        server: "ws://localhost:4001/server",
        runtime: "node",
        readOnly: true,
        worker: false,
    });
    const editor = await clientAssets();
    expect(editor.has("assets/edit.js")).toBe(true);
    expect(editor.has("assets/manifest.js")).toBe(true);
    expect(editor.get("assets/workspace-worker.js")?.toString()).toBe("workspace-worker.global.js");
    expect(editor.has("assets/mcp.js")).toBe(false);
    const mcp = await clientAssets(undefined, {
        runtime: "web",
        readOnly: true,
        relayUrl: "https://relay.example",
    });
    expect(mcp.get("assets/workspace-worker.js")?.toString()).toBe(
        "workspace-reader-mcp-worker.global.js",
    );
    expect(mcp.has("assets/mcp.js")).toBe(true);
    expect(JSON.parse(mcp.get("dooc-client.json")?.toString() ?? "{}")).toMatchObject({
        relayUrl: "https://relay.example",
        readOnly: true,
    });
    expect(mcp.get("dooc-client.json")?.toString()).not.toMatch(/token|credential|secret/);
});

it.each([
    "",
    "/client",
])("serves %s directly without accepting workspace API requests", async (basePath) => {
    const server = createServer(
        staticClientHandler(
            await clientAssets(undefined, { runtime: "web", readOnly: true, basePath }),
            basePath,
        ),
    );
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
        for (const route of ["", "/", "?lang=jpn", "/guide", "/guide/start"]) {
            const response = await fetch(`${origin}${basePath}${route}`, { redirect: "manual" });
            expect(response.status).toBe(200);
            expect(response.headers.get("location")).toBeNull();
            const html = await response.text();
            expect(html).toContain("Read documents");
            expect(html).toContain("<main hidden>");
            expect(html).toContain(`src="${basePath}/assets/client.js"`);
        }
        expect(
            (await fetch(`${origin}${basePath}/assets/workspace-worker.js`)).headers.get(
                "content-type",
            ),
        ).toContain("javascript");
        for (const route of ["/api/save", "/assets/missing.js", "/dooc.yaml"])
            expect((await fetch(`${origin}${basePath}${route}`)).status).toBe(404);
        for (const route of ["/guide.pdf", "/File%20previews/checklist.txt", "/v1.0/start"]) {
            const response = await fetch(`${origin}${basePath}${route}`, {
                headers: { Accept: "text/html,application/xhtml+xml" },
            });
            expect(response.status).toBe(200);
            expect(response.headers.get("content-type")).toContain("text/html");
            expect(await response.text()).toContain("Read documents");
        }
        for (const route of ["/api/save", "/assets/missing.js"])
            expect(
                (
                    await fetch(`${origin}${basePath}${route}`, {
                        headers: { Accept: "text/html" },
                    })
                ).status,
            ).toBe(404);
        if (basePath)
            for (const route of ["/", "/guide", "/clients", "/client-extra"])
                expect((await fetch(`${origin}${route}`)).status).toBe(404);
        expect(
            (await fetch(`${origin}${basePath}/api/save`, { method: "POST", body: "{}" })).status,
        ).toBe(405);
    } finally {
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
        });
    }
});
