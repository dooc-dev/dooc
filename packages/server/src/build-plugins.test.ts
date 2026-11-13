import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { DataPlugin } from "../../../plugins/src/types.js";
import { zip } from "../../engine/src/compiler/zip.js";
import { loadBuildPlugins, pluginSnapshot } from "./build-plugins.js";
import { createExtensionManager, EXTENSIONS_DIR } from "./extensions.js";
import { createLocalPluginStorage } from "./plugins/local-storage.js";

let root: string;
afterEach(() => {
    vi.unstubAllEnvs();
    if (root) rmSync(root, { recursive: true, force: true });
});

it("loads only enabled package bytes and uses personal credentials without exposing them", async () => {
    root = mkdtempSync(join(tmpdir(), "dooc-build-plugins-"));
    vi.stubEnv("DOOC_USER_DIR", join(root, "personal"));
    const personal = createLocalPluginStorage();
    const source = `export default { plugins: [{
        id: "example", matches: url => url.hostname === "service.example",
        oauth: {authorizationUrl:"https://service.example/authorize", tokenUrl:"https://service.example/token", clientId:"public", scopes:["read"]},
        apiOrigins:["https://service.example"], identifyUser: async () => ({id:"user",name:"User"}),
        read: async (_url, context) => ({blocks:[{type:"text",text:context.user.name},{type:"context",items:[{text:"Value",copy:"value"}]}]})
    }] };`;
    const archive = zip([
        {
            name: "package.json",
            data: Buffer.from(
                JSON.stringify({
                    name: "example",
                    version: "1.0.0",
                    type: "module",
                    main: "index.mjs",
                }),
            ),
        },
        { name: "index.mjs", data: Buffer.from(source) },
    ]);
    mkdirSync(join(root, EXTENSIONS_DIR), { recursive: true });
    writeFileSync(join(root, EXTENSIONS_DIR, "example.zip"), archive);
    const inactive = await loadBuildPlugins(root);
    expect(
        await inactive.request({ action: "resolve", url: "https://service.example/one" }),
    ).toEqual({ plugin: undefined });
    inactive.dispose();
    let plugin: DataPlugin | undefined;
    const manager = createExtensionManager(
        root,
        {
            register(value) {
                plugin = value;
            },
            unregister() {},
        },
        { plugins: [], mocks: {} },
        personal,
    );
    await manager({
        action: "enable",
        file: "example.zip",
        hash: ((await manager({ action: "list" })) as { items: { hash: string }[] }).items[0]?.hash,
    });
    if (!plugin) throw new Error("Plugin was not enabled");
    personal.credentials.set(plugin, {
        token: { access_token: "private-token" },
        expires: Date.now() + 60_000,
        user: { id: "user", name: "Authenticated user" },
    });
    manager.dispose();
    const active = await loadBuildPlugins(root);
    try {
        const html = await pluginSnapshot(active.request)("https://service.example/one");
        expect(html).toContain("Authenticated user");
        expect(html).toContain(".plugin-block-columns { display: grid;");
        expect(html).toContain("<button disabled");
        expect(html).not.toContain("private-token");
        await expect(active.request({ action: "act", plugin: "example" })).rejects.toThrow(
            "only resolve and read",
        );
        personal.credentials.set(plugin);
        await expect(
            pluginSnapshot(active.request)("https://service.example/one"),
        ).rejects.toMatchObject({ status: 401 });
    } finally {
        active.dispose();
    }
});
