import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isPluginError, PluginError } from "../src/plugins/oauth.ts";
import { createPluginRuntime } from "../src/plugins/runtime.ts";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "packages/dooc-plugin/package.json"), "utf8"));
assert.equal(manifest.name, "@dooc-dev/dooc-plugin");
assert.deepEqual(manifest.publishConfig, {
    registry: "https://registry.npmjs.org",
    access: "public",
});
const output = join(root, "build/packages");
const consumer = mkdtempSync(join(tmpdir(), "dooc-plugin-consumer-"));
const cache = join(tmpdir(), "dooc-plugin-npm-cache");
const originalFetch = globalThis.fetch;
try {
    execFileSync("pnpm", ["run", "build:plugin"], { cwd: root, stdio: "inherit" });
    mkdirSync(output, { recursive: true });
    const [packed] = JSON.parse(
        execFileSync(
            "npm",
            [
                "pack",
                "./packages/dooc-plugin",
                "--ignore-scripts",
                "--json",
                "--pack-destination",
                output,
                "--cache",
                cache,
            ],
            { cwd: root, encoding: "utf8" },
        ),
    );
    assert.equal(packed.name, manifest.name);
    assert.equal(packed.version, manifest.version);
    assert.deepEqual(
        packed.files.map((file) => file.path).sort(),
        [
            "dist/plugins/actions.d.ts",
            "dist/plugins/actions.js",
            "dist/plugins/blocks.d.ts",
            "dist/plugins/blocks.js",
            "dist/plugins/view.d.ts",
            "dist/plugins/view.js",
            "dist/plugins/index.d.ts",
            "dist/plugins/index.js",
            "dist/plugins/oauth.d.ts",
            "dist/plugins/oauth.js",
            "dist/plugins/types.d.ts",
            "dist/plugins/types.js",
            "package.json",
        ].sort(),
    );
    assert.equal(manifest.dependencies, undefined);
    assert.equal(manifest.peerDependencies, undefined);
    const archive = join(output, packed.filename);
    writeFileSync(join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
    execFileSync(
        "npm",
        [
            "install",
            archive,
            "--ignore-scripts",
            "--package-lock=false",
            "--no-audit",
            "--no-fund",
            "--cache",
            cache,
        ],
        { cwd: consumer, stdio: "pipe" },
    );
    const sdk = await import(
        pathToFileURL(join(consumer, "node_modules", manifest.name, "dist/plugins/index.js")).href
    );
    assert.deepEqual(sdk.parseOAuthToken({ access_token: "fixture", token_type: "Bearer" }), {
        access_token: "fixture",
    });
    assert.throws(() => sdk.parseOAuthToken({ access_token: "bot", token_type: "bot" }));
    assert(!(new sdk.PluginError(401, "Reconnect") instanceof PluginError));
    assert(isPluginError(new sdk.PluginError(401, "Reconnect")));
    assert(!isPluginError(new sdk.PluginError(200, "Invalid status")));
    writeFileSync(
        join(consumer, "check.ts"),
        `
import { parseOAuthToken, PluginError } from ${JSON.stringify(manifest.name)};
import type { DataPlugin, PluginView } from ${JSON.stringify(manifest.name)};
const card: PluginView = { header: { title: "Hello" }, blocks: [{ type: "text", text: "World" }], collapsed: { blocks: [{ type: "context", items: ["Summary"] }] } };
const plugin: DataPlugin = {
    id: "example",
    matches: (url) => url.origin === "https://example.com",
    oauth: { authorizationUrl: "https://example.com/authorize", tokenUrl: "https://example.com/token", clientId: "client", scopes: ["read"], parseToken: parseOAuthToken },
    apiOrigins: ["https://example.com"],
    identifyUser: async () => ({ id: "alice", name: "Alice" }),
    read: async (resource, context) => {
        if (!resource) throw new PluginError(400, "Resource required");
        await context.request("https://example.com/data");
        return card;
    },
};
// @ts-expect-error A view requires structured blocks.
const invalid: PluginView = { header: { title: "Incomplete" } };
export default plugin;
`,
    );
    execFileSync(
        process.execPath,
        [
            join(root, "node_modules/typescript/bin/tsc"),
            "--noEmit",
            "--strict",
            "--module",
            "NodeNext",
            "--moduleResolution",
            "NodeNext",
            "--target",
            "ES2022",
            "check.ts",
        ],
        { cwd: consumer, stdio: "inherit" },
    );
    let status = 403;
    let calls = 0;
    const runtime = createPluginRuntime([
        {
            id: "example",
            matches: (url) => url.origin === "https://example.com",
            oauth: {
                authorizationUrl: "https://example.com/authorize",
                tokenUrl: "https://example.com/token",
                clientId: "client",
                scopes: ["read"],
            },
            apiOrigins: ["https://example.com"],
            identifyUser: async () => ({ id: "alice", name: "Alice" }),
            read: async () => {
                calls++;
                throw new sdk.PluginError(status, "Service denied access");
            },
        },
    ]);
    globalThis.fetch = async () => Response.json({ access_token: "fixture" });
    const session = runtime.createSession();
    const callback = "http://localhost:5179/api/plugins/callback/example";
    const url = new URL(runtime.connect(session, "example", callback));
    await runtime.callback(
        session,
        "example",
        callback,
        new URLSearchParams({ state: url.searchParams.get("state"), code: "fixture" }),
    );
    await assert.rejects(
        runtime.read(session, "example", "https://example.com/one"),
        (error) => isPluginError(error) && error.status === 403,
    );
    status = 401;
    await assert.rejects(
        runtime.read(session, "example", "https://example.com/two"),
        (error) => isPluginError(error) && error.status === 401,
    );
    await assert.rejects(
        runtime.read(session, "example", "https://example.com/three"),
        (error) => isPluginError(error) && error.status === 401,
    );
    assert.equal(calls, 2);
    console.log(`Plugin package verified: ${archive}\n${packed.integrity}`);
} finally {
    globalThis.fetch = originalFetch;
    rmSync(consumer, { recursive: true, force: true });
}
