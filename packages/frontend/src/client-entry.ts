import { workspaceHttp } from "../../workspace/src/application-transport.js";
import type { BrowserGitOptions } from "../../workspace/src/browser-git.js";
import { messagePort } from "../../workspace/src/browser-port.js";
import { createWorkspaceClient, type WorkspaceClient } from "../../workspace/src/client.js";
import {
    openBranchWorkspace,
    registerWorkspace,
    selectWorkspace,
    type WorkspaceConnection,
    workspaceConnections,
} from "../../workspace/src/connection.js";
import { connectServer } from "../../workspace/src/socket-connection.js";

type SavedWorkspace = {
    id: string;
    name: string;
    manifest: string;
    branch?: string;
    family: string;
};
const savedKey = "dooc.browser.workspaces";
const saved = (): SavedWorkspace[] => {
    try {
        return JSON.parse(localStorage.getItem(savedKey) || "[]");
    } catch {
        return [];
    }
};
const remember = (item: SavedWorkspace) =>
    localStorage.setItem(
        savedKey,
        JSON.stringify([...saved().filter((row) => row.id !== item.id), item]),
    );
const storageDirectory = async (id: string) =>
    (
        await (await navigator.storage.getDirectory()).getDirectoryHandle("dooc", { create: true })
    ).getDirectoryHandle(id, { create: true });
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

let rendered = !!document.getElementById("boot");
let configuredServer = "";

async function openBrowser(
    item: SavedWorkspace,
    directory: FileSystemDirectoryHandle,
    git: BrowserGitOptions,
    initial: Record<string, unknown> = {},
): Promise<WorkspaceConnection> {
    const existing = workspaceConnections().find((connection) => connection.id === item.id);
    if (existing) return existing;
    const worker = new Worker("/assets/workspace-worker.js");
    const port = messagePort(worker);
    let disconnected = () => {};
    port.closed = (handler) => {
        disconnected = handler;
    };
    worker.addEventListener("error", () => disconnected());
    const raw = createWorkspaceClient(port);
    let pending: Promise<unknown> = Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    raw.on("phase", (phase) => {
        if (phase === "storage") clearTimeout(timer);
    });
    const client: WorkspaceClient = {
        request: <T>(op: string, args?: Record<string, unknown>) => {
            const run = async (): Promise<T> => {
                timer = setTimeout(
                    () => {
                        worker.terminate();
                        disconnected();
                    },
                    op === "initialize" || op === "git" ? 180_000 : 60_000,
                );
                try {
                    return await raw.request<T>(op, args);
                } finally {
                    clearTimeout(timer);
                }
            };
            const next = pending.then(run, run);
            pending = next.catch(() => {});
            return next;
        },
        on: raw.on,
        opened: raw.opened,
    };
    try {
        const result = await client.request<{ source: { protocol: string; branch?: string } }>(
            "initialize",
            { directory, manifest: item.manifest, label: item.name, git, ...initial },
        );
        item.branch = result.source.branch;
        const connection: WorkspaceConnection = {
            id: item.id,
            label: item.branch ? `${item.branch}/${item.name}` : item.name,
            family: item.family,
            branch: item.branch,
            get branches() {
                return saved().flatMap((row) =>
                    row.family === item.family && row.branch ? [row.branch] : [],
                );
            },
            client,
            fetch: workspaceHttp(client),
            close: () => {
                worker.terminate();
                disconnected();
            },
            openBranch:
                result.source.protocol === "git"
                    ? (branch, create = false) =>
                          openBranchWorkspace(item.family, branch, create, async () => {
                              const previous = saved().find(
                                  (row) => row.family === item.family && row.branch === branch,
                              );
                              if (previous && create)
                                  throw new Error("Branch already has a workspace");
                              if (previous)
                                  return openBrowser(
                                      previous,
                                      await storageDirectory(previous.id),
                                      git,
                                  );
                              const data = await client.request<{
                                  files: Map<string, Uint8Array>;
                                  manifest: string;
                              }>("workspaces", { action: "branch" });
                              const next: SavedWorkspace = {
                                  id: crypto.randomUUID(),
                                  name: item.name,
                                  manifest: data.manifest,
                                  branch,
                                  family: item.family,
                              };
                              const result = await openBrowser(
                                  next,
                                  await storageDirectory(next.id),
                                  git,
                                  { ...data, branch, create },
                              );
                              remember(next);
                              return result;
                          })
                    : undefined,
        };
        registerWorkspace(connection);
        return connection;
    } catch (error) {
        worker.terminate();
        disconnected();
        throw error;
    }
}

