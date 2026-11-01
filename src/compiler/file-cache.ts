// Makes the compiler incremental (even when the viewer calls compile() in full on every
// keystroke / save, files unchanged on disk aren't re-read/re-parsed). signature = mtimeMs + size.
import { readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { join } from "node:path";

export const fileSig = (path: string): string => {
    let st: Stats;
    try {
        st = statSync(path);
    } catch {
        return "-";
    }
    return `${st.mtimeMs}:${st.size}`;
};

/**
 * Memoizes a single file. If the signature matches, returns the previous value (same reference)
 * without reading/computing.
 */
export const createFileCache = <T>(): { get: (path: string, compute: (raw: string) => T) => T } => {
    const store = new Map<string, { sig: string; value: T }>();
    return {
        get: (path, compute) => {
            const sig = fileSig(path);
            const hit = store.get(path);
            if (sig !== "-" && hit?.sig === sig) {
                return hit.value;
            }
            const value = compute(readFileSync(path, "utf8"));
            if (sig === "-") {
                store.delete(path);
            } else {
                store.set(path, { sig, value });
            }
            return value;
        },
    };
};

/** Memoizes by signature (wraps a per-directory loader). */
export const createSigCache = <T>(): { get: (sig: string, compute: () => T) => T } => {
    let hit: { sig: string; value: T } | undefined;
    return {
        get: (sig, compute) => {
            if (hit?.sig !== sig) {
                hit = { sig, value: compute() };
            }
            return hit.value;
        },
    };
};

/** Names directly under dir + each name's file signature; changes on any add/delete/modify. */
export const dirSig = (dir: string, fileOf: (name: string) => string = (n) => n): string => {
    let names: string[];
    try {
        names = readdirSync(dir).sort();
    } catch {
        return "-";
    }
    return names.map((n) => `${n}:${fileSig(join(dir, fileOf(n)))}`).join("|");
};
