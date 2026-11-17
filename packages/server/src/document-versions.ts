import { execFile } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import { exportEntries } from "../../engine/src/compiler/export.js";
import { manifestFile, projectRoot, readManifest } from "../../engine/src/compiler/manifest.js";
import {
    storedDocumentVersions,
    storedVersionRoot,
} from "../../engine/src/compiler/stored-versions.js";
import { textfilePath } from "../../engine/src/compiler/textfile.js";
import { versionInput } from "../../engine/src/compiler/version-input.js";
import {
    advanceVersion,
    type DocumentRevision,
    parseVersionConfig,
    parseVersionSelection,
    selectVersions,
    type VersionState,
} from "../../engine/src/core/document-version.js";
import { git } from "./git.js";
import { prepareDocumentSources } from "./remote-manifests.js";
import { gitHeadFile } from "./workspace.js";

/** Historical sources live in disposable folders; viewing never changes a checkout. */
export const createDocumentVersions = (root: string, name = manifestFile(root)) => {
    let temporary: string | undefined;
    let cachedHead = "";
    let pending: Promise<DocumentRevision[]> | undefined;
    const snapshots = new Map<string, Promise<string>>();
    const revisionVersions = new Map<string, string>();
    const folder = () => (temporary ??= mkdtempSync(join(tmpdir(), "dooc-versions-")));
    const archive = async (revision: string, destination: string): Promise<string> => {
        if (!/^[a-f\d]{40}(?:[a-f\d]{24})?$/.test(revision))
            throw new Error("Invalid document revision");
        const repository = (await git(root, ["rev-parse", "--show-toplevel"])).trim();
        const prefix = relative(repository, root).replaceAll("\\", "/");
        const { stdout } = await promisify(execFile)(
            "git",
            [
                "-C",
                repository,
                "archive",
                "--format=zip",
                `${revision}${prefix ? `:${prefix}` : ""}`,
            ],
            { encoding: "buffer", maxBuffer: 256 * 1024 * 1024, timeout: 30_000 },
        );
        mkdirSync(destination, { recursive: true });
        let total = 0;
        const files = unzipSync(stdout, {
            filter(file) {
                total += file.originalSize;
                if (total > 256 * 1024 * 1024)
                    throw new Error("Historical document exceeds 256 MiB");
                return !file.name.endsWith("/");
            },
        });
        for (const [name, data] of Object.entries(files)) {
            // Git already selected tracked files; snapshot folders must not reapply ignore rules.
            if (basename(name) === ".gitignore" || name.split("/").includes(".git")) continue;
            const path = textfilePath(destination, name);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, data);
        }
        const tree = await git(repository, [
            "ls-tree",
            "-r",
            "-z",
            `${revision}${prefix ? `:${prefix}` : ""}`,
        ]);
        for (const item of tree.split("\0")) {
            if (!item.startsWith("120000 ")) continue;
            const name = item.slice(item.indexOf("\t") + 1);
            if (!files[name] || basename(name) === ".gitignore" || name.split("/").includes(".git"))
                continue;
            const target = Buffer.from(files[name]).toString("utf8");
            const resolved = relative(destination, resolve(destination, dirname(name), target));
            if (
                isAbsolute(target) ||
                resolved === ".." ||
                resolved.startsWith("../") ||
                isAbsolute(resolved)
            )
                throw new Error("Historical symlink points outside the document root");
            const path = textfilePath(destination, name);
            unlinkSync(path);
            symlinkSync(target, path);
        }
        return projectRoot(join(destination, name));
    };
    const load = async (head: string): Promise<DocumentRevision[]> => {
        revisionVersions.clear();
        if ((await git(root, ["rev-parse", "--is-shallow-repository"])).trim() === "true")
            throw new Error("Fetch complete Git history to resolve document versions");
        const revisions = (
            await git(root, ["rev-list", "--first-parent", "--reverse", head, "--", "."])
        )
            .trim()
            .split("\n")
            .filter(Boolean);
        const rows = new Map<string, DocumentRevision>();
        let state: VersionState | undefined;
        for (const revision of revisions) {
            const scratch = join(folder(), `scan-${revision}`);
            const present = await git(root, ["cat-file", "-e", `${revision}:./${name}`]).then(
                () => true,
                () => false,
            );
            if (!present) {
                state = undefined;
                continue;
            }
            try {
                const snapshot = await archive(revision, scratch);
                await prepareDocumentSources(snapshot);
                const manifest = readManifest(snapshot);
                if (manifest.errors.length) throw new Error(manifest.errors.join("\n"));
                const config = manifest.version ?? parseVersionConfig({});
                if (config.minor === "hash" || config.patch === "hash") {
                    state = undefined;
                    continue;
                }
                state = advanceVersion(
                    versionInput(snapshot, config, exportEntries(snapshot, name), name),
                    state,
                );
                revisionVersions.set(revision, state.version);
                rows.set(state.version, { version: state.version, revision, current: false });
            } catch (error) {
                throw new Error(
                    `Cannot version ${revision.slice(0, 12)}: ${error instanceof Error ? error.message : error}`,
                );
            } finally {
                rmSync(scratch, { recursive: true, force: true });
            }
        }
        if (state)
            rows.set(state.version, { version: state.version, revision: head, current: true });
        return selectVersions([...rows.values()], parseVersionSelection("*"));
    };
    const list = async (): Promise<DocumentRevision[]> => {
        const manifest = readManifest(root, name);
        if (manifest.errors.length && !gitHeadFile(root))
            throw new Error(manifest.errors.join("\n"));
        if (manifest.version && [manifest.version.minor, manifest.version.patch].includes("hash"))
            return selectVersions(storedDocumentVersions(root, name), parseVersionSelection("*"));
        if (!gitHeadFile(root)) {
            if (
                manifest.version &&
                [manifest.version.minor, manifest.version.patch].includes("git")
            )
                throw new Error("Git versioning requires a Git workspace");
            if (
                manifest.version &&
                typeof manifest.version.minor === "number" &&
                typeof manifest.version.patch === "number"
            )
                return storedDocumentVersions(root, name).length
                    ? selectVersions(storedDocumentVersions(root, name), parseVersionSelection("*"))
                    : [
                          {
                              version: [
                                  manifest.version.major,
                                  manifest.version.minor,
                                  manifest.version.patch,
                              ].join("."),
                              revision: "current",
                              current: true,
                          },
                      ];
            return [];
        }
        const head = (await git(root, ["rev-parse", "--verify", "HEAD"]).catch(() => "")).trim();
        if (!head) return [];
        if (cachedHead !== head || !pending) {
            cachedHead = head;
            pending = load(head).catch((error) => {
                pending = undefined;
                throw error;
            });
        }
        return pending;
    };
    return {
        enabled: () => !!gitHeadFile(root) || !!readManifest(root, name).version,
        list,
        async versionAt(revision: string): Promise<string | undefined> {
            const rows = await list();
            const exact =
                revisionVersions.get(revision) ??
                rows.find((row) => row.revision === revision)?.version;
            if (exact || !/^[a-f\d]{40}(?:[a-f\d]{24})?$/.test(revision)) return exact;
            const changed = (
                await git(root, ["rev-list", "--first-parent", "-1", revision, "--", "."]).catch(
                    () => "",
                )
            ).trim();
            return revisionVersions.get(changed);
        },
        async open(revision: string): Promise<string> {
            if (!(await list()).some((row) => row.revision === revision))
                throw new Error("Document version is not available");
            if (revision === "current") {
                const destination = join(folder(), "current");
                mkdirSync(destination, { recursive: true });
                for (const entry of exportEntries(root, name)) {
                    const target = textfilePath(destination, entry.name);
                    mkdirSync(dirname(target), { recursive: true });
                    writeFileSync(target, entry.data);
                }
                return projectRoot(join(destination, name));
            }
            if (revision.startsWith("hash-")) return storedVersionRoot(root, revision, name);
            let snapshot = snapshots.get(revision);
            if (!snapshot) {
                snapshot = archive(revision, join(folder(), revision)).catch((error) => {
                    snapshots.delete(revision);
                    throw error;
                });
                snapshots.set(revision, snapshot);
            }
            return snapshot;
        },
        close() {
            if (temporary && existsSync(temporary))
                rmSync(temporary, { recursive: true, force: true });
        },
    };
};
