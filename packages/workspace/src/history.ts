// The history group of the workspace protocol: whole-workspace snapshots. The driver decides where
// they live (Git commits, or copies kept beside the workspace); the UI only sees this shape.

export interface Person {
    name: string;
    email?: string;
}

export interface Snapshot {
    id: string;
    /** ISO 8601. */
    time: string;
    message: string;
    author?: string;
    /** Names of everyone else credited with edits in this snapshot. */
    coAuthors?: string[];
}

export interface History {
    /** Newest first. */
    list(): Promise<Snapshot[]>;
    /** Without an author the driver records its own default (Git's configured user). */
    snapshot(message: string, by?: { author?: Person; coAuthors?: Person[] }): Promise<Snapshot>;
    /** Brings the files back to a snapshot without discarding anything recorded after it. */
    restore(id: string): Promise<void>;
}

/** One line of display text, safe inside a Git author field or trailer. */
export const parsePerson = (input: Record<string, unknown>): Person => {
    const clean = (value: unknown) =>
        typeof value === "string"
            ? value
                  .replace(/[<>\r\n\0]/g, "")
                  .trim()
                  .slice(0, 100)
            : "";
    const name = clean(input.name);
    if (!name) throw new Error("A name is required");
    const email = clean(input.email);
    return email ? { name, email } : { name };
};

/**
 * The `history` operation. Requests run one at a time so two snapshots never interleave.
 * Everyone who reported an edit (`contribute`) since the last snapshot is credited on the next
 * one, whoever takes it. Edits that nobody snapshots are recorded on their authors' behalf:
 * `idleMs` after the last edit, or `leaveMs` after an editor's connection is gone (the grace
 * period lets a reload or a brief network drop come back without a commit).
 */
export const createHistoryOp = (
    history: () => History,
    auto: { idleMs?: number; leaveMs?: number } = {},
) => {
    let queue: Promise<unknown> = Promise.resolve();
    let idle: ReturnType<typeof setTimeout> | undefined;
    const contributors = new Map<string, Person>();
    const serial = <T>(run: () => Promise<T>): Promise<T> => {
        const result = queue.then(run, run);
        queue = result.catch(() => {});
        return result;
    };
    const snapshot = async (message: string, author?: Person): Promise<Snapshot> => {
        const coAuthors = [...contributors.values()].filter((p) => p.name !== author?.name);
        const taken = await history().snapshot(message, { author, coAuthors });
        contributors.clear();
        return taken;
    };
    const later = (ms: number | undefined): void => {
        if (ms === undefined) return;
        clearTimeout(idle);
        idle = setTimeout(() => void flush(), ms);
        // A pending snapshot must not keep a Node process alive.
        (idle as { unref?: () => void }).unref?.();
    };
    /** Records pending edits, if any; having nothing to record is not an error here. */
    const flush = (): Promise<Snapshot | undefined> =>
        serial(async () => {
            if (!contributors.size) return undefined;
            // No author: the driver's default stands for the workspace itself.
            return snapshot("Auto snapshot").catch(() => undefined);
        });
    return {
        flush,
        /** The host calls this when a connection closes or stops answering heartbeats. */
        left: (session: { user?: Person }): void => {
            if (session.user && contributors.has(session.user.name)) later(auto.leaveMs);
        },
        op: (input: Record<string, unknown>, session: { user?: Person }): Promise<unknown> => {
            if (input.action === "contribute") {
                if (session.user) {
                    contributors.set(session.user.name, session.user);
                    later(auto.idleMs);
                }
                return Promise.resolve({ ok: true });
            }
            return serial(async () => {
                if (input.action === "list") return history().list();
                if (input.action === "snapshot") {
                    const message = typeof input.message === "string" ? input.message.trim() : "";
                    if (!message) throw new Error("A snapshot needs a message");
                    return snapshot(message, session.user);
                }
                if (input.action === "restore" && typeof input.id === "string") {
                    await history().restore(input.id);
                    return { ok: true };
                }
                throw new Error("Unknown history action");
            });
        },
    };
};
