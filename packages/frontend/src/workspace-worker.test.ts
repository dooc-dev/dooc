import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { filesSnapshot } from "../../engine/src/compiler/files.js";
import { memoryFiles, persistFiles, readDirectory } from "../../workspace/src/browser-storage.js";
import { applicationRequest } from "./application-request.js";
import { createMcpOperations } from "./mcp-operations.js";

vi.mock("../../engine/src/compiler/files.js", () => ({
    completeFilePaths: vi.fn(),
    filesSnapshot: vi.fn(() => ({ files: [] })),
    updateFiles: vi.fn(),
    uploadFile: vi.fn(),
}));
vi.mock("../../engine/src/compiler/manifest.js", async (original) => ({
    ...(await original<typeof import("../../engine/src/compiler/manifest.js")>()),
    projectRoot: () => "/workspace",
}));
vi.mock("../../workspace/src/browser-storage.js", () => ({
    changedFiles: () => [],
    memoryFiles: vi.fn(() => new Map()),
    persistFiles: vi.fn(),
    readDirectory: vi.fn(async () => new Map()),
    replaceMemory: vi.fn(),
}));
vi.mock("./document-application.js", () => ({
    createDocumentApplication: () => ({ configure: vi.fn() }),
}));
vi.mock("./application-request.js", () => ({
    applicationRequest: vi.fn(async () => ({ status: 200, headers: {}, body: "preview" })),
}));
vi.mock("./mcp-operations.js", () => ({
    createMcpOperations: vi.fn(() => ({
        read_doc: () => ({ raw: "Original" }),
        write_doc: vi.fn(),
    })),
}));

let receive: (event: { data: unknown }) => void;
const send = vi.fn();
let id = 0;
const reply = async (op: string, args: Record<string, unknown>) => {
    const current = ++id;
    receive({ data: { id: current, op, args } });
    await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: current })),
    );
    return send.mock.calls.find(([message]) => message.id === current)?.[0];
};
const request = async (op: string, args: Record<string, unknown>) => {
    const response = await reply(op, args);
    expect(response).not.toHaveProperty("error");
    return response.value;
};

beforeEach(async () => {
    vi.stubGlobal("DOOC_READ_ONLY", false);
    vi.stubGlobal("DOOC_MCP", false);
    vi.resetModules();
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("self", {
        postMessage: send,
        addEventListener: (_event: string, handler: typeof receive) => {
            receive = handler;
        },
    });
    await import("./workspace-worker.js");
    await request("initialize", { directory: { kind: "directory", name: "fixture" } });
    vi.clearAllMocks();
});

describe("viewer Worker", () => {
    it("rejects workspace creation and mutations, renders previews, and never persists files", async () => {
        vi.stubGlobal("DOOC_READ_ONLY", true);
        vi.resetModules();
        await import("./workspace-worker.js");
        vi.clearAllMocks();
        const directory = { kind: "directory", name: "viewer" };
        for (const options of [{ create: true }, { clone: true }, { files: new Map() }])
            expect(await reply("initialize", { directory, ...options })).toMatchObject({
                error: expect.stringContaining("read-only"),
            });
        expect(readDirectory).not.toHaveBeenCalled();
        await request("initialize", { directory });
        await request("http", { method: "GET", url: "/guide", headers: {}, body: "" });
        expect(applicationRequest).toHaveBeenLastCalledWith(
            expect.anything(),
            "preview",
            expect.objectContaining({ method: "GET" }),
        );
        for (const [op, args] of [
            ["http", { method: "POST", url: "/api/save" }],
            ["files", { action: "upload" }],
            ["git", { action: "commit" }],
            ["workspaces", { action: "branch", branch: "new", create: true }],
        ] as const)
            expect(await reply(op, args)).toMatchObject({
                error: expect.stringContaining("read-only"),
            });
        expect(persistFiles).not.toHaveBeenCalled();
    });
});
afterAll(() => vi.unstubAllGlobals());

it("omits MCP unless selected and validates read-only tools inside the Worker", async () => {
    expect(await reply("mcp", { name: "read_doc", args: { id: "guide" } })).toMatchObject({
        error: expect.stringContaining("Unknown workspace operation"),
    });
    vi.stubGlobal("DOOC_MCP", true);
    vi.stubGlobal("DOOC_READ_ONLY", true);
    vi.resetModules();
    await import("./workspace-worker.js");
    await request("initialize", { directory: { kind: "directory", name: "viewer-mcp" } });
    vi.clearAllMocks();
    expect(await request("mcp", { name: "read_doc", args: { id: "guide" } })).toEqual({
        raw: "Original",
    });
    for (const name of ["write_doc", "write_file", "export", "git"])
        expect(
            await reply("mcp", { name, args: { id: "guide", content: "Changed" } }),
        ).toMatchObject({ error: "Unknown tool" });
    expect(await reply("mcp", { name: "read_doc", args: { id: 42 } })).toMatchObject({
        error: "Invalid argument: id",
    });
    expect(createMcpOperations).toHaveBeenCalled();
    expect(persistFiles).not.toHaveBeenCalled();
});

it("rejects an expired MCP mutation before executing or persisting it", async () => {
    vi.stubGlobal("DOOC_MCP", true);
    vi.resetModules();
    await import("./workspace-worker.js");
    await request("initialize", { directory: { kind: "directory", name: "mcp-deadline" } });
    vi.clearAllMocks();
    expect(
        await reply("mcp", {
            name: "write_doc",
            args: { id: "guide", content: "Too late" },
            deadline: Date.now() - 1,
        }),
    ).toMatchObject({ error: "MCP request expired before execution" });
    expect(createMcpOperations).not.toHaveBeenCalled();
    expect(persistFiles).not.toHaveBeenCalled();
});

it("renders and lints drafts without rereading or copying storage, but resyncs before saves and navigation", async () => {
    for (const url of ["/api/render", "/api/render?lang=jpn", "/api/lint?lang=eng"])
        expect(await request("http", { url, method: "POST", body: "{}", headers: {} })).toEqual({
            status: 200,
            headers: {},
            body: "preview",
        });
    expect(applicationRequest).toHaveBeenCalledTimes(3);
    expect(readDirectory).not.toHaveBeenCalled();
    expect(memoryFiles).not.toHaveBeenCalled();
    expect(persistFiles).not.toHaveBeenCalled();

    await request("files", { action: "read" });
    expect(filesSnapshot).toHaveBeenCalledTimes(1);
    expect(readDirectory).toHaveBeenCalledTimes(1);
    await request("http", { url: "/api/page", method: "GET", body: "", headers: {} });
    expect(readDirectory).toHaveBeenCalledTimes(2);
    await request("http", { url: "/api/save", method: "POST", body: "{}", headers: {} });
    expect(readDirectory).toHaveBeenCalledTimes(3);
    expect(persistFiles).toHaveBeenCalledTimes(3);
});
