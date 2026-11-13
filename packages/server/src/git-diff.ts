import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { parseDoc } from "../../engine/src/compiler/dialect.js";
import { manifestFile, parseManifestText } from "../../engine/src/compiler/manifest.js";
import { textfilePath } from "../../engine/src/compiler/textfile.js";
import type { SubformatCollection } from "../../engine/src/core/subformats.js";
import { parseGitChanges } from "./git.js";
import { gitSignature } from "./workspace.js";

// Git answers are reused until the metadata they were read from changes (see gitSignature).
const memo = new Map<string, { signature: string; values: Map<string, unknown> }>();
const remember = <T>(
    scope: string,
    signature: string | undefined,
    key: string,
    read: () => T,
): T => {
    if (signature === undefined) return read();
    let entry = memo.get(scope);
    // Base texts of visited files accumulate under one HEAD; start over past a generous bound.
    if (entry?.signature !== signature || entry.values.size > 500) {
        entry = { signature, values: new Map() };
        memo.set(scope, entry);
    }
    if (entry.values.has(key)) return entry.values.get(key) as T;
    const value = read();
    // Failures (null) stay uncached so a transient Git error does not stick.
    if (value !== null) entry.values.set(key, value);
    return value;
};

/**
 * `revision` identifies the working tree contents (filesSnapshot); with it the status is reused
 * until the files, the index or HEAD change.
 */
export const gitFileChanges = (
    root: string,
    revision?: string,
): Map<string, "added" | "modified"> => {
    const signature = revision === undefined ? undefined : gitSignature(root, true);
    return remember(
        `status|${root}`,
        signature === undefined ? undefined : `${signature}|${revision}`,
        "",
        () => readGitFileChanges(root),
    );
};

const readGitFileChanges = (root: string): Map<string, "added" | "modified"> => {
    const changes = new Map<string, "added" | "modified">();
    const git = (...args: string[]) =>
        execFileSync("git", ["--no-optional-locks", "-C", root, ...args], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 2_000,
            maxBuffer: 5_000_000,
        });
    try {
        const prefix = git("rev-parse", "--show-prefix").trim();
        const status = git(
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--no-renames",
            "--",
            ".",
        );
        for (const change of parseGitChanges(status)) {
            if (!change.path.startsWith(prefix)) continue;
            changes.set(
                change.path.slice(prefix.length),
                /[?A]/.test(change.index + change.worktree) ? "added" : "modified",
            );
        }
    } catch {
        // Git metadata is optional; unavailable repositories keep neutral cards.
    }
    return changes;
};

/** Compare against HEAD so saving or staging does not clear the editor's changes. */
export const gitBaseText = (root: string, file: string): string | null => {
    try {
        textfilePath(root, file);
    } catch {
        return null;
    }
    return remember(`head|${root}`, gitSignature(root), file, () => readGitBaseText(root, file));
};

const readGitBaseText = (root: string, file: string): string | null => {
    const git = (...args: string[]) =>
        execFileSync("git", ["-C", root, ...args], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 2_000,
            maxBuffer: 5_000_000,
        });
    try {
        let head: string;
        try {
            head = git("rev-parse", "--verify", "--quiet", "HEAD").trim();
        } catch (error) {
            return (error as { status?: number }).status === 1 ? "" : null;
        }
        if (!git("ls-tree", "-z", head, "--", `:(literal)${file}`)) return "";
        return git("show", `${head}:./${file}`);
    } catch {
        // Missing Git or unreadable history must leave the editor usable.
        return null;
    }
};

export const gitBaseBody = (root: string, file: string): string | null => {
    const raw = gitBaseText(root, file);
    return raw === null ? null : parseDoc(raw).body;
};

export const setSubformatChanges = (
    root: string,
    collections: SubformatCollection[],
    revision?: string,
): void => {
    const changes = gitFileChanges(root, revision);
    const raw = gitBaseText(root, manifestFile(root));
    const base = raw === null ? undefined : parseManifestText(raw, manifestFile(root));
    for (const collection of collections) {
        const previous = base?.subformats?.find((item) => item.ext === collection.ext);
        collection.baseLayouts =
            base && !base.errors.length ? (previous?.layouts ?? {}) : undefined;
        collection.change =
            base && !base.errors.length && !previous
                ? "added"
                : previous &&
                    (previous.format !== collection.format ||
                        previous.schema !== collection.schema ||
                        !isDeepStrictEqual(previous.layouts ?? {}, collection.layouts ?? {}))
                  ? "modified"
                  : changes.get(collection.schema);
        for (const record of collection.records) record.change = changes.get(record.file);
    }
};
