import { projectRoot } from "../../engine/src/compiler/manifest.js";
import { fetchPublicFile } from "../../engine/src/compiler/public-file.js";
import { prepareRemoteManifests } from "../../engine/src/compiler/remote-manifests.js";
import { prepareGitWorkspace } from "./git-workspace.js";

// shortcut: refs stay pinned for this process; add refresh when live remote updates are needed.
const workspaces = new Map<string, Promise<string>>();
const disposers = new Set<() => void>();
process.once("exit", () => {
    for (const dispose of disposers) dispose();
});

export const prepareDocumentSources = (root: string): Promise<void> =>
    prepareRemoteManifests(root, (source) => {
        const key = JSON.stringify(source);
        let task = workspaces.get(key);
        if (!task) {
            task = (async () => {
                let address: string | undefined;
                await fetchPublicFile(
                    `${source.repository}/info/refs?service=git-upload-pack`,
                    undefined,
                    undefined,
                    (host, ip) => {
                        address = `${host}:443:${ip.includes(":") ? `[${ip}]` : ip}`;
                    },
                );
                const workspace = await prepareGitWorkspace(source.repository, "view", {
                    path: source.path,
                    ref: source.ref,
                    public: true,
                    address,
                });
                disposers.add(workspace.dispose);
                return projectRoot(workspace.manifest);
            })().catch((error) => {
                workspaces.delete(key);
                throw error;
            });
            workspaces.set(key, task);
        }
        return task;
    });
