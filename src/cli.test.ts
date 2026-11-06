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
    it.each([[], ["help"], ["--help"], ["-h"]])("shows help for %j", async (...args) => {
        const result = cli(...args);
        await result.run();
        const help = result.stdout.mock.calls[0]?.[0];
        expect(help).toContain("edit [root] [port]");
        expect(help).toContain("view [root] [port]");
        expect(help).toContain("mcp [root]");
        expect(help).not.toMatch(/preview|code-language|doc ls|figure ls/);
        expect(help).toContain("export zip");
        expect(help).toContain("export html");
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
        expect(startServer).toHaveBeenLastCalledWith(mode, 4321);
        expect(process.env.DOCS_ROOT).toBe(tmpdir());
        expect(process.env.DOCS_HMR).toBe("1");
        await cli(command).run();
        expect(startServer).toHaveBeenLastCalledWith(mode, 5179);
        expect(process.env.DOCS_ROOT).toBe(tmpdir());
    });

    it.each([
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
        expect(result.stderr).toHaveBeenCalledWith(
            expect.stringMatching(/export format must be zip \| html|unknown command/),
        );
    });

    it("rejects the removed export language option", async () => {
        const result = cli("export", "html", "--lang", "eng");
        await expect(result.run()).rejects.toThrow("Unknown option '--lang'");
    });

    it("preserves an existing HTML export when source validation fails", async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-cli-"));
        roots.push(root);
        mkdirSync(join(root, "content"));
        writeFileSync(join(root, "dooc.yaml"), "docs: [guide]\n");
        writeFileSync(join(root, "content/guide.md"), "---\ntitle: []\n---\nBody\n");
        const out = join(root, "index.html");
        writeFileSync(out, "Previous export");
        const result = cli("export", "html", root, out);
        await expect(result.run()).rejects.toThrow("CLI exit");
        expect(result.stderr).toHaveBeenCalledWith(expect.stringContaining("validation failed"));
        expect(readFileSync(out, "utf8")).toBe("Previous export");
    });
});
