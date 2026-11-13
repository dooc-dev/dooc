import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareSelfDocs, selfUpdate } from "./self.js";

const assets = vi.hoisted(() => ({ standalone: true, prebuilt: false }));
vi.mock("./assets.js", async (original) => ({
    ...(await original<typeof import("./assets.js")>()),
    get standalone() {
        return assets.standalone;
    },
    get prebuilt() {
        return assets.prebuilt;
    },
}));
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }));

afterEach(() => {
    assets.standalone = true;
    assets.prebuilt = false;
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

describe("self update", () => {
    it("updates the resolved executable using the bundled checksum-verifying installer", () => {
        vi.spyOn(fs, "realpathSync").mockReturnValue("/tmp/custom install/renamed-dooc");
        vi.stubEnv("DOOC_VERSION", "0.0.1");
        vi.stubEnv("DOOC_INSTALL_DIR", "/somewhere/else");
        selfUpdate();
        expect(execFileSync).toHaveBeenCalledWith("sh", ["-s"], {
            input: expect.any(Buffer),
            stdio: ["pipe", "inherit", "inherit"],
            env: expect.objectContaining({
                DOOC_VERSION: "latest",
                DOOC_INSTALL_PATH: "/tmp/custom install/renamed-dooc",
            }),
        });
        const options = vi.mocked(execFileSync).mock.calls[0]?.[2];
        expect(options?.input?.toString()).toContain("Checksum mismatch");
    });

    it.each([
        ["/opt/homebrew/Cellar/dooc/1.0/bin/dooc", "brew upgrade"],
        ["/home/a/.local/share/mise/installs/github-dooc-dev-dooc/1.0/dooc", "mise upgrade"],
    ])("keeps package-manager files untouched at %s", (path, command) => {
        vi.spyOn(fs, "realpathSync").mockReturnValue(path);
        expect(selfUpdate).toThrow(command);
        expect(execFileSync).not.toHaveBeenCalled();
    });

    it("refuses to replace the runtime or modify a source checkout", () => {
        assets.standalone = false;
        expect(selfUpdate).toThrow("source checkout");
        expect(execFileSync).not.toHaveBeenCalled();
    });

    it("updates a global npm installation through npm", () => {
        assets.standalone = false;
        assets.prebuilt = true;
        vi.mocked(execFileSync).mockReturnValue("/global/node_modules\n");
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        vi.spyOn(fs, "realpathSync").mockReturnValue("/global/node_modules/@dooc-dev/dooc");
        selfUpdate();
        expect(execFileSync).toHaveBeenLastCalledWith(
            "npm",
            ["install", "--global", "@dooc-dev/dooc@latest"],
            { stdio: "inherit" },
        );
    });

    it("does not turn a local or npx package into a global installation", () => {
        assets.standalone = false;
        assets.prebuilt = true;
        vi.mocked(execFileSync).mockReturnValue("/global/node_modules\n");
        vi.spyOn(fs, "existsSync").mockReturnValue(false);
        expect(selfUpdate).toThrow("not a global npm installation");
        expect(execFileSync).toHaveBeenCalledTimes(1);
    });

    it("propagates installer failures", () => {
        vi.spyOn(fs, "realpathSync").mockReturnValue("/tmp/dooc");
        vi.mocked(execFileSync).mockImplementation(() => {
            throw new Error("Download failed");
        });
        expect(selfUpdate).toThrow("Download failed");
    });
});

const archive = (files: Record<string, string> = {}) =>
    zipSync(
        Object.fromEntries(
            Object.entries({
                "dooc-main/dooc-docs/dooc.yaml": "docs: [guide]\n",
                "dooc-main/dooc-docs/contents/md/guide.md": "# Downloaded docs\n",
                ...files,
            }).map(([name, content]) => [name, strToU8(content)]),
        ),
    );

it("downloads only documentation into a disposable viewer root without requiring Git", async () => {
    const fetch = vi.fn().mockResolvedValue(
        new Response(
            archive({
                "dooc-main/package.json": "{}",
                "dooc-main/dooc-docs/.dooc/private": "Do not copy hidden files",
                "dooc-main/dooc-docs/themes/dark/icon.svg": "dark",
                "dooc-main/dooc-docs/themes/light/icon.svg": "light",
            }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const docs = await prepareSelfDocs();
    try {
        expect(fetch).toHaveBeenCalledWith(
            "https://codeload.github.com/dooc-dev/dooc/zip/refs/heads/main",
            { signal: expect.any(AbortSignal) },
        );
        expect(fs.readFileSync(join(docs.root, "dooc.yaml"), "utf8")).toBe("docs: [guide]\n");
        expect(fs.readFileSync(join(docs.root, "contents/md/guide.md"), "utf8")).toBe(
            "# Downloaded docs\n",
        );
        expect(fs.readFileSync(join(docs.root, "themes/dark/icon.svg"), "utf8")).toBe("dark");
        expect(fs.readFileSync(join(docs.root, "themes/light/icon.svg"), "utf8")).toBe("light");
        expect(fs.existsSync(join(docs.root, "package.json"))).toBe(false);
        expect(fs.existsSync(join(docs.root, ".dooc"))).toBe(false);
        expect(execFileSync).not.toHaveBeenCalled();
    } finally {
        docs.dispose();
    }
    expect(fs.existsSync(docs.root)).toBe(false);
});

it.each([
    "../escape.md",
    "/absolute.md",
    "folder/../../escape.md",
    "folder\\escape.md",
    "C:/escape.md",
    "guide.md:stream",
    "folder./guide.md",
])("rejects unsafe downloaded paths and removes the temporary root: %s", async (path) => {
    const temporary = vi.spyOn(fs, "mkdtempSync");
    vi.stubGlobal(
        "fetch",
        vi
            .fn()
            .mockResolvedValue(
                new Response(archive({ [`dooc-main/dooc-docs/${path}`]: "unsafe" })),
            ),
    );
    await expect(prepareSelfDocs()).rejects.toThrow("Invalid documentation path");
    expect(temporary.mock.results.every(({ value }) => !fs.existsSync(value))).toBe(true);
});

it.each([
    ["HTTP error", () => new Response("Unavailable", { status: 503 }), "HTTP 503"],
    [
        "invalid ZIP",
        () => new Response("Not a ZIP"),
        "Failed to download documentation from GitHub",
    ],
    [
        "missing docs",
        () => new Response(zipSync({ "dooc-main/package.json": strToU8("{}") })),
        "does not contain dooc-docs/dooc.yaml",
    ],
    [
        "duplicate path",
        () => new Response(archive({ "dooc-main/dooc-docs/DOOC.yaml": "duplicate" })),
        "Duplicate documentation path",
    ],
    [
        "file/directory conflict",
        () => new Response(archive({ "dooc-main/dooc-docs/contents/md": "conflict" })),
        "Failed to download documentation from GitHub",
    ],
] as const)("cleans up when GitHub returns %s", async (_name, response, message) => {
    const temporary = vi.spyOn(fs, "mkdtempSync");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
    await expect(prepareSelfDocs()).rejects.toThrow(message);
    expect(temporary.mock.results.every(({ value }) => !fs.existsSync(value))).toBe(true);
});

it("reports connection failures and removes the temporary root", async () => {
    const temporary = vi.spyOn(fs, "mkdtempSync");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection unavailable")));
    await expect(prepareSelfDocs()).rejects.toThrow(
        "Failed to download documentation from GitHub: Connection unavailable",
    );
    expect(temporary.mock.results.every(({ value }) => !fs.existsSync(value))).toBe(true);
});

it("bounds downloaded bytes even without a Content-Length header", async () => {
    const temporary = vi.spyOn(fs, "mkdtempSync");
    const chunk = new Uint8Array(1024 * 1024);
    const cancel = vi.fn();
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
            new Response(
                new ReadableStream({
                    pull(controller) {
                        controller.enqueue(chunk);
                    },
                    cancel,
                }),
            ),
        ),
    );
    await expect(prepareSelfDocs()).rejects.toThrow("archive exceeds 128 MiB");
    expect(cancel).toHaveBeenCalledOnce();
    expect(temporary.mock.results.every(({ value }) => !fs.existsSync(value))).toBe(true);
});

it("bounds expanded bytes before decompressing archive entries", async () => {
    const temporary = vi.spyOn(fs, "mkdtempSync");
    const bytes = Buffer.from(archive());
    const header = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(256 * 1024 * 1024 + 1, header + 24);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytes)));
    await expect(prepareSelfDocs()).rejects.toThrow("Documentation exceeds");
    expect(temporary.mock.results.every(({ value }) => !fs.existsSync(value))).toBe(true);
});

it("rejects stored entries that understate their extracted size", async () => {
    const bytes = Buffer.from(
        zipSync({ "dooc-main/dooc-docs/dooc.yaml": strToU8("docs: []\n") }, { level: 0 }),
    );
    const header = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(0, header + 24);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytes)));
    await expect(prepareSelfDocs()).rejects.toThrow("Invalid documentation file size");
});
