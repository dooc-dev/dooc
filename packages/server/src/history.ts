// Node history drivers: Git commits in a Git workspace, folder copies ("single storage") elsewhere.
import { randomBytes } from "node:crypto";
import {
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { projectFiles } from "../../engine/src/compiler/files.js";
import { translationFiles } from "../../engine/src/compiler/locales.js";
import { manifestFile } from "../../engine/src/compiler/manifest.js";
import { textfilePath } from "../../engine/src/compiler/textfile.js";
import type { History, Person, Snapshot } from "../../workspace/src/history.js";
import { git } from "./git.js";
import { readWorkspaceSource } from "./workspace.js";

const LOG_FORMAT =
    "--format=%H%x00%aI%x00%an%x00%s%x00%(trailers:key=Co-authored-by,valueonly,separator=%x1f)%x1e";
const parseLog = (log: string): Snapshot[] =>
    log
        .split("\x1e")
        .map((record) => record.trim().split("\0"))
        .filter((fields) => fields.length === 5)
        .map(([id = "", time = "", author = "", message = "", trailers = ""]) => {
            // A trailer value is "Name <email>"; history shows names only.
            const coAuthors = trailers
                .split("\x1f")
                .map((value) => value.replace(/<[^>]*>\s*$/, "").trim())
                .filter(Boolean);
            return { id, time, author, message, ...(coAuthors.length ? { coAuthors } : {}) };
        });

const signature = ({ name, email = "" }: Person): string => `${name} <${email}>`;

/**
 * A snapshot is a commit of everything under the workspace folder. With `branch`, snapshots are
 * only taken on that branch (a shared workspace records straight onto its main line).
 */
export const gitHistory = (root: string, branch?: string): History => {
    const changed = async () => (await git(root, ["status", "--porcelain", "--", "."])) !== "";
    const assertBranch = async (): Promise<void> => {
        const current = (
            await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")
        ).trim();
        if (branch !== undefined && current !== branch)
            throw new Error(
                `Snapshots are recorded on ${branch}, but the workspace is on ${current || "a detached commit"}`,
            );
    };
    const commit = async (
        message: string,
        by: { author?: Person; coAuthors?: Person[] } = {},
    ): Promise<Snapshot> => {
        await assertBranch();
        const trailers = (by.coAuthors ?? []).map((p) => `Co-authored-by: ${signature(p)}`);
        await git(
            root,
            [
                "commit",
                "--file=-",
                ...(by.author ? [`--author=${signature(by.author)}`] : []),
                "--",
                ".",
            ],
            trailers.length ? `${message}\n\n${trailers.join("\n")}\n` : message,
        );
        const [snapshot] = parseLog(await git(root, ["log", "-1", LOG_FORMAT]));
        if (!snapshot) throw new Error("Snapshot was not recorded");
        return snapshot;
    };
    return {
        list: async () =>
            // An empty repository has no HEAD to list.
            parseLog(await git(root, ["log", "-n", "200", LOG_FORMAT, "--", "."]).catch(() => "")),
        async snapshot(message, by) {
            await assertBranch();
            await git(root, ["add", "--all", "--", "."]);
            if (!(await changed())) throw new Error("Nothing has changed since the last snapshot");
            return commit(message, by);
        },
        async restore(id) {
            if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(id)) throw new Error("Unknown snapshot");
            await git(root, ["cat-file", "-e", `${id}^{commit}`]);
            if (await changed()) throw new Error("Snapshot the current changes before restoring");
            await assertBranch();
            // Files added after the snapshot are tracked, so restoring removes them as well.
            await git(root, ["restore", `--source=${id}`, "--staged", "--worktree", "--", "."]);
            if (await changed()) await commit(`Restore snapshot ${id.slice(0, 7)}`);
        },
    };
};

const SNAPSHOTS = ".dooc/snapshots";

/**
 * A snapshot is a copy of every managed file under `.dooc/snapshots/<id>/files`.
 * shortcut: full copy per snapshot, switch to content-addressed blobs when large media makes
 * the folder grow too fast.
 */
