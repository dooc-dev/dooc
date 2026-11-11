import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { parseDoc } from "../compiler/dialect.js";
import { parseManifestText } from "../compiler/manifest.js";
import { textfilePath } from "../compiler/textfile.js";
import { MANIFEST_FILE } from "../core/content-metadata.js";
import type { SubformatCollection } from "../core/subformats.js";
import { parseGitChanges } from "./git.js";

export const gitFileChanges = (root: string): Map<string, "added" | "modified"> => {
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
    const git = (...args: string[]) =>
        execFileSync("git", ["-C", root, ...args], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 2_000,
            maxBuffer: 5_000_000,
        });
    try {
        textfilePath(root, file);
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

export const setSubformatChanges = (root: string, collections: SubformatCollection[]): void => {
    const changes = gitFileChanges(root);
    const raw = gitBaseText(root, MANIFEST_FILE);
    const base = raw === null ? undefined : parseManifestText(raw);
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
