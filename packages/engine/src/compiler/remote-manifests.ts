import { flattenTree, pageUrlKind } from "../core/content-metadata.js";
import {
    isRemoteManifest,
    type RemoteManifest,
    remoteManifestSource,
} from "../core/remote-manifest.js";
import { exportEntries } from "./export.js";
import {
    basename,
    createHash,
    dirname,
    existsSync,
    join,
    mkdirSync,
    readFileSync,
    realpathSync,
    relative,
    resolve,
    writeFileSync,
} from "./host.js";
import { manifestFile, parseManifestText } from "./manifest.js";
import { textfilePath } from "./textfile.js";

export const REMOTE_MANIFEST_DIR = "dooc-imports";
export const remoteManifestFile = (url: string): string => {
    const source = remoteManifestSource(url);
    const key = createHash("sha256").update(JSON.stringify(source)).digest("hex");
    return `${REMOTE_MANIFEST_DIR}/${key}/${basename(source.path)}`;
};
export const isRemoteSourceFile = (file: string): boolean =>
    file.split("/").includes(REMOTE_MANIFEST_DIR);

const sources = new Map<string, string>();
const pending = new Map<string, Promise<void>>();

/** A mirrored page's history belongs to its source repository, never to the parent's Git log. */
export const manifestSourcePath = (file: string): string => {
    file = resolve(file);
    for (let depth = 0; depth < 64; depth++) {
        const match = [...sources]
            .sort(([a], [b]) => b.length - a.length)
            .find(([folder]) => file === folder || file.startsWith(`${folder}/`));
        if (!match) return file;
        file = join(match[1], relative(match[0], file));
    }
    throw new Error("Circular remote manifest source");
};

export type LoadRemoteManifest = (source: RemoteManifest) => Promise<string>;

/** Materialize only referenced sources; the synchronous compiler then uses its ordinary file paths. */
export const prepareRemoteManifests = async (
    root: string,
    load: LoadRemoteManifest,
    active = new Set<string>(),
): Promise<void> => {
    const visit = async (file: string): Promise<void> => {
        if (!existsSync(join(root, file))) return;
        const path = textfilePath(root, file);
        if (active.has(path)) throw new Error(`Circular manifest include: ${file}`);
        if (active.size >= 64) throw new Error("Manifest nesting exceeds 64 levels");
        if (!existsSync(path)) return;
        active.add(path);
        try {
            const manifest = parseManifestText(readFileSync(path, "utf8"), file, false);
            if (manifest.errors.length) return;
            for (const node of flattenTree(manifest.tree)) {
                if (!node.url || pageUrlKind(node.url) !== "manifest") continue;
                if (!isRemoteManifest(node.url)) {
                    await visit(join(dirname(file), node.url));
                    continue;
                }
                const source = remoteManifestSource(node.url);
                const cacheFile = remoteManifestFile(node.url);
                const identity = JSON.stringify(source);
                if (active.has(identity)) throw new Error(`Circular manifest include: ${node.url}`);
                const destination = textfilePath(root, join(dirname(file), cacheFile));
                let task = pending.get(destination);
                if (task && !existsSync(destination)) {
                    await task;
                    if (!existsSync(destination)) {
                        pending.delete(destination);
                        task = undefined;
                    }
                }
                if (!task) {
                    task = (async () => {
                        active.add(identity);
                        try {
                            const sourceRoot = await load(source);
                            await prepareRemoteManifests(sourceRoot, load, active);
                            const entries = exportEntries(sourceRoot);
                            const folder = dirname(destination);
                            let size = 0;
                            for (const entry of entries) {
                                size += entry.data.length;
                                if (size > 256 * 1024 * 1024)
                                    throw new Error("Remote document exceeds 256 MiB");
                                const relativeTarget = join(
                                    dirname(file),
                                    dirname(cacheFile),
                                    entry.name,
                                );
                                const target = textfilePath(root, relativeTarget);
                                if (target !== resolve(realpathSync(root), relativeTarget))
                                    throw new Error(
                                        "Remote document cache cannot contain symbolic links",
                                    );
                                mkdirSync(dirname(target), { recursive: true });
                                writeFileSync(target, entry.data);
                            }
                            sources.set(folder, sourceRoot);
                        } finally {
                            active.delete(identity);
                        }
                    })().catch((error) => {
                        pending.delete(destination);
                        throw error;
                    });
                    pending.set(destination, task);
                }
                await task;
            }
        } finally {
            active.delete(path);
        }
    };
    await visit(manifestFile(root));
};
