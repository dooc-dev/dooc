import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { filesSnapshot } from "../../engine/src/compiler/files.js";
import { memoryFiles, persistFiles, readDirectory } from "../../workspace/src/browser-storage.js";
import { applicationRequest } from "./application-request.js";

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

let receive: (event: { data: unknown }) => void;
const send = vi.fn();
let id = 0;
const request = async (op: string, args: Record<string, unknown>) => {
    const current = ++id;
    receive({ data: { id: current, op, args } });
    await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: current })),
    );
    const response = send.mock.calls.find(([message]) => message.id === current)?.[0];
    expect(response).not.toHaveProperty("error");
    return response.value;
};

beforeAll(async () => {
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
afterAll(() => vi.unstubAllGlobals());

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
