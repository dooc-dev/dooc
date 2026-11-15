import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminal } from "./terminal.js";

vi.mock("./terminal.js", () => ({
    terminal: { info: vi.fn(), download: vi.fn(), close: vi.fn() },
}));

const originalArgv = process.argv;
const roots: string[] = [];
afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.doUnmock("./serve.js");
    vi.doUnmock("./assets.js");
    vi.doUnmock("./build.js");
    vi.doUnmock("./mcp.js");
    vi.doUnmock("./mcp-relay.js");
    vi.doUnmock("./self.js");
    vi.doUnmock("./git-workspace.js");
    vi.doUnmock("./static-client.js");
    vi.doUnmock("./workspace-server.js");
    vi.doUnmock("./application.js");
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const cli = (...args: string[]) => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DOOC_REMOTE_WORKSPACE", "");
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
    it("dispatches the hosted relay without opening a Node workspace", async () => {
        const relayCommand = vi.fn();
        vi.doMock("./mcp-relay.js", () => ({ relayCommand }));
        await cli(
            "mcp",
            "relay",
            "--public-url",
            "https://relay.example",
            "--client-origin",
            "https://web.example",
        ).run();
        expect(relayCommand).toHaveBeenCalledWith([
            "--public-url",
            "https://relay.example",
            "--client-origin",
            "https://web.example",
        ]);
    });
    it.each(["editor", "viewer"])("dispatches %s component commands", async (product) => {
        const applicationCommand = vi.fn();
        vi.doMock("./application.js", () => ({ applicationCommand }));
        await cli(product, "run", "node", "--all", "--port", "4000").run();
        expect(applicationCommand).toHaveBeenCalledWith(product, [
            "run",
            "node",
            "--all",
            "--port",
            "4000",
        ]);
    });
    it("dispatches self update", async () => {
        const selfUpdate = vi.fn();
        vi.doMock("./self.js", () => ({ selfUpdate, prepareSelfDocs: vi.fn() }));
        await cli("self", "update").run();
        expect(selfUpdate).toHaveBeenCalledOnce();
    });

    it("waits for downloaded docs before opening an isolated read-only viewer", async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-self-"));
        roots.push(root);
        const dispose = vi.fn();
        let complete!: (docs: { root: string; dispose: () => void }) => void;
        const download = new Promise<{ root: string; dispose: () => void }>((resolve) => {
            complete = resolve;
        });
        const prepareSelfDocs = vi.fn(() => download);
        const startServer = vi.fn();
        vi.doMock("./self.js", () => ({ prepareSelfDocs, selfUpdate: vi.fn() }));
        vi.doMock("./serve.js", () => ({ startServer }));
        vi.stubEnv("DOCS_ROOT", "/other/project");
        vi.stubEnv("DOCS_HMR", "1");
        const once = vi.spyOn(process, "once").mockReturnValue(process);
        const result = cli("self", "docs");
        const pending = result.run();
        await vi.waitFor(() => expect(prepareSelfDocs).toHaveBeenCalledOnce());
        expect(terminal.info).toHaveBeenCalledWith("Downloading documentation from GitHub...");
        expect(startServer).not.toHaveBeenCalled();
        expect(process.env.DOCS_ROOT).toBe("/other/project");
        expect(process.env.DOCS_HMR).toBe("1");
        complete({ root, dispose });
        await pending;
        expect(process.env.DOCS_ROOT).toBe(root);
        expect(process.env.DOCS_HMR).toBe("0");
        expect(startServer).toHaveBeenCalledWith("preview", 5179, undefined, { open: true });
        expect(once).toHaveBeenCalledWith("exit", dispose);
        const cleanup = once.mock.calls.find(([event]) => event === "exit")?.[1];
        cleanup?.();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it("reports documentation download failures without starting a viewer", async () => {
        const message = "Failed to download documentation from GitHub: network unavailable";
        vi.doMock("./self.js", () => ({
            prepareSelfDocs: vi.fn().mockRejectedValue(new Error(message)),
            selfUpdate: vi.fn(),
        }));
        const startServer = vi.fn();
        vi.doMock("./serve.js", () => ({ startServer }));
        vi.stubEnv("DOCS_ROOT", "/other/project");
        vi.stubEnv("DOCS_HMR", "1");
        const result = cli("self", "docs");
        await expect(result.run()).rejects.toThrow("CLI exit");
        expect(result.stderr).toHaveBeenCalledWith(message);
        expect(result.exit).toHaveBeenCalledWith(1);
        expect(startServer).not.toHaveBeenCalled();
        expect(process.env.DOCS_ROOT).toBe("/other/project");
        expect(process.env.DOCS_HMR).toBe("1");
    });

    it.each([
        [],
        ["unknown"],
        ["update", "extra"],
        ["docs", "other/dooc.yaml"],
        ["docs", "--unknown"],
    ])("rejects invalid self arguments %j without side effects", async (...args) => {
        const selfUpdate = vi.fn();
        const prepareSelfDocs = vi.fn();
        vi.doMock("./self.js", () => ({ selfUpdate, prepareSelfDocs }));
        const result = cli("self", ...args);
        await expect(result.run()).rejects.toThrow("CLI exit");
        expect(selfUpdate).not.toHaveBeenCalled();
        expect(prepareSelfDocs).not.toHaveBeenCalled();
    });

    it.each([[], ["update"], ["docs"]])("shows self help for %j", async (...args) => {
        const result = cli("self", ...args, "--help");
        await result.run();
        expect(result.stdout).toHaveBeenCalledWith(expect.stringContaining("usage: dooc self"));
        const help = result.stdout.mock.calls[0]?.[0] as string;
        expect(help).toContain("download documentation from GitHub");
        expect(help).toContain("local read-only viewer");
        expect(help).toContain("requires a network connection");
        expect(help).not.toMatch(/bundled|offline/);
        expect(result.exit).not.toHaveBeenCalled();
    });

    it("reports failed updates as CLI errors", async () => {
        vi.doMock("./self.js", () => ({
            prepareSelfDocs: vi.fn(),
            selfUpdate: () => {
                throw new Error("Update failed");
            },
        }));
        const result = cli("self", "update");
        await expect(result.run()).rejects.toThrow("CLI exit");
        expect(result.stderr).toHaveBeenCalledWith("Update failed");
    });

    it("initializes a manifest that supports adding the first document", async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-init-"));
        roots.push(root);
        const result = cli("init");
        await result.run();
        expect(readdirSync(root)).toEqual(["dooc.yaml"]);
        const { readManifest } = await import("../../engine/src/compiler/manifest.js");
        expect(readManifest(root)).toMatchObject({ format: "nested", tree: [], errors: [] });
        expect(result.stdout).toHaveBeenCalledWith(
            expect.stringContaining("dooc editor run node --client --server --project"),
        );
        const { createDocOps } = await import("../../engine/src/compiler/ops.js");
        expect(createDocOps(root).addFile("guide.md", "Guide")).not.toHaveProperty("error");
        const { compileSite } = await import("../../engine/src/compiler/compile.js");
        expect(compileSite(root).errors).toEqual([]);
    });

    it.each([
        ["docs/nested", "docs/nested/dooc.yaml"],
        ["docs/dooc.yaml", "docs/dooc.yaml"],
        ["docs/team.dooc.yaml", "docs/team.dooc.yaml"],
        ["team.dooc.yaml", "team.dooc.yaml"],
    ])("initializes the selected path %s", async (input, output) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-init-path-"));
        roots.push(root);
        for (const target of [input, join(root, "absolute", input)]) {
            const result = cli("init", target);
            await result.run();
            const file = target === input ? join(root, output) : join(root, "absolute", output);
            expect(existsSync(file)).toBe(true);
            const { readManifest, projectRoot } = await import(
                "../../engine/src/compiler/manifest.js"
            );
            expect(readManifest(projectRoot(file))).toMatchObject({
                format: "nested",
                tree: [],
                errors: [],
            });
            expect(result.stdout).toHaveBeenCalledWith(expect.stringContaining(file));
        }
        expect(existsSync(join(root, "dooc.yaml"))).toBe(false);
    });

    it.each([
        ["dooc.yaml", false],
        ["dooc.yaml", true],
        ["team.dooc.yaml", false],
        ["team.dooc.yaml", true],
    ])("preserves an existing %s (symlink=%s)", async (name, symlink) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-init-existing-"));
        roots.push(root);
        const manifest = join(root, name);
        const target = symlink ? join(root, "existing.yaml") : manifest;
        const raw = "# Keep this configuration\ncenter_contents: []\n";
        writeFileSync(target, raw);
        if (symlink) symlinkSync(target, manifest);
        const result = cli("init", name);
        await expect(result.run()).rejects.toThrow("CLI exit");
        expect(result.exit).toHaveBeenCalledWith(1);
        expect(result.stderr).toHaveBeenCalledWith(expect.stringContaining("already exists"));
        expect(readFileSync(manifest, "utf8")).toBe(raw);
        expect(readFileSync(target, "utf8")).toBe(raw);
    });

    it.each([
        ["--help"],
        ["-h"],
        ["--unknown"],
        ["--force"],
        ["one", "two"],
    ])("does not create a manifest for init %s", async (...args) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-init-args-"));
        roots.push(root);
        const result = cli("init", ...args);
        if (args[0] === "--help" || args[0] === "-h") {
            await result.run();
            expect(result.stdout).toHaveBeenCalledWith(expect.stringContaining("dooc init"));
            expect(result.exit).not.toHaveBeenCalled();
        } else {
            await expect(result.run()).rejects.toThrow("CLI exit");
            expect(result.exit).toHaveBeenCalledWith(1);
        }
        expect(readdirSync(root)).toEqual([]);
    });

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
        const file = new URL("./fonts/udev-gothic-regular.woff2", import.meta.url).pathname;
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
        expect(help).toContain("init");
        expect(help).toContain("editor <build|run> <node|web>");
        expect(help).toContain("viewer <build|run> <node|web>");
        expect(help).toContain("alias for editor run node --all");
        expect(help).toContain("alias for viewer run node --all");
        expect(help).toContain("mcp [dooc.yaml]");
        expect(help).not.toMatch(/(?:^|\n)\s+(?:preview|code-language|doc ls|figure ls)\b/);
        expect(help).not.toMatch(/[│├└─]/);
        expect(help).toMatch(/\n {2}build[^\n]*\n {5}html \[dooc.yaml\] \[out-dir\]/);
        expect(help).toContain("\n     zip [dooc.yaml] [out-dir]");
        expect(help).toMatch(/\n {2}plugin[^\n]*\n {5}pack <built-dir> \[zip\]/);
        expect(help).toMatch(/\n {2}font[^\n]*\n {5}add <file> \[dooc.yaml\]/);
        expect(help).toContain("\n     --viewer-plugins <module>");
        expect(help).toContain("\n        --source-url <url>");
        expect(help).toContain("\n     --git-origin <module>");
        expect(help).toContain("--url_preview embed|network");
        expect(help).toContain("--mode static|live");
        expect(help).toContain("export [dooc.yaml] [out-dir]");
        expect(help).not.toMatch(/export json|json-schema/);
        expect(result.stderr).not.toHaveBeenCalled();
        expect(result.exit).not.toHaveBeenCalled();
    });

    it.each([true, false])("sets the runtime environment for prebuilt=%s", async (prebuilt) => {
        vi.doMock("./assets.js", () => ({ prebuilt }));
        await cli("help").run();
        expect(process.env.NODE_ENV).toBe(prebuilt ? "production" : "development");
    });

    it.each([
        ["json-schema", "latest"],
        ["preview"],
        ["edit"],
        ["view"],
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

    it.each(["--help", "-h"])("shows export %s without a workspace or output", async (flag) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-export-help-"));
        roots.push(root);
        const result = cli("export", flag);
        await result.run();
        expect(result.stdout).toHaveBeenCalledWith(
            expect.stringContaining("usage: dooc export [dooc.yaml] [out-dir]"),
        );
        expect(result.stderr).not.toHaveBeenCalled();
        expect(result.exit).not.toHaveBeenCalled();
        expect(readdirSync(root)).toEqual([]);
    });

    it("shows a valid current manifest in check help", async () => {
        const result = cli("check", "--help");
        await result.run();
        const help = result.stdout.mock.calls[0]?.[0] as string;
        const example = /dooc.yaml example:\n([\s\S]+?)\n\nChecks:/.exec(help)?.[1];
        expect(example).toBeDefined();
        const { parseManifestText } = await import("../../engine/src/compiler/manifest.js");
        expect(parseManifestText(example?.replace(/^ {2}/gm, "") ?? "")).toMatchObject({
            format: "nested",
            defaultLang: "jpn",
            languages: ["jpn", "eng"],
            themes: ["light", "dark"],
            tree: [],
            errors: [],
        });
    });

    it.each([
        false,
        true,
    ])("exports sources without executing configuration or plugins (custom output=%s)", async (custom) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-export-"));
        roots.push(root);
        mkdirSync(join(root, "docs"));
        writeFileSync(join(root, "dooc.yaml"), "center_contents:\n  - file: docs/guide.md\n");
        writeFileSync(join(root, "docs/guide.md"), "![](https://private.example/item)\n");
        writeFileSync(join(root, "docs.config.mjs"), 'throw new Error("Do not execute");');
        const out = join(root, custom ? "custom" : "dist");
        const result = cli("export", join(root, "dooc.yaml"), ...(custom ? [out] : []));
        await result.run();
        expect(result.exit).not.toHaveBeenCalled();
        expect(readFileSync(join(out, "bundle.zip")).subarray(0, 2).toString()).toBe("PK");
        expect(result.stdout).toHaveBeenCalledWith(join(out, "bundle.zip"));
    });

    it.each([
        "extra",
        "--unknown",
    ])("rejects invalid export argument %s before replacing output", async (argument) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-export-invalid-"));
        roots.push(root);
        writeFileSync(join(root, "dooc.yaml"), "center_contents: []\n");
        const out = join(root, "dist");
        mkdirSync(out);
        writeFileSync(join(out, "bundle.zip"), "Previous bundle");
        const result = cli("export", join(root, "dooc.yaml"), out, argument);
        await expect(result.run()).rejects.toThrow("CLI exit");
        expect(result.exit).toHaveBeenCalledWith(1);
        expect(result.stderr).toHaveBeenCalledWith(
            expect.stringContaining(
                argument === "extra"
                    ? "export accepts a dooc.yaml path and an output directory"
                    : "Unknown option",
            ),
        );
        expect(result.stdout).not.toHaveBeenCalled();
        expect(readFileSync(join(out, "bundle.zip"), "utf8")).toBe("Previous bundle");
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
            ["zip", "--easy-download"],
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
        vi.doMock("./build.js", () => ({ buildBundle }));
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
        vi.doMock("./build.js", () => ({ buildBundle }));
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

    it("enables easy download for an HTML build", async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-download-"));
        roots.push(root);
        writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
        const buildBundle = vi.fn().mockResolvedValue({ data: "Built artifact", docs: 0 });
        vi.doMock("./build.js", () => ({ buildBundle }));
        await cli("build", "html", join(root, "dooc.yaml"), "--easy-download").run();
        expect(buildBundle).toHaveBeenCalledWith(
            root,
            expect.objectContaining({ easyDownload: true }),
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
        writeFileSync(join(root, "content/guide.md"), "---\ntitle: Guide\n---\n");
        for (const file of ["bundle.html", "bundle.zip"])
            writeFileSync(join(root, "dist", file), "Previous bundle");
        const result = cli("build", format, join(root, "dooc.yaml"));
        await expect(result.run()).rejects.toThrow("CLI exit");
        expect(result.stderr).toHaveBeenCalledWith(expect.stringContaining("validation failed"));
        for (const file of ["bundle.html", "bundle.zip"])
            expect(readFileSync(join(root, "dist", file), "utf8")).toBe("Previous bundle");
    });
});

it.each([
    ["server"],
    ["client"],
    ["build", "client"],
])("rejects removed commands: %j", async (...args) => {
    const result = cli(...args);
    await expect(result.run()).rejects.toThrow("CLI exit");
    expect(result.exit).toHaveBeenCalledWith(1);
});