const chooserStyle = `.workspace-dialog{color:var(--c-fg,#272727);background:var(--c-bg1,#fafaf8);border:1px solid var(--c-line,#d5d5d0);border-radius:8px;width:min(600px,calc(100vw - 32px));padding:24px;font:14px/1.5 system-ui;max-height:85vh;overflow:auto}.workspace-dialog::backdrop{background:#0005}.workspace-dialog h1{font-size:20px;margin:0 0 8px}.workspace-dialog p{margin:0 0 18px}.workspace-dialog form{display:grid;gap:14px}.workspace-dialog label{display:grid;gap:5px}.workspace-dialog input,.workspace-dialog select,.workspace-dialog button{font:inherit;color:inherit;background:var(--c-bg1,#fff);border:1px solid var(--c-line,#bcbcb6);border-radius:4px;padding:8px;min-width:0}.workspace-dialog details>div{display:grid;gap:12px;padding:14px 0}.workspace-dialog summary{cursor:pointer}.workspace-dialog .workspace-actions{display:flex;gap:8px;justify-content:flex-end}.workspace-dialog button[type=submit]{background:var(--c-fg,#222);color:var(--c-bg1,#fff)}.workspace-dialog [role=status]{white-space:pre-wrap;margin:0}.workspace-dialog [role=status][data-error]{color:var(--c-danger,#b42318)}.workspace-dialog [hidden]{display:none!important}`;

