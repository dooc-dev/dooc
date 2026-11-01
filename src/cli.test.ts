import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDocsJsonSchema, listDocsJsonSchemas } from "./core/docs-json-schema.js";
import { GENERATION } from "./core/generation.js";

const originalArgv = process.argv;
afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
});

const cli = (...args: string[]) => {
    vi.resetModules();
    process.argv = [process.execPath, "cli.js", "json-schema", ...args];
    vi.spyOn(process, "cwd").mockReturnValue(tmpdir());
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("CLI exit");
    });
    return { stdout, stderr, exit, run: () => import("./cli.js") };
};

describe("json-schema CLI", () => {
    it("lists bundled versions without a docs root", async () => {
        const result = cli("ls");
        await result.run();
        expect(result.stdout.mock.calls).toEqual([[listDocsJsonSchemas().join("\n")]]);
        expect(result.stderr).not.toHaveBeenCalled();
        expect(result.exit).not.toHaveBeenCalled();
    });

    it.each([
        "latest",
        String(GENERATION),
    ])("prints only the selected JSON Schema: %s", async (version) => {
        const result = cli(version);
        await result.run();
        expect(result.stdout.mock.calls).toEqual([
            [JSON.stringify(getDocsJsonSchema(version), null, 2)],
        ]);
        expect(result.stderr).not.toHaveBeenCalled();
        expect(result.exit).not.toHaveBeenCalled();
    });

    it.each([
        [],
        ["999"],
        ["../10"],
        ["latest", "extra"],
        ["ls", "extra"],
    ])("rejects invalid arguments: %j", async (...args) => {
        const result = cli(...args);
        await expect(result.run()).rejects.toThrow("CLI exit");
        expect(result.exit).toHaveBeenCalledWith(1);
        expect(result.stdout).not.toHaveBeenCalled();
        expect(result.stderr).toHaveBeenCalledWith(
            expect.stringMatching(/usage:|Unknown docs.json schema version/),
        );
    });
});
