import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadViewerPlugins } from "./plugin-config.js";

const load = async (source: string) => {
    const root = mkdtempSync(join(tmpdir(), "dooc-viewer-plugins-"));
    try {
        const path = join(root, "viewer.mjs");
        writeFileSync(path, source);
        return await loadViewerPlugins(path);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
};

describe("external viewer registration", () => {
    it("accepts only explicit executable origin adapters", async () => {
        const config = await load(
            'export default { plugins: [], gitOrigin: { name: "Origin", capabilities: ["push"], async read() {}, async execute() {} } };',
        );
        expect(config.gitOrigin?.capabilities).toEqual(["push"]);
        await expect(
            load(
                'export default { plugins: [], gitOrigin: { name: "Origin", capabilities: ["shell"] } };',
            ),
        ).rejects.toThrow("Git origin");
    });
    it("accepts an application setup hook for later registrations", async () => {
        const config = await load(
            'export default { plugins: [], setup(viewer) { viewer.unregister("sample"); } };',
        );
        const registry = {
            register: vi.fn(),
            unregister: vi.fn(),
            setAllowedDomains: vi.fn(),
            setGitOrigin: vi.fn(),
            setWorkspace: vi.fn(),
        };
        await config.setup?.(registry);
        expect(registry.unregister).toHaveBeenCalledWith("sample");
        await expect(load('export default { plugins: [], setup: "script" };')).rejects.toThrow(
            "setup",
        );
    });

    it("validates and normalizes injected domains independently of documents", async () => {
        const config = await load(
            'export default { plugins: [], allowedDomains: [" EXAMPLE.COM "] };',
        );
        expect(config.allowedDomains).toEqual(["example.com"]);
        for (const domains of [
            null,
            "example.com",
            ["*"],
            ["localhost"],
            ["example.com", "EXAMPLE.COM"],
        ]) {
            await expect(
                load(`export default { plugins: [], allowedDomains: ${JSON.stringify(domains)} };`),
            ).rejects.toThrow();
        }
    });

    it("accepts workspace identity from the hosting service", async () => {
        for (const workspace of [
            { protocol: "git", branch: "docs/topic" },
            { protocol: "storage", folder: "team/docs", service: "Object store", icon: "<svg/>" },
        ]) {
            const config = await load(
                `export default ${JSON.stringify({ plugins: [], workspace })};`,
            );
            expect(config.workspace).toEqual(workspace);
        }
        await expect(
            load('export default { plugins: [], workspace: { protocol: "git" } };'),
        ).rejects.toThrow("Workspace");
    });

    it("loads only an explicitly injected module", async () => {
        expect(await loadViewerPlugins()).toEqual({ plugins: [], mocks: {} });
        expect(await load("export default { plugins: [] };")).toEqual({
            plugins: [],
            mocks: {},
        });
        await expect(loadViewerPlugins("./missing-viewer-plugins.mjs")).rejects.toThrow();
    });

    it("rejects invalid mounts and mock origins at registration", async () => {
        for (const source of [
            "export default null;",
            "export default { plugins: null };",
            'export default { plugins: [], mounts: [{ route: "//elsewhere", title: "Card", plugin: "sample", resource: "card" }] };',
            'export default { plugins: [], mounts: [{ route: "/guide", title: "Card", plugin: "missing", resource: "card" }] };',
            'export default { plugins: [], mocks: { sample: { origin: "https://real.example", handle() {} } } };',
            'export default { plugins: [], mocks: { sample: { origin: "https://sample.invalid", autoConnect: "yes", handle() {} } } };',
            'export default { plugins: [], mocks: { sample: { origin: "https://sample.invalid", handle() {} }, other: { origin: "https://sample.invalid", handle() {} } } };',
        ])
            await expect(load(source)).rejects.toThrow();
    });
});
