import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { bundleEntries } from "../compiler/bundle.js";
import { createCompiler } from "../compiler/compile.js";
import { loadDocsConfig } from "../compiler/config.js";
import { loadViewerPlugins } from "../viewer/plugin-config.js";
import { pluginViewHtml } from "../viewer/plugin-view.js";
import { publishHtml, siteFrom } from "../viewer/serve.js";
import type { DataPlugin } from "./types.js";

const sample = new URL("../../sample-content/", import.meta.url);

describe("sample plugin", () => {
    it("makes the mock reject incorrect PKCE proofs, code replay, and missing Bearer authentication", async () => {
        const module = await import(new URL("../examples/viewer-plugins/mock.mjs", sample).href);
        const mock = module.createSampleMock();
        const verifier = "a".repeat(43);
        const redirect = "http://localhost:5179/api/plugins/callback/sample";
        const issue = async () => {
            const params = new URLSearchParams({
                client_id: "dooc-sample",
                response_type: "code",
                redirect_uri: redirect,
                scope: "read",
                state: "state",
                code_challenge_method: "S256",
                code_challenge: createHash("sha256").update(verifier).digest("base64url"),
            });
            const consent = await mock.handle(new Request(`${mock.origin}/authorize?${params}`));
            const transaction =
                /name="transaction" value="([^"]+)"/.exec(await consent.text())?.[1] ?? "";
            const approval = await mock.handle(
                new Request(`${mock.origin}/authorize`, {
                    method: "POST",
                    body: new URLSearchParams({ transaction, user: "alice" }),
                }),
            );
            return new URL(approval.headers.get("location")).searchParams.get("code") ?? "";
        };
        const exchange = (code: string, proof: string) =>
            mock.handle(
                new Request(`${mock.origin}/token`, {
                    method: "POST",
                    body: new URLSearchParams({
                        client_id: "dooc-sample",
                        grant_type: "authorization_code",
                        code,
                        code_verifier: proof,
                        redirect_uri: redirect,
                    }),
                }),
            );
        const bad = await issue();
        expect((await exchange(bad, "b".repeat(43))).status).toBe(400);
        expect((await exchange(bad, verifier)).status).toBe(400);
        const code = await issue();
        const token = await (await exchange(code, verifier)).json();
        expect((await exchange(code, verifier)).status).toBe(400);
        for (const authorization of [token.access_token, `Basic ${token.access_token}`]) {
            expect(
                (
                    await mock.handle(
                        new Request(`${mock.origin}/me`, { headers: { authorization } }),
                    )
                ).status,
            ).toBe(401);
        }
        expect(
            (
                await mock.handle(
                    new Request(`${mock.origin}/me`, {
                        headers: { authorization: `Bearer ${token.access_token}` },
                    }),
                )
            ).status,
        ).toBe(200);
    });

    it("fetches matched service URLs and renders their returned data", async () => {
        const module = await import(new URL("../examples/viewer-plugins/sample.mjs", sample).href);
        const plugin: DataPlugin = module.createSamplePlugin({
            authorizationUrl: "https://example.com/authorize",
            tokenUrl: "https://example.com/token",
            userUrl: "https://example.com/me",
            clientId: "client",
        });
        const user = { id: "alice", name: "Alice" };
        const request = vi.fn<(url: string) => Promise<unknown>>().mockResolvedValue(user);
        expect(await plugin.identifyUser({ request })).toEqual(user);
        const data = {
            type: "ticket",
            id: "DOC-42",
            title: "From service",
            status: "Open",
            author: "Alice",
            body: "Real response",
        };
        request.mockResolvedValue(data);
        const url = new URL("https://example.com/tickets/DOC-42?view=full#comment-7");
        expect(plugin.matches(url)).toBe(true);
        const view = await plugin.read(url, { request, user });
        expect(view).toMatchObject({
            format: "blocks",
            blocks: expect.arrayContaining([{ type: "heading", text: "From service" }]),
        });
        expect(pluginViewHtml(view)).toContain("Real response");
        expect(request).toHaveBeenLastCalledWith("https://example.com/tickets/DOC-42?view=full");
        const count = request.mock.calls.length;
        for (const source of [
            "https://example.com/not-supported",
            "https://elsewhere.example/tickets/DOC-42",
        ]) {
            expect(plugin.matches(new URL(source))).toBe(false);
            await expect(plugin.read(new URL(source), { request, user })).rejects.toThrow(
                "Unknown",
            );
        }
        expect(request).toHaveBeenCalledTimes(count);
        request.mockResolvedValueOnce({ invalid: true });
        await expect(plugin.read(url, { request, user })).rejects.toThrow("Invalid");
        request.mockRejectedValueOnce(new Error("Revoked"));
        await expect(plugin.read(url, { request, user })).rejects.toThrow("Revoked");
        request.mockResolvedValueOnce({
            ...data,
            type: "message",
            author: '<img onerror="alert(1)"> & {{title}}',
        });
        const message = await plugin.read(new URL("https://example.com/messages/release"), {
            request,
            user,
        });
        if (message.format !== "blocks") throw new Error("Expected a block permalink preview");
        expect(pluginViewHtml(message)).toContain(
            "&lt;img onerror=&quot;alert(1)&quot;&gt; &amp; {{title}}",
        );
        expect(pluginViewHtml(message)).not.toContain("<img");
    });

    it("renders compact pull request details and escapes service values", async () => {
        const viewer = await loadViewerPlugins(
            fileURLToPath(new URL("../examples/viewer-plugins/index.mjs", sample)),
        );
        const plugin = viewer.plugins[0];
        if (!plugin) throw new Error("Missing sample plugin");
        const user = { id: "alice", name: "Alice" };
        const request = vi.fn().mockResolvedValue({
            type: "pull",
            id: "#17",
            title: "A smaller preview",
            body: "Ready to review",
            status: "Open",
            author: "Bob",
            branch: "feat/<preview>",
            base: "main",
            additions: "248",
            deletions: "36",
            checks: "4",
            files: "8",
        });
        const view = await plugin.read(new URL("https://sample.dooc.invalid/pulls/17"), {
            request,
            user,
        });
        if (view.format !== "blocks") throw new Error("Expected a block pull preview");
        expect(pluginViewHtml(view)).toContain("feat/&lt;preview&gt;");
        expect(pluginViewHtml(view)).toContain("+248");
        expect(pluginViewHtml(view)).toContain("4 checks passed");
        expect(pluginViewHtml(view)).not.toContain("{{");
        expect(view.collapsed).toMatchObject({ format: "blocks" });
        if (view.collapsed?.format !== "blocks") throw new Error("Expected a compact pull preview");
        expect(pluginViewHtml(view.collapsed)).toContain("✓ 4 checks");
        expect(pluginViewHtml(view.collapsed)).not.toContain("{{");
    });

    it("keeps viewer configuration, implementation, and data out of document exports", async () => {
        const root = fileURLToPath(sample);
        const config = await loadDocsConfig(root);
        expect(config).not.toHaveProperty("plugins");
        const viewer = await loadViewerPlugins(
            fileURLToPath(new URL("../examples/viewer-plugins/index.mjs", sample)),
        );
        expect(viewer).not.toHaveProperty("mounts");
        expect(viewer.plugins.map((plugin) => plugin.id)).toEqual(["sample"]);
        const compiled = createCompiler(root).compile();
        expect(compiled.errors).toEqual([]);
        const source = compiled.sources.get("files/md/plugins.md");
        expect(source?.errors).toEqual([]);
        const output = publishHtml(siteFrom(compiled), "");
        expect(output).not.toContain('data-plugin="sample"');
        expect(output).not.toContain('src="/assets/ui.js"');
        expect(output).not.toContain("secret-token");
        const files = bundleEntries(root).map((entry) => entry.name);
        expect(files).not.toContain("docs.config.mjs");
        expect(
            files.some((file) => /(?:mock|sample-plugin|plugin-card)\.(?:mjs|html)$/.test(file)),
        ).toBe(false);
        expect(readFileSync(new URL("files/md/plugins.md", sample), "utf8")).not.toContain(
            "```plugin",
        );
    });
});
