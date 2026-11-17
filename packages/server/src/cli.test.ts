import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zip } from "../../engine/src/compiler/zip.js";
import { createLocalPluginStorage } from "./plugins/local-storage.js";
import { terminal } from "./terminal.js";

vi.mock("./terminal.js", () => ({
    terminal: { ready: vi.fn(), info: vi.fn(), download: vi.fn(), close: vi.fn() },
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
    it.each(["editor", "reader"])("dispatches %s component commands", async (product) => {
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

    it("waits for downloaded docs before opening an isolated read-only reader", async () => {
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

    it("reports documentation download failures without starting a reader", async () => {
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
        expect(help).toContain("local read-only reader");
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
        expect(readManifest(root)).toMatchObject({
            format: "document",
            tree: [{ root: true, url: "", children: [] }],
            errors: [],
        });
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
                format: "document",
                tree: [{ root: true, url: "", children: [] }],
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
        const raw = "document: {}\n";
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

    it("injects an external Git origin into MCP without starting reader plugins", async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-mcp-"));
        roots.push(root);
        writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
        const module = join(root, "origin.mjs");
        writeFileSync(
            module,
            `export default {
            plugins: [],
            setup() { throw new Error("Reader setup must not run"); },
            gitOrigin: { name: "External", capabilities: [], async read() {}, async execute() {} },
        };`,
        );
        const startMcp = vi.fn().mockResolvedValue(undefined);
        vi.doMock("./mcp.js", () => ({ startMcp }));
        const args = [
            "editor",
            "run",
            "node",
            "--mcp",
            "--mcp-transport",
            "stdio",
            "--project",
            join(root, "dooc.yaml"),
        ];
        await cli(...args, "--reader-plugins", module).run();
        expect(startMcp).toHaveBeenCalledWith(
            root,
            {
                readOnly: false,
                gitOrigin: expect.objectContaining({
                    name: "External",
                    read: expect.any(Function),
                    execute: expect.any(Function),
                }),
            },
            expect.any(AbortSignal),
        );
        const invalid = cli(...args, "--unknown");
        await expect(invalid.run()).rejects.toThrow("CLI exit");
        expect(startMcp).toHaveBeenCalledTimes(1);
    });

    it("rejects the removed root MCP command with its replacement", async () => {
        const result = cli("mcp");
        await expect(result.run()).rejects.toThrow("CLI exit");
        expect(result.stderr).toHaveBeenCalledWith(
            expect.stringContaining("--mcp-transport stdio"),
        );
        expect(result.stderr).toHaveBeenCalledWith(expect.stringContaining("dooc relay"));
    });

    it.each([
        undefined,
        "team.dooc.yaml",
    ])("removes a plugin ZIP and its approval without executing it (manifest=%s)", async (manifest) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-plugin-remove-"));
        roots.push(root);
        const project = manifest ? join(root, "docs") : root;
        const folder = join(project, ".dooc/plugins");
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(project, manifest ?? "dooc.yaml"), "document: {}\n");
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
            { name: "index.mjs", data: Buffer.from("throw new Error('Plugin must not execute');") },
        ]);
        writeFileSync(join(folder, "example.zip"), archive);
        writeFileSync(join(folder, "other.zip"), archive);
        vi.stubEnv("DOOC_USER_DIR", join(root, "personal"));
        const personal = createLocalPluginStorage();
        const approval = `extensions-${createHash("sha256").update(realpathSync(project)).digest("hex")}.json`;
        const revision = createHash("sha256").update(archive).digest("hex");
        personal.write(approval, { "example.zip": revision, "other.zip": revision });
        const credentials = `credentials-${"a".repeat(64)}.json`;
        personal.write(credentials, { saved: true });
        const startServer = vi.fn();
        vi.doMock("./serve.js", () => ({ startServer }));
        const result = cli(
            "plugin",
            "remove",
            "example.zip",
            ...(manifest ? [join(project, manifest)] : []),
        );
        await result.run();
        expect(existsSync(join(folder, "example.zip"))).toBe(false);
        expect(readFileSync(join(folder, "other.zip"))).toEqual(archive);
        expect(personal.read(approval)).toEqual({ "other.zip": revision });
        expect(personal.read(credentials)).toEqual({ saved: true });
        expect(result.stdout).toHaveBeenCalledWith("Removed plugin: example.zip");
        expect(startServer).not.toHaveBeenCalled();
    });

    it.each([
        [[], "usage: dooc plugin"],
        [["../example.zip"], "Choose a plugin ZIP file"],
        [["missing.zip"], "Plugin not found: missing.zip"],
        [["example.zip", "dooc.yaml", "extra"], "usage: dooc plugin"],
    ])("rejects invalid plugin removal %j without deleting files", async (args, message) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-plugin-remove-invalid-"));
        roots.push(root);
        mkdirSync(join(root, ".dooc/plugins"), { recursive: true });
        writeFileSync(join(root, "dooc.yaml"), "document: {}\n");
        writeFileSync(join(root, ".dooc/plugins/example.zip"), "Keep this invalid package.");
        writeFileSync(join(root, "example.zip"), "Keep this external file.");
        vi.stubEnv("DOOC_USER_DIR", join(root, "personal"));
        const result = cli("plugin", "remove", ...args);
        await expect(result.run()).rejects.toThrow("CLI exit");
        expect(result.stderr).toHaveBeenCalledWith(expect.stringContaining(message));
        expect(readFileSync(join(root, ".dooc/plugins/example.zip"), "utf8")).toBe(
            "Keep this invalid package.",
        );
        expect(readFileSync(join(root, "example.zip"), "utf8")).toBe("Keep this external file.");
        expect(existsSync(join(root, "personal"))).toBe(false);
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
        expect(help).toContain("reader <build|run> <node|web>");
        expect(help).toContain("alias for editor run node --all");
        expect(help).toContain("alias for reader run node --all");
        expect(help).toContain("--mcp-transport stdio|http");
        expect(help).toContain("\n  relay ");
        expect(help).not.toMatch(/(?:^|\n)\s+mcp\b/);
        expect(help).not.toMatch(/(?:^|\n)\s+(?:preview|code-language|doc ls|figure ls)\b/);
        expect(help).not.toMatch(/[│├└─]/);
        expect(help).toContain("\n  build [dooc.yaml] [out-dir]");
        expect(help).toContain("\n  zip [dooc.yaml] [out-dir]");
        expect(help).toContain("<project>/build/index.html");
        expect(help).toContain("<project>/dist/bundle.zip");
        expect(help).toMatch(/\n {2}plugin[^\n]*\n {5}pack <built-dir> \[zip\]/);
        expect(help).toMatch(/\n {2}font[^\n]*\n {5}add <file> \[dooc.yaml\]/);
        expect(help).toContain("\n     --reader-plugins <module>");
        expect(help).toContain("\n     --source-url <url>");
        expect(help).toContain("--url_preview network|embed");
        expect(help).toContain("--mode static|live");
        expect(help).not.toMatch(/\n {2}export\b/);
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
        ["viewer"],
        ["viewer", "run", "node", "--all"],
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

    it.each([
        ["build", "usage: dooc build [dooc.yaml] [out-dir] [options]"],
        ["zip", "usage: dooc zip [dooc.yaml] [out-dir] [options]"],
    ])("shows %s --help without a workspace or output", async (command, usage) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-build-help-"));
        roots.push(root);
        for (const flag of ["--help", "-h"]) {
            const result = cli(command, flag);
            await result.run();
            expect(result.stdout).toHaveBeenCalledWith(expect.stringContaining(usage));
            expect(result.stderr).not.toHaveBeenCalled();
            expect(result.exit).not.toHaveBeenCalled();
        }
        expect(readdirSync(root)).toEqual([]);
    });

    it.each([
        [["export"], "dooc export was removed. Use dooc zip"],
        [["build", "html"], "dooc build no longer takes a format"],
        [["build", "zip"], "dooc build zip was replaced by dooc zip"],
        [["build", "github"], "GitHub output was removed"],
    ])("points the removed command %j to its replacement", async (args, message) => {
        const result = cli(...args);
        await expect(result.run()).rejects.toThrow("CLI exit");
        expect(result.exit).toHaveBeenCalledWith(1);
        expect(result.stdout).not.toHaveBeenCalled();
        expect(result.stderr).toHaveBeenCalledWith(expect.stringContaining(message));
    });

    it("shows a valid current manifest in check help", async () => {
        const result = cli("check", "--help");
        await result.run();
        const help = result.stdout.mock.calls[0]?.[0] as string;
        const example = /dooc.yaml example:\n([\s\S]+?)\n\nChecks:/.exec(help)?.[1];
        expect(example).toBeDefined();
        const { parseManifestText } = await import("../../engine/src/compiler/manifest.js");
        expect(parseManifestText(example?.replace(/^ {2}/gm, "") ?? "")).toMatchObject({
            format: "document",
            defaultLang: "jpn",
            languages: ["jpn", "eng"],
            themes: ["light", "dark"],
            tree: [{ root: true, url: "", children: [] }],
            errors: [],
        });
    });

    it.each([
        false,
        true,
    ])("zips sources without executing configuration or plugins (custom output=%s)", async (custom) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-zip-"));
        roots.push(root);
        mkdirSync(join(root, "docs"));
        writeFileSync(
            join(root, "dooc.yaml"),
            "document:\n  children:\n    - document:\n        url: docs/guide.md\n",
        );
        writeFileSync(join(root, "docs/guide.md"), "![](https://private.example/item)\n");
        writeFileSync(join(root, "docs.config.mjs"), 'throw new Error("Do not execute");');
        const out = join(root, custom ? "custom" : "dist");
        const result = cli("zip", join(root, "dooc.yaml"), ...(custom ? [out] : []));
        await result.run();
        expect(result.exit).not.toHaveBeenCalled();
        expect(readFileSync(join(out, "bundle.zip")).subarray(0, 2).toString()).toBe("PK");
        expect(result.stdout).toHaveBeenCalledWith(join(out, "bundle.zip"));
    });

    it("gives a named manifest its own output folders", async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-named-"));
        roots.push(root);
        writeFileSync(join(root, "guide.dooc.yaml"), "docs: []\n");
        const buildBundle = vi.fn().mockResolvedValue({ data: "Built artifact", docs: 0 });
        vi.doMock("./build.js", () => ({ buildBundle }));
        await cli("build", join(root, "guide.dooc.yaml")).run();
        await cli("zip", join(root, "guide.dooc.yaml")).run();
        expect(readFileSync(join(root, "build/guide/index.html"), "utf8")).toBe("Built artifact");
        expect(readFileSync(join(root, "dist/guide/bundle.zip")).subarray(0, 2).toString()).toBe(
            "PK",
        );
        // An explicit output directory is used as it is.
        await cli("build", join(root, "guide.dooc.yaml"), join(root, "site")).run();
        expect(readFileSync(join(root, "site/index.html"), "utf8")).toBe("Built artifact");
    });

    it.each([
        "extra",
        "--unknown",
    ])("rejects invalid zip argument %s before replacing output", async (argument) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-zip-invalid-"));
        roots.push(root);
        writeFileSync(join(root, "dooc.yaml"), "document: {}\n");
        const out = join(root, "dist");
        mkdirSync(out);
        writeFileSync(join(out, "bundle.zip"), "Previous bundle");
        const result = cli("zip", join(root, "dooc.yaml"), out, argument);
        await expect(result.run()).rejects.toThrow("CLI exit");
        expect(result.exit).toHaveBeenCalledWith(1);
        expect(result.stderr).toHaveBeenCalledWith(
            expect.stringContaining(
                argument === "extra"
                    ? "zip accepts a dooc.yaml path and an output directory"
                    : "Unknown option",
            ),
        );
        expect(result.stdout).not.toHaveBeenCalled();
        expect(readFileSync(join(out, "bundle.zip"), "utf8")).toBe("Previous bundle");
    });

    it("rejects unsupported build and zip options without writing output", async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-options-"));
        roots.push(root);
        const manifest = join(root, "dooc.yaml");
        writeFileSync(manifest, "docs: []\n");
        for (const args of [
            ["build", "pdf"],
            ["build", manifest, "--lang", "eng"],
            ["build", manifest, "--html", "static"],
            ["build", manifest, "--mode", "embed"],
            ["build", manifest, "--mode", "static", "--url_preview", "network"],
            ["build", manifest, "--download", "invalid"],
            ["build", manifest, "--download"],
            ["build", manifest, "--easy-download"],
            ["build", manifest, "--url_preview", "static"],
            ["build", manifest, "--target", "pages"],
            ["zip", manifest, "--zip", "embed"],
            ["zip", manifest, "--mode", "static"],
            ["zip", manifest, "--download", "easy"],
            ["zip", manifest, "--reader-plugins", "./plugins.mjs"],
            ["zip", manifest, "--url_preview", "reference"],
            ["zip", manifest, "--target", "github"],
            ["build", manifest, "--target", "github"],
            ["build", manifest, "--resources", "reference"],
        ]) {
            const result = cli(...args);
            await expect(result.run()).rejects.toThrow("CLI exit");
            expect(result.exit).toHaveBeenCalledWith(1);
        }
        expect(readdirSync(root)).toEqual(["dooc.yaml"]);
    });

    it.each([
        ["build", [], "build/index.html", { format: "html", urlPreview: "network" }],
        [
            "build",
            ["--url_preview", "embed"],
            "index.html",
            { format: "html", urlPreview: "embed" },
        ],
        [
            "build",
            ["--mode", "static"],
            "build/index.html",
            { format: "html", mode: "static", urlPreview: "embed" },
        ],
        ["zip", ["--url_preview=embed"], "bundle.zip", { format: "zip", urlPreview: "embed" }],
    ] as const)("writes only its own artifact for %s %j", async (command, options, file, expected) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-build-"));
        roots.push(root);
        writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
        const custom = !file.includes("/");
        const out = join(root, custom ? "custom" : dirname(file));
        mkdirSync(out);
        const other = join(out, "keep.txt");
        writeFileSync(other, "Keep existing file");
        const buildBundle = vi.fn().mockResolvedValue({ data: "Built artifact", docs: 1 });
        vi.doMock("./build.js", () => ({ buildBundle }));
        const result = cli(command, join(root, "dooc.yaml"), ...(custom ? [out] : []), ...options);
        await result.run();
        expect(buildBundle).toHaveBeenCalledWith(root, expected);
        expect(readFileSync(join(out, basename(file)), "utf8")).toBe("Built artifact");
        expect(readFileSync(other, "utf8")).toBe("Keep existing file");
        expect(readdirSync(root).sort()).toEqual([custom ? "custom" : dirname(file), "dooc.yaml"]);
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
        "easy",
        "normal",
        "block",
    ])("selects download=%s for an HTML build", async (download) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-download-"));
        roots.push(root);
        writeFileSync(join(root, "dooc.yaml"), "docs: []\n");
        const buildBundle = vi.fn().mockResolvedValue({ data: "Built artifact", docs: 0 });
        vi.doMock("./build.js", () => ({ buildBundle }));
        await cli("build", join(root, "dooc.yaml"), "--download", download).run();
        expect(buildBundle).toHaveBeenCalledWith(root, expect.objectContaining({ download }));
    });

    it.each([
        ["build", [], "build/index.html"],
        ["zip", ["--url_preview", "embed"], "dist/bundle.zip"],
    ] as const)("preserves the existing artifact when %s validation fails", async (command, options, file) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-"));
        roots.push(root);
        mkdirSync(join(root, "content"));
        mkdirSync(join(root, dirname(file)));
        writeFileSync(join(root, "dooc.yaml"), "docs: [guide]\n");
        writeFileSync(join(root, "content/guide.md"), "---\ntitle: Guide\n---\n");
        writeFileSync(join(root, file), "Previous bundle");
        const result = cli(command, join(root, "dooc.yaml"), ...options);
        await expect(result.run()).rejects.toThrow("CLI exit");
        expect(result.stderr).toHaveBeenCalledWith(expect.stringContaining("validation failed"));
        expect(readFileSync(join(root, file), "utf8")).toBe("Previous bundle");
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
