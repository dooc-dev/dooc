import {
    advanceVersion,
    type DocumentRevision,
    parseDocumentVersion,
    parseVersionConfig,
    type VersionConfig,
    type VersionState,
} from "../core/document-version.js";
import { exportEntries } from "./export.js";
import {
    createHash,
    dirname,
    existsSync,
    mkdirSync,
    randomUUID,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "./host.js";
import { withIgnoredFilesCache } from "./ignored-files.js";
import { manifestFile, projectRoot } from "./manifest.js";
import { textfilePath } from "./textfile.js";
import { versionInput } from "./version-input.js";

interface StoredVersion extends VersionState {
    revision: string;
}
type VersionStore = { schemaVersion: 1; manifests: Record<string, StoredVersion[]> };
const statePath = (root: string) => textfilePath(root, ".dooc/versions.json");
const readStore = (root: string): VersionStore => {
    if (!existsSync(statePath(root))) return { schemaVersion: 1, manifests: {} };
    const store = JSON.parse(readFileSync(statePath(root), "utf8")) as VersionStore;
    if (
        store?.schemaVersion !== 1 ||
        !store.manifests ||
        typeof store.manifests !== "object" ||
        Array.isArray(store.manifests)
    )
        throw new Error("Invalid document version state");
    for (const rows of Object.values(store.manifests)) {
        if (!Array.isArray(rows)) throw new Error("Invalid document version history");
        for (const row of rows) {
            if (
                !row ||
                !/^hash-[a-f\d]{64}$/.test(row.revision) ||
                !/^[a-f\d]{64}$/.test(row.definition) ||
                !/^[a-f\d]{64}$/.test(row.content)
            )
                throw new Error("Invalid stored document version");
            parseDocumentVersion(row.version);
            parseVersionConfig(row.config);
        }
    }
    return store;
};

export const storedVersionRoot = (
    root: string,
    revision: string,
    name = manifestFile(root),
): string => {
    if (!/^hash-[a-f\d]{64}$/.test(revision)) throw new Error("Invalid stored document revision");
    return projectRoot(textfilePath(root, `.dooc/versions/${revision}/${name}`));
};

export const storedDocumentVersions = (
    root: string,
    name = manifestFile(root),
): DocumentRevision[] => {
    const rows = readStore(root).manifests[name] ?? [];
    return rows.map((row, index) => ({
        version: row.version,
        revision: row.revision,
        current: index === rows.length - 1,
    }));
};

/** Capture inputs before building; publish the counter and source snapshot only after success. */
export const prepareStoredVersion = (root: string, config: VersionConfig) => {
    const name = manifestFile(root);
    const before = readStore(root);
    const entries = withIgnoredFilesCache(() => exportEntries(root));
    const state = advanceVersion(
        versionInput(root, config, entries),
        before.manifests[name]?.at(-1),
    );
    const revision = `hash-${createHash("sha256").update(name).update(JSON.stringify(state)).digest("hex")}`;
    return {
        version: state.version,
        commit() {
            const destination = textfilePath(root, `.dooc/versions/${revision}`);
            const temporary = textfilePath(root, `.dooc/versions/${randomUUID()}`);
            const metadata = textfilePath(root, `.dooc/versions-${randomUUID()}.tmp`);
            const lock = textfilePath(root, ".dooc/versions.lock");
            mkdirSync(dirname(lock), { recursive: true });
            try {
                writeFileSync(lock, "", { flag: "wx" });
            } catch (error) {
                if ((error as { code?: string }).code === "EEXIST")
                    throw new Error(
                        "Document versions are locked. Retry after the other build finishes; remove .dooc/versions.lock only if no build is running.",
                    );
                throw error;
            }
            try {
                const current = readStore(root);
                if (
                    JSON.stringify(current.manifests[name]) !==
                    JSON.stringify(before.manifests[name])
                )
                    throw new Error("Document versions changed during the build; build again");
                if (!existsSync(destination)) {
                    mkdirSync(temporary, { recursive: true });
                    // shortcut: retain one complete source copy per version; deduplicate if media storage grows large.
                    for (const { name, data } of entries) {
                        const path = textfilePath(temporary, name);
                        mkdirSync(dirname(path), { recursive: true });
                        writeFileSync(path, data);
                    }
                    renameSync(temporary, destination);
                }
                current.manifests[name] = [
                    ...(current.manifests[name] ?? []).filter(
                        (row) => row.version !== state.version,
                    ),
                    { ...state, revision },
                ];
                writeFileSync(metadata, `${JSON.stringify(current, null, 2)}\n`, { flag: "wx" });
                renameSync(metadata, statePath(root));
            } finally {
                rmSync(temporary, { recursive: true, force: true });
                rmSync(metadata, { force: true });
                rmSync(lock, { force: true });
            }
        },
    };
};
