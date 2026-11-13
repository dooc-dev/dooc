import { afterEach, expect, it, vi } from "vitest";
import { createWorkspaceClient, webSocketPort } from "./client.js";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

it("rejects requests in the reconnect gap and sends only on the next live socket", async () => {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    class Socket extends EventTarget {
        static OPEN = 1;
        static CONNECTING = 0;
        readyState = 0;
        sent: { id: number; op: string }[] = [];
        constructor() {
            super();
            sockets.push(this);
        }
        send(text: string) {
            this.sent.push(JSON.parse(text));
        }
        open() {
            this.readyState = 1;
            this.dispatchEvent(new Event("open"));
        }
        close() {
            this.readyState = 3;
            this.dispatchEvent(new Event("close"));
        }
    }
    vi.stubGlobal("WebSocket", Socket);
    const client = createWorkspaceClient(webSocketPort("ws://test"));
    const first = sockets[0] as Socket;
    const queued = client.request("hello");
    first.open();
    expect(first.sent).toHaveLength(1);
    first.close();
    await expect(queued).rejects.toThrow("Workspace connection closed");
    await expect(client.request("files")).rejects.toThrow("Workspace connection closed");
    await vi.advanceTimersByTimeAsync(300);
    const next = sockets[1] as Socket;
    next.open();
    const fresh = client.request("hello");
    next.dispatchEvent(
        new MessageEvent("message", {
            data: JSON.stringify({ id: next.sent[0]?.id, value: "ok" }),
        }),
    );
    expect(await fresh).toBe("ok");
    expect(next.sent.map((message) => message.op)).toEqual(["hello"]);
});
