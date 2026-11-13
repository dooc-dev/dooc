import type { WorkspacePort } from "./protocol.js";

export const messagePort = (
    port: Pick<Worker, "postMessage" | "addEventListener">,
): WorkspacePort => ({
    send: (message) => port.postMessage(message),
    receive: (handler) => port.addEventListener("message", (event) => handler(event.data)),
});
