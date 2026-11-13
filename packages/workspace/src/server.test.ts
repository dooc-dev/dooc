import { expect, it, vi } from "vitest";
import { createWorkspaceClient } from "./client.js";
import { portPair, WORKSPACE_PROTOCOL } from "./protocol.js";
import { createWorkspaceServer } from "./server.js";

it("answers requests per connection, reports failures and pushes events until detached", async () => {
    const server = createWorkspaceServer<{ user: string }>({
        echo: (args, session) => ({ ...args, by: session.user }),
        fail: async () => {
            throw new Error("No such file");
        },
    });
    const [near, far] = portPair();
    const detach = server.connect(far, { user: "ada" });
    const client = createWorkspaceClient(near);

    expect(await client.request("hello")).toEqual({
        protocol: WORKSPACE_PROTOCOL,
        ops: ["echo", "fail"],
    });
    // Answers are matched by id, not by arrival order.
    expect(
        await Promise.all([client.request("echo", { n: 1 }), client.request("echo", { n: 2 })]),
    ).toEqual([
        { n: 1, by: "ada" },
        { n: 2, by: "ada" },
    ]);
    await expect(client.request("fail")).rejects.toThrow("No such file");
    // Inherited names such as "constructor" are not operations.
    await expect(client.request("constructor")).rejects.toThrow("Unknown workspace operation");

    const changed = vi.fn();
    const stop = client.on("changed", changed);
    server.broadcast("changed", ["a.md"]);
    await Promise.resolve();
    expect(changed).toHaveBeenCalledWith(["a.md"]);
    stop();
    detach();
    server.broadcast("changed", ["b.md"]);
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(1);
});

it("rejects requests in flight when the channel drops", async () => {
    let drop = () => {};
    const client = createWorkspaceClient({
        send() {},
        receive() {},
        closed(handler) {
            drop = handler;
        },
    });
    const request = client.request("echo");
    drop();
    await expect(request).rejects.toThrow("Workspace connection closed");
});
