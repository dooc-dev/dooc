import { afterEach, expect, it, vi } from "vitest";
import { loggedWorkspaceOps, logHttpOperation } from "./operation-log.js";
import { terminal } from "./terminal.js";

vi.mock("./terminal.js", () => ({ terminal: { operation: vi.fn(), warn: vi.fn() } }));
afterEach(() => vi.clearAllMocks());

it("logs write requests without URL query secrets or background rendering noise", () => {
    logHttpOperation("POST", "/api/save?token=secret", 409);
    logHttpOperation("POST", "/api/render", 200);
    logHttpOperation("POST", "/api/lint", 200);
    logHttpOperation("POST", "/api/code-tool", 200);
    logHttpOperation("GET", "/api/doc?file=private", 200);
    expect(terminal.operation).toHaveBeenCalledOnce();
    expect(terminal.operation).toHaveBeenCalledWith("POST /api/save", "HTTP 409");
});

it("logs resource saves and conflicts while suppressing resource previews and validation", async () => {
    const ops = loggedWorkspaceOps({ http: vi.fn().mockResolvedValue({ status: 409 }) });
    for (const action of ["read", "preview", "validate", "save"])
        await ops.http?.(
            {
                method: "POST",
                url: "/api/textfile",
                body: JSON.stringify({ action, content: "private" }),
            },
            {},
        );
    expect(terminal.operation).toHaveBeenCalledOnce();
    expect(terminal.operation).toHaveBeenCalledWith("POST /api/textfile", "HTTP 409");
});

it("preserves operation results and sessions without logging bodies or commit messages", async () => {
    const result = { ok: true };
    const git = vi.fn().mockResolvedValue(result);
    const session = { local: true };
    const input = { action: "commit", message: "private", token: "secret" };
    const ops = loggedWorkspaceOps({ git });
    expect(await ops.git?.(input, session)).toBe(result);
    expect(git).toHaveBeenCalledOnce();
    expect(git).toHaveBeenCalledWith(input, session);
    expect(terminal.operation).toHaveBeenCalledOnce();
    expect(terminal.operation).toHaveBeenCalledWith("git commit", undefined);
});

it("keeps read operations quiet and forwards failures unchanged", async () => {
    const failure = new Error("private server detail");
    const ops = loggedWorkspaceOps({
        files: vi.fn().mockResolvedValue({ files: [] }),
        git: vi.fn().mockRejectedValue(failure),
    });
    await ops.files?.({ action: "read" }, {});
    expect(terminal.operation).not.toHaveBeenCalled();
    await expect(ops.git?.({ action: "push", token: "secret" }, {})).rejects.toBe(failure);
    expect(terminal.warn).toHaveBeenCalledOnce();
    expect(terminal.warn).toHaveBeenCalledWith("git operation failed");
});

it("reports workspace HTTP status without labeling a rejected save as successful", async () => {
    const response = { status: 409, body: "private conflict content" };
    const ops = loggedWorkspaceOps({ http: vi.fn().mockResolvedValue(response) });
    expect(
        await ops.http?.({ method: "POST", url: "/api/save?token=secret", body: "private" }, {}),
    ).toBe(response);
    expect(terminal.operation).toHaveBeenCalledOnce();
    expect(terminal.operation).toHaveBeenCalledWith("POST /api/save", "HTTP 409");
});