async function chooseWorkspace(pane?: string): Promise<void> {
    if (document.querySelector(".workspace-dialog")) return;
    const dialog = document.createElement("dialog");
    dialog.className = "workspace-dialog";
    dialog.innerHTML = `<style>${chooserStyle}</style><h1>Open a workspace</h1><p>Choose where your documents live. Each preview pane keeps its own workspace and branch.</p><form><label>Workspace<select name="mode"><option value="folder">Local folder</option><option value="new">New browser workspace</option><option value="saved">Saved browser workspace</option><option value="clone">Clone Git repository</option><option value="server">Connect to dooc server</option></select></label><label data-modes="new clone">Name<input name="name" value="My documents" maxlength="80"></label><label data-modes="saved">Saved workspace<select name="saved"></select></label><label data-modes="folder clone saved">Manifest path<input name="manifest" value="dooc.yaml" placeholder="docs/dooc.yaml"></label><p data-modes="folder">Choose the repository folder, including .git when using Git. Files are saved directly to this folder.</p><p data-modes="new clone saved">Files are kept in this browser's storage. Clearing site data removes them; push Git changes or download files you need to keep.</p><label data-modes="new clone">Git HTTPS URL (optional for a new workspace)<input name="url" type="url" placeholder="https://github.com/owner/repository.git"></label><label data-modes="server">Server socket<input name="server" placeholder="ws://localhost:5179/api/workspace" required></label><details data-modes="folder new clone saved"><summary>Git identity and authentication</summary><div><label>Author name<input name="author" autocomplete="name"></label><label>Author email<input name="email" type="email" autocomplete="email"></label><label>Username<input name="username" autocomplete="off"></label><label>Access token<input name="token" type="password" autocomplete="off"></label><p>The token stays in memory until this page closes.</p><label>Git CORS proxy URL (optional)<input name="proxy" type="url" placeholder="https://your-git-proxy.example"></label><p>Git remotes must allow browser requests. A proxy you choose can receive repository data and Git credentials.</p></div></details><p role="status" aria-live="polite"></p><div class="workspace-actions"><button type="button" name="cancel">Cancel</button><button type="submit">Open workspace</button></div></form>`;
    const form = dialog.querySelector("form") as HTMLFormElement;
    const input = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
    const mode = input("mode");
    const status = dialog.querySelector("[role=status]") as HTMLElement;
    const savedSelect = input("saved") as unknown as HTMLSelectElement;
    for (const row of saved())
        savedSelect.add(new Option(`${row.name}${row.branch ? ` / ${row.branch}` : ""}`, row.id));
    input("server").value =
        configuredServer ||
        localStorage.getItem("dooc.client.server") ||
        "ws://localhost:5179/api/workspace";
    input("author").value = localStorage.getItem("dooc.git.author") || "";
    input("email").value = localStorage.getItem("dooc.git.email") || "";
    const update = () => {
        for (const element of dialog.querySelectorAll<HTMLElement>("[data-modes]")) {
            element.hidden = !element.dataset.modes?.split(" ").includes(mode.value);
            for (const field of element.querySelectorAll<HTMLInputElement>("input,select"))
                field.disabled = element.hidden;
        }
    };
    mode.onchange = update;
    mode.value = configuredServer
        ? "server"
        : saved().length
          ? "saved"
          : typeof (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker ===
              "function"
            ? "folder"
            : "new";
    update();
    input("cancel").onclick = () => dialog.close();
    dialog.onclose = () => dialog.remove();
    form.onsubmit = (event) => {
        event.preventDefault();
        const action = mode.value;
        const picker = (
            window as Window & {
                showDirectoryPicker?: (options: {
                    mode: string;
                }) => Promise<FileSystemDirectoryHandle>;
            }
        ).showDirectoryPicker;
        // Invoke the picker before any await so the browser still sees the user's click.
        const picked =
            action === "folder" ? picker?.call(window, { mode: "readwrite" }) : undefined;
        void picked?.catch(() => {});
        status.textContent = "Opening workspace…";
        delete status.dataset.error;
        const button = form.querySelector("button[type=submit]") as HTMLButtonElement;
        button.disabled = true;
        void (async () => {
            let connection: WorkspaceConnection;
            if (action === "server") connection = await connectServer(input("server").value);
            else {
                const url = input("url").value.trim();
                const corsProxy = input("proxy").value.trim();
                for (const value of [
                    ["clone", "new"].includes(action) ? url : "",
                    corsProxy,
                ].filter(Boolean)) {
                    const parsed = new URL(value);
                    if (parsed.protocol !== "https:" || parsed.username || parsed.password)
                        throw new Error(
                            "Git and proxy addresses must use HTTPS without credentials in the URL",
                        );
                }
                const author = input("author").value.trim(),
                    email = input("email").value.trim();
                if ((author && !email) || (!author && email))
                    throw new Error("Enter both Git author name and email");
                const git: BrowserGitOptions = {
                    ...(["clone", "new"].includes(action) && url ? { url } : {}),
                    ...(corsProxy ? { corsProxy } : {}),
                    ...(author ? { author: { name: author, email } } : {}),
                    username: input("username").value,
                    token: input("token").value,
                };
                localStorage.setItem("dooc.git.author", author);
                localStorage.setItem("dooc.git.email", email);
                const id = crypto.randomUUID();
                const previous =
                    action === "saved"
                        ? saved().find((row) => row.id === savedSelect.value)
                        : undefined;
                if (action === "saved" && !previous) throw new Error("Choose a saved workspace");
                const item: SavedWorkspace = previous ?? {
                    id,
                    name: input("name").value.trim() || "Documents",
                    manifest: input("manifest").value || "dooc.yaml",
                    family: id,
                };
                let directory: FileSystemDirectoryHandle;
                if (action === "folder") {
                    if (!picked)
                        throw new Error(
                            "This browser does not support local folder access. Use browser storage or connect to the Node server.",
                        );
                    directory = await picked;
                    item.name = directory.name;
                } else directory = await storageDirectory(item.id);
                connection = await openBrowser(item, directory, git, {
                    create: action === "new",
                    clone: action === "clone",
                });
                if (action !== "folder") {
                    remember(item);
                    localStorage.setItem("dooc.client.active", item.id);
                }
            }
            if (rendered) dialog.close();
            if (rendered)
                document.dispatchEvent(
                    new CustomEvent("dooc:select-workspace", {
                        detail: { id: connection.id, pane },
                    }),
                );
            else await render(connection);
        })()
            .catch((error) => {
                status.textContent = errorText(error);
                status.dataset.error = "true";
            })
            .finally(() => {
                button.disabled = false;
            });
    };
    document.body.append(dialog);
    dialog.showModal();
}

function attach(): void {
    document.addEventListener(
        "dooc:open-workspace",
        (event) => void chooseWorkspace((event as CustomEvent<{ pane?: string }>).detail?.pane),
    );
    document
        .getElementById("open-workspace")
        ?.addEventListener("click", () => void chooseWorkspace());
}
async function render(connection: WorkspaceConnection): Promise<void> {
    selectWorkspace(connection.id);
    let response = await connection.fetch(location.pathname + location.search);
    if (!response.ok) response = await connection.fetch("/");
    if (!response.ok) throw new Error(await response.text());
    const html = await response.text();
    rendered = true;
    // The registry and Worker instances live on window and survive replacing the initial shell.
    document.open();
    document.write(html);
    document.close();
}

attach();
if (!rendered)
    void fetch("/dooc-client.json")
        .then((response) => (response.ok ? response.json() : Promise.resolve({})))
        .then((config: { server?: unknown }) => {
            configuredServer = typeof config.server === "string" ? config.server : "";
            return chooseWorkspace();
        })
        .catch(() => chooseWorkspace());
