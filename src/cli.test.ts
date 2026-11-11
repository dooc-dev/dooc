import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    vi.spyOn(process, "cwd").mockReturnValue(roots.at(-1) ?? tmpdir());
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
        writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
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
        await cli("mcp", join(root, "dooc.yaml"), "--git-origin", module).run();
        expect(startMcp).toHaveBeenCalledWith(root, {
            gitOrigin: expect.objectContaining({
                name: "External",
                read: expect.any(Function),
                execute: expect.any(Function),
            }),
        });
        const invalid = cli("mcp", join(root, "dooc.yaml"), "--unknown");
        await expect(invalid.run()).rejects.toThrow("CLI exit");
        expect(startMcp).toHaveBeenCalledTimes(1);
    });

    it("registers, lists and removes project fonts through the CLI", async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-font-"));
        roots.push(root);
        writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
        const file = new URL("./viewer/fonts/udev-gothic-regular.woff2", import.meta.url).pathname;
        await cli("font", "add", file, join(root, "dooc.yaml")).run();
        expect(existsSync(join(root, ".dooc/fonts/udev-gothic-regular.woff2"))).toBe(true);
        const listed = cli("font", "list", join(root, "dooc.yaml"));
        await listed.run();
        expect(JSON.parse(listed.stdout.mock.calls[0]?.[0] as string)).toEqual([
            "udev-gothic-regular.woff2",
        ]);
        await cli("font", "remove", "udev-gothic-regular.woff2", join(root, "dooc.yaml")).run();
        const empty = cli("font", "list", join(root, "dooc.yaml"));
        await empty.run();
        expect(JSON.parse(empty.stdout.mock.calls[0]?.[0] as string)).toEqual([]);
    });

    it.each([[], ["help"], ["--help"], ["-h"]])("shows help for %j", async (...args) => {
        const result = cli(...args);
        await result.run();
        const help = result.stdout.mock.calls[0]?.[0];
        expect(help).toContain("edit [dooc.yaml] [port]");
        expect(help).toContain("view [dooc.yaml] [port]");
        expect(help).toContain("mcp [dooc.yaml]");
        expect(help).not.toMatch(/(?:^|\n)\s+(?:preview|code-language|doc ls|figure ls)\b/);
        expect(help).toContain("build html [dooc.yaml] [out-dir]");
        expect(help).toContain("build zip [dooc.yaml] [out-dir]");
        expect(help).toContain("--url_preview embed|network");
        expect(help).toContain("--mode static|live");
        expect(help).toContain("export [dooc.yaml] [out-dir]");
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
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-project-"));
        roots.push(root);
        writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
        const startServer = vi.fn();
        vi.doMock("./viewer/serve.js", () => ({ startServer }));
        vi.stubEnv("DOCS_ROOT", "");
        vi.stubEnv("DOCS_HMR", "");
        await cli(command, join(root, "dooc.yaml"), "4321").run();
        expect(startServer).toHaveBeenLastCalledWith(mode, 4321, undefined);
        expect(process.env.DOCS_ROOT).toBe(root);
        expect(process.env.DOCS_HMR).toBe("1");
        await cli(command).run();
        expect(startServer).toHaveBeenLastCalledWith(mode, 5179, undefined);
        expect(process.env.DOCS_ROOT).toBe(root);
    });

    it("rejects folders, missing manifests and other files before starting a viewer", async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-invalid-"));
        roots.push(root);
        const other = join(root, "other.yaml");
        writeFileSync(other, "docs: []\n");
        const startServer = vi.fn();
        vi.doMock("./viewer/serve.js", () => ({ startServer }));
        for (const path of [root, other, join(root, "dooc.yaml")]) {
            const result = cli("edit", path);
            await expect(result.run()).rejects.toThrow("CLI exit");
            expect(result.stderr).toHaveBeenCalledWith(
                expect.stringContaining("Specify an existing dooc.yaml file"),
            );
        }
        expect(startServer).not.toHaveBeenCalled();
    });

    it("injects viewer modules independently of the document root", async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-project-"));
        roots.push(root);
        writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
        const startServer = vi.fn();
        vi.doMock("./viewer/serve.js", () => ({ startServer }));
        vi.stubEnv("DOOC_VIEWER_PLUGINS", "./external-viewer.mjs");
        await cli("edit", join(root, "dooc.yaml")).run();
        expect(startServer).toHaveBeenLastCalledWith("edit", 5179, "./external-viewer.mjs");
        await cli(
            "view",
            join(root, "dooc.yaml"),
            "4321",
            "--viewer-plugins",
            "./override.mjs",
        ).run();
        expect(startServer).toHaveBeenLastCalledWith("preview", 4321, "./override.mjs");
    });

    it.each([
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

    it("exports sources without executing configuration or plugins", async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-export-"));
        roots.push(root);
        mkdirSync(join(root, "docs"));
        writeFileSync(join(root, "dooc.yaml"), "center_contents:\n  - file: docs/guide.md\n");
        writeFileSync(
            join(root, "docs/guide.md"),
            "---\ntitle: Guide\n---\n\n![](https://private.example/item)\n",
        );
        writeFileSync(join(root, "docs.config.mjs"), 'throw new Error("Do not execute");');
        const result = cli("export", join(root, "dooc.yaml"));
        await result.run();
        expect(result.exit).not.toHaveBeenCalled();
        expect(readFileSync(join(root, "dist/bundle.zip")).subarray(0, 2).toString()).toBe("PK");
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
        writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
        const out = join(root, preview ? "custom" : "dist");
        mkdirSync(out);
        const other = join(out, format === "html" ? "bundle.zip" : "bundle.html");
        writeFileSync(other, "Keep existing artifact");
        const buildBundle = vi.fn().mockResolvedValue({ data: "Built artifact", docs: 1 });
        vi.doMock("./viewer/build.js", () => ({ buildBundle }));
        const result = cli(
            "build",
            format,
            join(root, "dooc.yaml"),
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

    it("passes an injected source URL to the HTML build", async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-source-"));
        roots.push(root);
        writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
        const buildBundle = vi.fn().mockResolvedValue({ data: "Built artifact", docs: 0 });
        vi.doMock("./viewer/build.js", () => ({ buildBundle }));
        await cli(
            "build",
            "html",
            join(root, "dooc.yaml"),
            "--source-url",
            "https://example.com/source/",
        ).run();
        expect(buildBundle).toHaveBeenCalledWith(
            root,
            expect.objectContaining({ sourceUrl: "https://example.com/source/" }),
        );
    });

    it.each([
        "html",
        "zip",
    ])("preserves existing artifacts when build %s validation fails", async (format) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-"));
        roots.push(root);
        writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
        mkdirSync(join(root, "content"));
        mkdirSync(join(root, "dist"));
        writeFileSync(join(root, "dooc.yaml"), "docs: [guide]\n");
        writeFileSync(join(root, "content/guide.md"), "---\ntitle: []\n---\nBody\n");
        for (const file of ["bundle.html", "bundle.zip"])
            writeFileSync(join(root, "dist", file), "Previous bundle");
        const result = cli("build", format, join(root, "dooc.yaml"));
        await expect(result.run()).rejects.toThrow("CLI exit");
        expect(result.stderr).toHaveBeenCalledWith(expect.stringContaining("validation failed"));
        for (const file of ["bundle.html", "bundle.zip"])
            expect(readFileSync(join(root, "dist", file), "utf8")).toBe("Previous bundle");
    });
});
