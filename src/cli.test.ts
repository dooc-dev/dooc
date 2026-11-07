import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalArgv = process.argv;
const roots: string[] = [];
afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.doUnmock("./viewer/serve.js");
    vi.doUnmock("./viewer/assets.js");
    vi.doUnmock("./viewer/build.js");
    vi.doUnmock("./mcp.js");
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const cli = (...args: string[]) => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "test");
    process.argv = [process.execPath, "cli.js", ...args];
    vi.spyOn(process, "cwd").mockReturnValue(tmpdir());
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("CLI exit");
    });
    return { stdout, stderr, exit, run: () => import("./cli.js") };
};

describe("source-based CLI", () => {
    it("injects an external Git origin into MCP without starting viewer plugins", async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-mcp-"));
        roots.push(root);
        const module = join(root, "origin.mjs");
        writeFileSync(
            module,
            `export default {
            plugins: [],
            setup() { throw new Error("Viewer setup must not run"); },
            gitOrigin: { name: "External", capabilities: [], async read() {}, async execute() {} },
        };`,
        );
        const startMcp = vi.fn().mockResolvedValue(undefined);
        vi.doMock("./mcp.js", () => ({ startMcp }));
        await cli("mcp", root, "--git-origin", module).run();
        expect(startMcp).toHaveBeenCalledWith(root, {
            gitOrigin: expect.objectContaining({
                name: "External",
                read: expect.any(Function),
                execute: expect.any(Function),
            }),
        });
        const invalid = cli("mcp", root, "--unknown");
        await expect(invalid.run()).rejects.toThrow("CLI exit");
        expect(startMcp).toHaveBeenCalledTimes(1);
    });

    it("registers, lists and removes project fonts through the CLI", async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-font-"));
        roots.push(root);
        const file = new URL("./viewer/fonts/udev-gothic-regular.woff2", import.meta.url).pathname;
        await cli("font", "add", file, root).run();
        const listed = cli("font", "list", root);
        await listed.run();
        expect(JSON.parse(listed.stdout.mock.calls[0]?.[0] as string)).toEqual([
            "udev-gothic-regular.woff2",
        ]);
        await cli("font", "remove", "udev-gothic-regular.woff2", root).run();
        const empty = cli("font", "list", root);
        await empty.run();
        expect(JSON.parse(empty.stdout.mock.calls[0]?.[0] as string)).toEqual([]);
    });

    it.each([[], ["help"], ["--help"], ["-h"]])("shows help for %j", async (...args) => {
        const result = cli(...args);
        await result.run();
        const help = result.stdout.mock.calls[0]?.[0];
        expect(help).toContain("edit [root] [port]");
        expect(help).toContain("view [root] [port]");
        expect(help).toContain("mcp [root]");
        expect(help).not.toMatch(/(?:^|\n)\s+(?:preview|code-language|doc ls|figure ls)\b/);
        expect(help).toContain("build html [root] [out-dir]");
        expect(help).toContain("build zip [root] [out-dir]");
        expect(help).toContain("--url_preview embed|network");
        expect(help).not.toContain("--mode");
        expect(help).not.toContain("export ");
        expect(help).not.toMatch(/export json|json-schema/);
        expect(result.stderr).not.toHaveBeenCalled();
        expect(result.exit).not.toHaveBeenCalled();
    });

    it.each([true, false])("sets the runtime environment for prebuilt=%s", async (prebuilt) => {
        vi.doMock("./viewer/assets.js", () => ({ prebuilt }));
        await cli("help").run();
        expect(process.env.NODE_ENV).toBe(prebuilt ? "production" : "development");
    });

    it.each([
        ["edit", "edit"],
        ["view", "preview"],
    ])("starts %s with the expected server mode and arguments", async (command, mode) => {
        const startServer = vi.fn();
        vi.doMock("./viewer/serve.js", () => ({ startServer }));
        vi.stubEnv("DOCS_ROOT", "");
        vi.stubEnv("DOCS_HMR", "");
        await cli(command, tmpdir(), "4321").run();
        expect(startServer).toHaveBeenLastCalledWith(mode, 4321, undefined);
        expect(process.env.DOCS_ROOT).toBe(tmpdir());
        expect(process.env.DOCS_HMR).toBe("1");
        await cli(command).run();
        expect(startServer).toHaveBeenLastCalledWith(mode, 5179, undefined);
        expect(process.env.DOCS_ROOT).toBe(tmpdir());
    });

    it("injects viewer modules independently of the document root", async () => {
        const startServer = vi.fn();
        vi.doMock("./viewer/serve.js", () => ({ startServer }));
        vi.stubEnv("DOOC_VIEWER_PLUGINS", "./external-viewer.mjs");
        await cli("edit", tmpdir()).run();
        expect(startServer).toHaveBeenLastCalledWith("edit", 5179, "./external-viewer.mjs");
        await cli("view", tmpdir(), "4321", "--viewer-plugins", "./override.mjs").run();
        expect(startServer).toHaveBeenLastCalledWith("preview", 4321, "./override.mjs");
    });

    it.each([
        ["export", "html"],
        ["export", "zip"],
        ["export", "json"],
        ["json-schema", "latest"],
        ["preview"],
        ["dev"],
        ["code-language", "add", "python"],
        ["doc", "ls"],
        ["figure", "ls"],
    ])("rejects removed commands: %j", async (...args) => {
        const result = cli(...args);
        await expect(result.run()).rejects.toThrow("CLI exit");
        expect(result.exit).toHaveBeenCalledWith(1);
        expect(result.stdout).not.toHaveBeenCalled();
        expect(result.stderr).toHaveBeenCalledWith(expect.stringContaining("unknown command"));
    });

    it("rejects unsupported URL preview options without writing output", async () => {
        for (const args of [
            [],
            ["pdf"],
            ["html", "--lang", "eng"],
            ["html", "--html", "static"],
            ["zip", "--zip", "embed"],
            ["html", "--mode", "embed"],
            ["zip", "--mode", "static"],
            ["html", "--url_preview", "static"],
            ["html", "--url_preview", "invalid"],
            ["zip", "--url_preview", "reference"],
            ["zip", "--url_preview", "invalid"],
        ]) {
            const result = cli("build", ...args);
            await expect(result.run()).rejects.toThrow("CLI exit");
            expect(result.exit).toHaveBeenCalledWith(1);
        }
    });

    it.each([
        ["html", undefined, "embed"],
        ["html", "network", "network"],
        ["zip", undefined, "embed"],
        ["zip", "network", "network"],
    ] as const)("writes only the selected artifact for build %s --url_preview %s", async (format, preview, expectedPreview) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-build-"));
        roots.push(root);
        const out = join(root, preview ? "custom" : "dist");
        mkdirSync(out);
        const other = join(out, format === "html" ? "bundle.zip" : "bundle.html");
        writeFileSync(other, "Keep existing artifact");
        const buildBundle = vi.fn().mockResolvedValue({ data: "Built artifact", docs: 1 });
        vi.doMock("./viewer/build.js", () => ({ buildBundle }));
        const result = cli(
            "build",
            format,
            root,
            ...(preview
                ? [
                      out,
                      ...(format === "html"
                          ? ["--url_preview", preview]
                          : [`--url_preview=${preview}`]),
                  ]
                : []),
        );
        await result.run();
        expect(buildBundle).toHaveBeenCalledWith(root, { format, urlPreview: expectedPreview });
        expect(readFileSync(join(out, `bundle.${format}`), "utf8")).toBe("Built artifact");
        expect(readFileSync(other, "utf8")).toBe("Keep existing artifact");
        expect(result.stdout).toHaveBeenCalledTimes(1);
    });

    it.each([
        "html",
        "zip",
    ])("preserves existing artifacts when build %s validation fails", async (format) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-"));
        roots.push(root);
        mkdirSync(join(root, "content"));
        mkdirSync(join(root, "dist"));
        writeFileSync(join(root, "dooc.yaml"), "docs: [guide]\n");
        writeFileSync(join(root, "content/guide.md"), "---\ntitle: []\n---\nBody\n");
        for (const file of ["bundle.html", "bundle.zip"])
            writeFileSync(join(root, "dist", file), "Previous bundle");
        const result = cli("build", format, root);
        await expect(result.run()).rejects.toThrow("CLI exit");
        expect(result.stderr).toHaveBeenCalledWith(expect.stringContaining("validation failed"));
        for (const file of ["bundle.html", "bundle.zip"])
            expect(readFileSync(join(root, "dist", file), "utf8")).toBe("Previous bundle");
    });
});
