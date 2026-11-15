import {
    type WorkspaceConnection,
    workspaceConnection,
    workspaceConnections,
} from "../../workspace/src/connection.js";
import type { DesktopConnection, RelayCredentials } from "../../workspace/src/mcp-relay.js";
import { pairRelay, relayCommandText, startRelay } from "../../workspace/src/mcp-relay-client.js";

type Pairing = {
    credentials: RelayCredentials;
    status: string;
    connector?: ReturnType<typeof startRelay>;
};
const pairings = new Map<string, Pairing>();
let updateDialog = () => {};
let desktopUrl: string | undefined;

export const attachMcp = (
    url: string | undefined,
    readOnly: boolean,
    style: string,
    desktop?: DesktopConnection,
): void => {
    if (desktop) desktopUrl = desktop.url;
    const endpoint = desktopUrl ?? url;
    const local = endpoint === desktopUrl && !!desktopUrl;
    let pending = desktop;
    const key = (id: string) => JSON.stringify(["dooc.mcp", endpoint, id, readOnly]);
    const start = (connection: WorkspaceConnection, pairing: Pairing) => {
        if (pairing.connector || !endpoint) return;
        pairing.connector = startRelay({
            url: endpoint,
            credentials: pairing.credentials,
            execute: (name, args, deadline) =>
                connection.client.request("mcp", { name, args, deadline }),
            status: (message) => {
                pairing.status = message;
                updateDialog();
            },
        });
    };
    const restore = () => {
        if (!endpoint || pending) return;
        for (const connection of workspaceConnections()) {
            let pairing = pairings.get(key(connection.id));
            if (!pairing) {
                try {
                    const value = localStorage.getItem(key(connection.id));
                    if (!value) continue;
                    const credentials = JSON.parse(value) as RelayCredentials;
                    if (
                        typeof credentials.browser !== "string" ||
                        typeof credentials.mcp !== "string"
                    )
                        continue;
                    pairing = { credentials, status: "Connecting…" };
                    pairings.set(key(connection.id), pairing);
                } catch {
                    continue;
                }
            }
            start(connection, pairing);
        }
    };
    const show = () => {
        if (document.getElementById("mcp-dialog")) return;
        const dialog = document.createElement("dialog");
        dialog.id = "mcp-dialog";
        dialog.className = "workspace-dialog";
        dialog.innerHTML = `<style>${style}.workspace-dialog textarea{box-sizing:border-box;width:100%;min-height:110px;font:12px/1.5 monospace;resize:vertical}</style><h1>MCP connection</h1><p>Connect your assistant to this workspace. Keep this tab open while using MCP.</p><form><label>Workspace<select name="workspace"></select></label><p role="status" aria-live="polite"></p><label data-command hidden>Run once in your terminal<textarea readonly aria-label="Claude MCP registration command" spellcheck="false"></textarea></label><p data-command hidden>This command grants access to the selected workspace. Keep it private.</p><div class="workspace-actions"><button type="button" name="copy" hidden>Copy command</button><button type="button" name="disconnect" hidden>Disconnect</button><button type="button" name="connect">Enable MCP</button><button type="button" name="close">Close</button></div></form>`;
        const form = dialog.querySelector("form") as HTMLFormElement;
        const select = form.elements.namedItem("workspace") as HTMLSelectElement;
        const button = (name: string) => form.elements.namedItem(name) as HTMLButtonElement;
        const status = dialog.querySelector("[role=status]") as HTMLElement;
        const command = dialog.querySelector("textarea") as HTMLTextAreaElement;
        for (const connection of workspaceConnections())
            select.add(new Option(connection.label, connection.id));
        select.value = workspaceConnection()?.id ?? select.options[0]?.value ?? "";
        updateDialog = () => {
            const pairing = pairings.get(key(select.value));
            status.textContent = pending
                ? `Desktop requests ${pending.readOnly || readOnly ? "read-only" : "read and write"} access to the workspace you select. Connect only if you requested this link in your Desktop assistant.`
                : !endpoint
                  ? "Ask your Desktop assistant to connect to this dooc page, then open its private connection link."
                  : (pairing?.status ??
                    (readOnly
                        ? "Read-only access. Not connected."
                        : "Read and write access. Not connected."));
            command.value =
                pairing?.credentials.mcp && endpoint
                    ? relayCommandText(endpoint, pairing.credentials.mcp)
                    : "";
            for (const element of dialog.querySelectorAll<HTMLElement>("[data-command]"))
                element.hidden = !command.value;
            button("connect").hidden = !!pairing && !pending;
            button("connect").textContent = pending ? "Connect Desktop" : "Enable MCP";
            button("connect").disabled = !select.value || !endpoint || (local && !pending);
            button("disconnect").hidden = !pairing;
            button("copy").hidden = !command.value;
        };
        select.onchange = updateDialog;
        button("close").onclick = () => dialog.close();
        button("copy").onclick = () => {
            void navigator.clipboard.writeText(command.value).then(
                () => {
                    status.textContent = "Command copied";
                },
                () => {
                    command.focus();
                    command.select();
                    status.textContent = "Select and copy the command";
                },
            );
        };
        button("connect").onclick = () => {
            const connection = workspaceConnection(select.value);
            if (!connection || !endpoint || (local && !pending)) return;
            button("connect").disabled = true;
            select.disabled = true;
            status.textContent = "Connecting…";
            const grant = pending;
            const credentials = grant
                ? Promise.resolve({ browser: grant.browser, mcp: "" })
                : pairRelay(endpoint, readOnly);
            void credentials
                .then(async (credentials) => {
                    if (grant) {
                        for (const workspace of workspaceConnections()) {
                            const previous = pairings.get(key(workspace.id));
                            await previous?.connector?.stop();
                            pairings.delete(key(workspace.id));
                            localStorage.removeItem(key(workspace.id));
                        }
                        pending = undefined;
                        globalThis.__doocDesktopConnection = undefined;
                    }
                    if (credentials.mcp)
                        localStorage.setItem(key(connection.id), JSON.stringify(credentials));
                    const pairing: Pairing = { credentials, status: "Connecting…" };
                    pairings.set(key(connection.id), pairing);
                    start(connection, pairing);
                    updateDialog();
                })
                .catch((error: unknown) => {
                    status.textContent = error instanceof Error ? error.message : String(error);
                })
                .finally(() => {
                    button("connect").disabled = false;
                    select.disabled = false;
                });
        };
        button("disconnect").onclick = () => {
            const id = key(select.value);
            const pairing = pairings.get(id);
            localStorage.removeItem(id);
            pairings.delete(id);
            void pairing?.connector?.stop();
            updateDialog();
        };
        form.onsubmit = (event) => event.preventDefault();
        dialog.onclose = () => {
            updateDialog = () => {};
            dialog.remove();
        };
        updateDialog();
        document.body.append(dialog);
        dialog.showModal();
    };
    if (!document.getElementById("open-mcp")) {
        const button = document.createElement("button");
        button.id = "open-mcp";
        button.type = "button";
        button.className = "pbtn";
        button.textContent = "MCP";
        button.title = "MCP connection";
        button.setAttribute("aria-label", "MCP connection");
        button.onclick = show;
        (
            document.getElementById("editor-header-actions") ??
            document.getElementById("sidebar-head") ??
            document.querySelector("main") ??
            document.body
        ).append(button);
    }
    document.addEventListener("dooc:workspace-connected", restore);
    document.addEventListener("dooc:workspace-closed", (event) => {
        const pairing = pairings.get(key((event as CustomEvent<string>).detail));
        void pairing?.connector?.stop();
        if (pairing) pairing.connector = undefined;
    });
    window.addEventListener("pagehide", () => {
        for (const pairing of pairings.values()) {
            void pairing.connector?.stop();
            pairing.connector = undefined;
        }
    });
    window.addEventListener("pageshow", restore);
    restore();
    if (pending && workspaceConnections().length) show();
};
