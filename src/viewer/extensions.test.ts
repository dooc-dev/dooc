import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { zip } from "../compiler/zip.js";
import type { ExtensionSummary } from "../core/extension-package.js";
import { createLocalPluginStorage } from "../plugins/local-storage.js";
import { packExtension } from "./extension-pack.js";
import { createExtensionManager, EXTENSIONS_DIR } from "./extensions.js";
import { loadViewerPlugins } from "./plugin-config.js";
import { createPluginHandler } from "./plugins.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
});
const moduleSource = (id = "example", text = "Demo") =>
    `import { readFileSync } from "node:fs";
    const icon = readFileSync(new URL("./assets/icon.svg", import.meta.url), "utf8");
    export default { plugins: [{ id: "${id}", matches: () => true, oauth: { authorizationUrl: "https://example.com/authorize", tokenUrl: "https://example.com/token", clientId: "client", scopes: ["read"] }, apiOrigins: ["https://example.com"], identifyUser: async () => ({id:"one",name:"One"}), read: async () => ({header:{title:"${text}"},blocks:[{type:"text",text:icon}]}) }] };`;
const archive = (source = moduleSource()) =>
    zip([
        {
            name: "package.json",
            data: Buffer.from(
                JSON.stringify({
                    name: "example",
                    version: "1.0.0",
                    type: "module",
                    main: "index.mjs",
                    icon: "assets/icon.svg",
                }),
            ),
        },
        { name: "index.mjs", data: Buffer.from(source) },
        { name: "assets/icon.svg", data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') },
    ]);
const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-extensions-test-"));
    const registry = { register: vi.fn(), unregister: vi.fn() };
    const request = createExtensionManager(root, registry, { plugins: [], mocks: {} });
    cleanups.push(() => {
        request.dispose();
        rmSync(root, { recursive: true, force: true });
    });
    const install = (file = "example.zip", source = moduleSource(), base: string | null = null) =>
        request({
            action: "install",
            file,
            data: archive(source).toString("base64"),
            base,
        }) as Promise<{ items: ExtensionSummary[] }>;
    return { root, registry, request, install };
};
it("lists viewer-provided service cards with their names and icons without reading service data", async () => {
    const { root, registry } = setup();
    const config = await loadViewerPlugins(
        fileURLToPath(new URL("../../examples/viewer-plugins/index.mjs", import.meta.url)),
    );
    const reads = config.plugins.map((plugin) => vi.spyOn(plugin, "read"));
    const manager = createExtensionManager(root, registry, config);
    cleanups.push(() => {
        manager.dispose();
        for (const read of reads) read.mockRestore();
    });
    const result = (await manager({ action: "list" })) as { items: ExtensionSummary[] };
    expect(result.items).toEqual(
        expect.arrayContaining([
            expect.objectContaining({
                name: "Service cards",
                plugins: ["sample"],
                readonly: true,
                icon: expect.objectContaining({
                    light: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
                }),
            }),
            expect.objectContaining({
                name: "Service cards (sign-in demo)",
                plugins: ["sample-auth"],
                readonly: true,
            }),
        ]),
    );
    for (const read of reads) expect(read).not.toHaveBeenCalled();
});
it("installs assets, edits text and removes ZIPs with revision checks", async () => {
    const { root, registry, request, install } = setup();
    const installed = await install();
    expect(installed.items[0]?.icon?.light).toBe(
        `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64")}`,
    );
    const revision = installed.items[0]?.hash;
    expect(readFileSync(join(root, ".dooc/plugins", "example.zip"))).toEqual(archive());
    expect(registry.register).toHaveBeenCalledTimes(1);
    await expect(registry.register.mock.calls[0]?.[0].read()).resolves.toMatchObject({
        blocks: [{ type: "text", text: '<svg xmlns="http://www.w3.org/2000/svg"/>' }],
    });
    await expect(request({ action: "read", file: "example.zip" })).resolves.toMatchObject({
        files: expect.arrayContaining([
            { name: "index.mjs", data: Buffer.from(moduleSource()).toString("base64") },
        ]),
    });
    await expect(install()).rejects.toThrow("changed");
    await expect(install("example.zip", "export default null", revision)).rejects.toThrow(
        "configuration",
    );
    expect(registry.unregister).not.toHaveBeenCalled();
    expect(readFileSync(join(root, EXTENSIONS_DIR, "example.zip"))).toEqual(archive());
    const updated = (await request({
        action: "edit",
        file: "example.zip",
        path: "assets/icon.svg",
        source: "<svg>Updated</svg>",
        hash: revision,
    })) as { items: ExtensionSummary[] };
    expect(registry.unregister).toHaveBeenCalledWith("example");
    await expect(registry.register.mock.calls[1]?.[0].read()).resolves.toMatchObject({
        blocks: [{ type: "text", text: "<svg>Updated</svg>" }],
    });
    await expect(
        request({ action: "delete", file: "example.zip", hash: revision }),
    ).rejects.toThrow("changed");
    await expect(
        request({ action: "delete", file: "example.zip", hash: updated.items[0]?.hash }),
    ).resolves.toMatchObject({ items: [] });
});
it("requires approval for disk ZIPs and disables externally changed packages", async () => {
    const { root, registry, request } = setup();
    mkdirSync(join(root, EXTENSIONS_DIR), { recursive: true });
    writeFileSync(join(root, EXTENSIONS_DIR, "example.zip"), archive());
    const list = (await request({ action: "list" })) as { items: ExtensionSummary[] };
    expect(registry.register).not.toHaveBeenCalled();
    expect(list.items[0]?.enabled).toBe(false);
    await expect(request({ action: "enable", file: "example.zip", hash: "wrong" })).rejects.toThrow(
        "changed",
    );
    await request({ action: "enable", file: "example.zip", hash: list.items[0]?.hash });
    expect(registry.register).toHaveBeenCalledTimes(1);
    writeFileSync(join(root, EXTENSIONS_DIR, "example.zip"), "broken");
    await expect(request({ action: "list" })).resolves.toMatchObject({
        items: [{ enabled: false, error: expect.any(String) }],
    });
    expect(registry.unregister).toHaveBeenCalledWith("example");
});
it("rejects path escapes, symlinks, duplicate IDs and invalid exports without overwriting packages", async () => {
    const { root, request, install } = setup();
    await install("one.zip");
    await expect(install("two.zip")).rejects.toThrow();
    for (const file of ["../bad.zip", "bad/node.zip", "bad.mjs", ".hidden.zip", "/bad.zip"])
        await expect(install(file, moduleSource("other"))).rejects.toThrow();
    symlinkSync(join(root, EXTENSIONS_DIR, "one.zip"), join(root, EXTENSIONS_DIR, "linked.zip"));
    await expect(request({ action: "read", file: "linked.zip" })).rejects.toThrow("plugin ZIP");
    await expect(install("invalid.zip", "not valid JavaScript")).rejects.toThrow();
    expect(readFileSync(join(root, EXTENSIONS_DIR, "one.zip"))).toEqual(archive());
});
it("serializes simultaneous installs and rejects a symlinked storage directory", async () => {
    const { root, install, request } = setup();
    const results = await Promise.allSettled([install(), install()]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    request.dispose();
    rmSync(join(root, EXTENSIONS_DIR), { recursive: true });
    symlinkSync(tmpdir(), join(root, EXTENSIONS_DIR));
    await expect(request({ action: "list" })).rejects.toThrow("local directories");
});

it("restores only personally approved ZIP hashes after a server restart", async () => {
    const { root, registry } = setup();
    const personal = createLocalPluginStorage(join(root, "personal"));
    const first = createExtensionManager(root, registry, { plugins: [], mocks: {} }, personal);
    await first({
        action: "install",
        file: "example.zip",
        data: archive().toString("base64"),
        base: null,
    });
    first.dispose();
    const next = createExtensionManager(root, registry, { plugins: [], mocks: {} }, personal);
    await expect(next.restore()).resolves.toEqual([]);
    await expect(next({ action: "list" })).resolves.toMatchObject({ items: [{ enabled: true }] });
    next.dispose();
    writeFileSync(join(root, EXTENSIONS_DIR, "example.zip"), archive(moduleSource("changed")));
    await next.restore();
    await expect(next({ action: "list" })).resolves.toMatchObject({ items: [{ enabled: false }] });
});
it("packages a built module and assets without executing scripts or including the output ZIP", async () => {
    const { root } = setup();
    mkdirSync(join(root, "assets"));
    writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "example", version: "1.0.0", type: "module", main: "index.mjs" }),
    );
    writeFileSync(join(root, "index.mjs"), moduleSource());
    writeFileSync(join(root, "assets/icon.svg"), "<svg/>");
    writeFileSync(join(root, "output.zip"), "previous output");
    const bytes = await packExtension(root, join(root, "output.zip"));
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    symlinkSync("/etc/passwd", join(root, "linked"));
    await expect(packExtension(root, join(root, "output.zip"))).rejects.toThrow("symlinks");
});

it("preserves plugins registered by the host and rejects collisions with live IDs", async () => {
    const { root } = setup();
    const handler = createPluginHandler([]);
    const manager = createExtensionManager(root, handler, { plugins: [], mocks: {} });
    const installed = (await manager({
        action: "install",
        file: "example.zip",
        data: archive().toString("base64"),
        base: null,
    })) as { items: ExtensionSummary[] };
    const plugin = handler.configuration().plugins[0];
    if (!plugin) throw new Error("Missing installed plugin");
    const replacement = {
        ...plugin,
        read: async () => ({ blocks: [{ type: "text" as const, text: "Host" }] }),
    };
    handler.register(replacement);
    await expect(manager({ action: "list" })).resolves.toMatchObject({
        items: [{ enabled: false }, { name: "example", readonly: true, enabled: true }],
    });
    expect(handler.configuration().plugins[0]).toBe(replacement);
    await expect(
        manager({ action: "enable", file: "example.zip", hash: installed.items[0]?.hash }),
    ).rejects.toThrow("already registered");
    await expect(manager({ action: "delete", file: "viewer/example", hash: "" })).rejects.toThrow(
        "ZIP",
    );
    manager.dispose();
    expect(handler.configuration().plugins[0]).toBe(replacement);
});
