import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseOAuthToken } from "./oauth.js";
import type { DataPlugin, OAuthToken, PluginUser } from "./types.js";

export interface SavedConnection {
    token: OAuthToken;
    expires: number;
    user: PluginUser;
}
export interface PluginCredentialStore {
    get(plugin: DataPlugin): SavedConnection | undefined;
    set(plugin: DataPlugin, value?: SavedConnection): void;
    withLock?<T>(plugin: DataPlugin, run: () => Promise<T>): Promise<T>;
}

/** Personal state is outside document roots and never included in exported bundles. */
export const createLocalPluginStorage = (
    userDir = process.env.DOOC_USER_DIR ?? join(homedir(), ".dooc"),
) => {
    const folder = join(userDir, "plugins");
    const path = (name: string) => {
        if (!/^[a-z]+-[a-f0-9]{64}\.json$/.test(name))
            throw new Error("Invalid plugin storage key");
        for (const directory of [userDir, folder]) {
            const entry = lstatSync(directory, { throwIfNoEntry: false });
            if (
                entry &&
                (!entry.isDirectory() ||
                    entry.isSymbolicLink() ||
                    (process.platform !== "win32" &&
                        ((entry.mode & 0o022) !== 0 || entry.uid !== process.getuid?.())))
            )
                throw new Error("Personal plugin storage must be a local directory");
        }
        return join(folder, name);
    };
    const read = (name: string): unknown => {
        const file = path(name);
        const entry = lstatSync(file, { throwIfNoEntry: false });
        if (!entry) return undefined;
        if (
            !entry.isFile() ||
            entry.isSymbolicLink() ||
            entry.size > 1_048_576 ||
            (process.platform !== "win32" &&
                ((entry.mode & 0o077) !== 0 || entry.uid !== process.getuid?.()))
        )
            throw new Error("Personal plugin files must be private to the current user");
        return JSON.parse(readFileSync(file, "utf8"));
    };
    const write = (name: string, value: unknown) => {
        const file = path(name);
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
        try {
            writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
            renameSync(temporary, file);
        } finally {
            rmSync(temporary, { force: true });
        }
    };
    const key = (plugin: DataPlugin) =>
        `credentials-${createHash("sha256")
            .update(
                JSON.stringify([
                    plugin.id,
                    plugin.oauth.authorizationUrl,
                    plugin.oauth.tokenUrl,
                    plugin.oauth.clientId,
                    plugin.oauth.clientSecret ?? "",
                    [...plugin.oauth.scopes].sort(),
                    [...plugin.apiOrigins].sort(),
                    plugin.oauth.authorizationParams ?? {},
                    ...(plugin.oauth.deviceAuthorizationUrl
                        ? [plugin.oauth.deviceAuthorizationUrl]
                        : []),
                ]),
            )
            .digest("hex")}.json`;
    const credentials: PluginCredentialStore = {
        get(plugin) {
            const value = read(key(plugin)) as SavedConnection | undefined;
            if (!value) return undefined;
            const token = parseOAuthToken(value.token);
            if (
                !value.user ||
                typeof value.user.id !== "string" ||
                !value.user.id ||
                value.user.id.length > 512 ||
                typeof value.user.name !== "string" ||
                !value.user.name ||
                value.user.name.length > 512 ||
                (value.expires !== null &&
                    (typeof value.expires !== "number" || !Number.isFinite(value.expires)))
            )
                throw new Error("Invalid saved plugin login");
            return { token, user: value.user, expires: value.expires ?? Infinity };
        },
        set(plugin, value) {
            write(key(plugin), value ?? null);
        },
        async withLock(plugin, run) {
            const lock = `${path(key(plugin))}.lock`;
            mkdirSync(folder, { recursive: true, mode: 0o700 });
            const owner = randomBytes(16).toString("hex");
            const deadline = Date.now() + 20000;
            while (true) {
                try {
                    writeFileSync(lock, owner, { flag: "wx", mode: 0o600 });
                    break;
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
                    const entry = lstatSync(lock, { throwIfNoEntry: false });
                    if (entry?.isSymbolicLink()) throw new Error("Invalid login lock");
                    if (entry && Date.now() - entry.mtimeMs > 30000) rmSync(lock, { force: true });
                    if (Date.now() >= deadline)
                        throw new Error(
                            "Another dooc process is refreshing this login. Try again.",
                        );
                    await delay(50);
                }
            }
            try {
                return await run();
            } finally {
                if (readFileSync(lock, "utf8") === owner) rmSync(lock, { force: true });
            }
        },
    };
    return { read, write, credentials };
};
export type LocalPluginStorage = ReturnType<typeof createLocalPluginStorage>;
