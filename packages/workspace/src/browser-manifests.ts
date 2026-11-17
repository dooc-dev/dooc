import git from "isomorphic-git";
import { projectRoot } from "../../engine/src/compiler/manifest.js";
import { prepareRemoteManifests } from "../../engine/src/compiler/remote-manifests.js";
import { gitOptions } from "./browser-git.js";
import { fs } from "./browser-host.js";

// shortcut: refs stay pinned for this worker; add refresh when live remote updates are needed.
const sources = new Map<string, Promise<string>>();
export const prepareBrowserSources = (root: string, corsProxy?: string): Promise<void> =>
    prepareRemoteManifests(root, (source) => {
        const key = JSON.stringify(source);
        let task = sources.get(key);
        if (!task) {
            task = (async () => {
                const directory = `/remote-${crypto.randomUUID()}`;
                try {
                    await git.clone({
                        ...gitOptions(directory, { corsProxy }),
                        url: source.repository,
                        singleBranch: false,
                    });
                    await git.checkout({ fs, dir: directory, ref: source.ref, force: true });
                    return projectRoot(`${directory}/${source.path}`);
                } catch (error) {
                    fs.rmSync(directory, { recursive: true, force: true });
                    throw error;
                }
            })().catch((error) => {
                sources.delete(key);
                throw error;
            });
            sources.set(key, task);
        }
        return task;
    });
