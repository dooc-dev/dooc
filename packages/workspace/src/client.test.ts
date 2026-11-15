import { afterEach, expect, it, vi } from "vitest";
import { createWorkspaceClient, webSocketPort } from "./client.js";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

it("keeps reconnect listeners and sends requests only on a live socket", async () => {
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
    const reload = vi.fn();
    const identify = vi.fn();
    client.opened(reload);
    client.opened(identify);
    const first = sockets[0] as Socket;
    const queued = client.request("hello");
    first.open();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(identify).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    client.opened(late);
    expect(late).toHaveBeenCalledTimes(1);
    expect(first.sent).toHaveLength(1);
    first.close();
    await expect(queued).rejects.toThrow("Workspace connection closed");
    await expect(client.request("files")).rejects.toThrow("Workspace connection closed");
    await vi.advanceTimersByTimeAsync(300);
    const next = sockets[1] as Socket;
    next.open();
    expect(reload).toHaveBeenCalledTimes(2);
    expect(identify).toHaveBeenCalledTimes(2);
    expect(late).toHaveBeenCalledTimes(2);
    const fresh = client.request("hello");
    next.dispatchEvent(
        new MessageEvent("message", {
            data: JSON.stringify({ id: next.sent[0]?.id, value: "ok" }),
        }),
    );
    expect(await fresh).toBe("ok");
    expect(next.sent.map((message) => message.op)).toEqual(["hello"]);
});