export const folderHistory = (root: string): History => {
    const managed = (): string[] => [
        ...new Set([
            manifestFile(root),
            ...projectFiles(root).map((file) => file.path),
            ...translationFiles(root),
        ]),
    ];
    const read = (id: string): Snapshot | undefined => {
        try {
            const { time, message, author, coAuthors } = JSON.parse(
                readFileSync(join(root, SNAPSHOTS, id, "snapshot.json"), "utf8"),
            );
            return typeof time === "string" && typeof message === "string"
                ? {
                      id,
                      time,
                      message,
                      ...(typeof author === "string" ? { author } : {}),
                      ...(Array.isArray(coAuthors) && coAuthors.length
                          ? { coAuthors: coAuthors.map(String) }
                          : {}),
                  }
                : undefined;
        } catch {
            // A half-written or foreign folder is not a snapshot.
            return undefined;
        }
    };
    const list = (): Snapshot[] =>
        existsSync(join(root, SNAPSHOTS))
            ? readdirSync(join(root, SNAPSHOTS))
                  .sort()
                  .reverse()
                  .flatMap((id) => read(id) ?? [])
            : [];
    const snapshot = (
        message: string,
        by: { author?: Person; coAuthors?: Person[] } = {},
    ): Snapshot => {
        const time = new Date().toISOString();
        // Sorts by time; the suffix separates snapshots taken within one millisecond.
        const id = `${time.replace(/[-:.]/g, "")}-${randomBytes(3).toString("hex")}`;
        const directory = join(root, SNAPSHOTS, id);
        for (const file of managed()) {
            const source = textfilePath(root, file);
            if (!existsSync(source)) continue;
            mkdirSync(dirname(join(directory, "files", file)), { recursive: true });
            cpSync(source, join(directory, "files", file));
        }
        mkdirSync(directory, { recursive: true });
        // Written last: a snapshot without it is ignored, so an interrupted copy never lists.
        const author = by.author?.name;
        writeFileSync(
            join(directory, "snapshot.json"),
            JSON.stringify({ time, message, author, coAuthors: by.coAuthors?.map((p) => p.name) }),
        );
        return { id, time, message, ...(author ? { author } : {}) };
    };
    const prepareRestore = (files: string) => {
        const current = new Set(managed());
        const kept = new Set(
            readdirSync(files, { recursive: true, withFileTypes: true })
                .filter((entry) => entry.isFile())
                .map((entry) =>
                    relative(files, join(entry.parentPath, entry.name)).replaceAll("\\", "/"),
                ),
        );
        const directories = new Set<string>();
        for (const file of kept) {
            const parts = file.split("/");
            for (let i = 1; i <= parts.length; i++) {
                const path = parts.slice(0, i).join("/");
                const entry = lstatSync(join(root, path), { throwIfNoEntry: false });
                if (!entry) break;
                if (!entry.isDirectory()) {
                    if (!entry.isFile() || !current.has(path))
                        throw new Error(`Restore would overwrite an unmanaged file: ${path}`);
                    break;
                }
                if (i !== parts.length) continue;
                directories.add(path);
                for (const child of readdirSync(join(root, path), {
                    recursive: true,
                    withFileTypes: true,
                })) {
                    const name = relative(root, join(child.parentPath, child.name)).replaceAll(
                        "\\",
                        "/",
                    );
                    if (child.isDirectory()) directories.add(name);
                    else if (!child.isFile() || !current.has(name))
                        throw new Error(`Restore would overwrite an unmanaged file: ${name}`);
                }
            }
        }
        return () => {
            for (const file of current)
                if (!kept.has(file)) rmSync(textfilePath(root, file), { force: true });
            for (const directory of [...directories].sort((a, b) => b.length - a.length))
                rmdirSync(join(root, directory));
            for (const file of kept) {
                const target = textfilePath(root, file);
                mkdirSync(dirname(target), { recursive: true });
                cpSync(join(files, file), target);
            }
        };
    };
    return {
        list: async () => list(),
        snapshot: async (message, by) => snapshot(message, by),
        async restore(id) {
            if (!/^[\w-]+$/.test(id) || !read(id)) throw new Error("Unknown snapshot");
            const restore = prepareRestore(join(root, SNAPSHOTS, id, "files"));
            // There is no working-tree check here, so the current state is kept as a snapshot.
            const backup = snapshot(`Before restoring ${id}`);
            try {
                restore();
            } catch (error) {
                try {
                    prepareRestore(join(root, SNAPSHOTS, backup.id, "files"))();
                } catch (rollback) {
                    throw new AggregateError(
                        [error, rollback],
                        `Restore failed; recover the saved files from ${SNAPSHOTS}/${backup.id}`,
                    );
                }
                throw error;
            }
        },
    };
};

/** Chosen per request, so `git init` in a running workspace switches the driver. */
export const workspaceHistory = (root: string, branch?: string): History =>
    readWorkspaceSource(root).protocol === "git" ? gitHistory(root, branch) : folderHistory(root);
