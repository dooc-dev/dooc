import git from "isomorphic-git";
import { exportEntries } from "../../engine/src/compiler/export.js";
import { manifestFile, projectRoot, readManifest } from "../../engine/src/compiler/manifest.js";
import {
    storedDocumentVersions,
    storedVersionRoot,
} from "../../engine/src/compiler/stored-versions.js";
import { versionInput } from "../../engine/src/compiler/version-input.js";
import {
    advanceVersion,
    type DocumentRevision,
    parseVersionConfig,
    parseVersionSelection,
    selectVersions,
    type VersionState,
} from "../../engine/src/core/document-version.js";
import { fs } from "./browser-host.js";
import { type FileSnapshot, replaceMemory } from "./browser-storage.js";

export const createBrowserVersions = (
    repository: string,
    root: string,
    name = manifestFile(root),
    prepare: (root: string) => Promise<void> = async () => {},
) => {
    const prefix = root === repository ? "" : `${root.slice(repository.length + 1)}/`;
    const temporary = `/versions-${crypto.randomUUID()}`;
    let cachedHead = "";
    let cached: DocumentRevision[] = [];
    const revisionVersions = new Map<string, string>();
    const snapshot = async (revision: string): Promise<string> => {
        const destination = `${temporary}/${revision}`;
        if (fs.existsSync(`${destination}/${name}`)) return projectRoot(`${destination}/${name}`);
        const files: FileSnapshot = new Map();
        let size = 0;
        const visit = async (oid: string, directory: string) => {
            const { tree } = await git.readTree({ fs, dir: repository, oid });
            for (const entry of tree) {
                const path = `${directory}${entry.path}`;
                if (entry.type === "tree") {
                    if (path.startsWith(prefix) || prefix.startsWith(`${path}/`))
                        await visit(entry.oid, `${path}/`);
                } else if (
                    entry.type === "blob" &&
                    path.startsWith(prefix) &&
                    entry.path !== ".gitignore"
                ) {
                    if (entry.mode === "120000")
                        throw new Error("Historical symbolic links require the Node server");
                    const { blob } = await git.readBlob({ fs, dir: repository, oid: entry.oid });
                    size += blob.length;
                    if (size > 128 * 1024 * 1024)
                        throw new Error("Historical document exceeds 128 MiB");
                    files.set(path.slice(prefix.length), blob);
                }
            }
        };
        await visit(revision, "");
        replaceMemory(destination, files);
        return projectRoot(`${destination}/${name}`);
    };
    const list = async (): Promise<DocumentRevision[]> => {
        if (!fs.existsSync(`${root}/${name}`)) return [];
        const manifest = readManifest(root, name);
        if (manifest.errors.length && !fs.existsSync(`${repository}/.git`))
            throw new Error(manifest.errors.join("\n"));
        const config = manifest.version;
        if (config && [config.minor, config.patch].includes("hash"))
            return selectVersions(storedDocumentVersions(root, name), parseVersionSelection("*"));
        if (!fs.existsSync(`${repository}/.git`)) {
            if (!config) return [];
            if ([config.minor, config.patch].includes("git"))
                throw new Error("Git versioning requires a Git workspace");
            const stored = storedDocumentVersions(root, name);
            return stored.length
                ? selectVersions(stored, parseVersionSelection("*"))
                : [
                      {
                          version: `${config.major}.${config.minor}.${config.patch}`,
                          revision: "current",
                          current: true,
                      },
                  ];
        }
        const head = await git.resolveRef({ fs, dir: repository, ref: "HEAD" }).catch(() => "");
        if (!head) return [];
        if (head === cachedHead) return cached;
        revisionVersions.clear();
        if (
            fs.existsSync(`${repository}/.git/shallow`) &&
            String(fs.readFileSync(`${repository}/.git/shallow`)).trim()
        )
            throw new Error("Fetch complete Git history to resolve document versions");
        const revisions: string[] = [];
        let revision: string | undefined = head;
        while (revision) {
            revisions.push(revision);
            revision = (await git.readCommit({ fs, dir: repository, oid: revision })).commit
                .parent[0];
        }
        const rows = new Map<string, DocumentRevision>();
        let state: VersionState | undefined;
        for (const revision of revisions.reverse()) {
            const destination = `${temporary}/${revision}`;
            try {
                const present = await git
                    .readBlob({
                        fs,
                        dir: repository,
                        oid: revision,
                        filepath: `${prefix}${name}`,
                    })
                    .then(
                        () => true,
                        () => false,
                    );
                if (!present) {
                    state = undefined;
                    continue;
                }
                const historical = await snapshot(revision);
                await prepare(historical);
                const definition = readManifest(historical);
                if (definition.errors.length) throw new Error(definition.errors.join("\n"));
                const config = definition.version ?? parseVersionConfig({});
                if ([config.minor, config.patch].includes("hash")) {
                    state = undefined;
                    continue;
                }
                state = advanceVersion(
                    versionInput(historical, config, exportEntries(historical, name), name),
                    state,
                );
                revisionVersions.set(revision, state.version);
                rows.set(state.version, { version: state.version, revision, current: false });
            } finally {
                fs.rmSync(destination, { recursive: true, force: true });
            }
        }
        if (state)
            rows.set(state.version, { version: state.version, revision: head, current: true });
        cached = selectVersions([...rows.values()], parseVersionSelection("*"));
        cachedHead = head;
        return cached;
    };
    return {
        enabled: () =>
            fs.existsSync(`${repository}/.git`) ||
            (fs.existsSync(`${root}/${name}`) && !!readManifest(root, name).version),
        list,
        async versionAt(revision: string): Promise<string | undefined> {
            const rows = await list();
            return (
                revisionVersions.get(revision) ??
                rows.find((row) => row.revision === revision)?.version
            );
        },
        async open(revision: string) {
            if (!(await list()).some((row) => row.revision === revision))
                throw new Error("Document version is not available");
            if (revision === "current") {
                const destination = `${temporary}/current`;
                replaceMemory(
                    destination,
                    new Map(exportEntries(root, name).map(({ name, data }) => [name, data])),
                );
                return projectRoot(`${destination}/${name}`);
            }
            return revision.startsWith("hash-")
                ? storedVersionRoot(root, revision, name)
                : snapshot(revision);
        },
        close: () => fs.rmSync(temporary, { recursive: true, force: true }),
    };
};
