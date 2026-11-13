// File metadata speeds up directory checks; parsed text is cached by contents because
// consecutive equal-size writes can have identical timestamps.

import type { Stats } from "node:fs";
import { join, readdirSync, readFileSync, statSync } from "./host.js";

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
 * Reuses parsed values when the source contents match, even if metadata changes.
 */
export const createFileCache = <T>(): { get: (path: string, compute: (raw: string) => T) => T } => {
    const store = new Map<string, { raw: string; value: T }>();
    return {
        get: (path, compute) => {
            const raw = readFileSync(path, "utf8");
            const hit = store.get(path);
            if (hit?.raw === raw) {
                return hit.value;
            }
            const value = compute(raw);
            store.set(path, { raw, value });
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
