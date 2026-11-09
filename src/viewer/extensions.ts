import { createHash } from "node:crypto";
import {
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { textfilePath } from "../compiler/textfile.js";
import { zip } from "../compiler/zip.js";
import {
    type ExtensionPackage,
    type ExtensionSummary,
    extensionFile,
    extensionManifest,
    MAX_EXTENSION_BYTES,
    readExtensionZip,
} from "../core/extension-package.js";
import type { LocalPluginStorage } from "../plugins/local-storage.js";
import {
    type ViewerPluginRegistry,
    type ViewerPlugins,
    validateViewerPlugins,
} from "./plugin-config.js";

export const EXTENSIONS_DIR = ".dooc/plugins";
const hash = (source: Uint8Array) => createHash("sha256").update(source).digest("hex");
const unpack = (data: Uint8Array) =>
    readExtensionZip(data, async (bytes, size) =>
        inflateRawSync(bytes, { maxOutputLength: Math.max(1, size) }),
    );

/** ZIPs found on disk stay inactive until the browser approves their exact content hash. */
export const createExtensionManager = (
    root: string,
    registry: ViewerPluginRegistry & { configuration?: () => ViewerPlugins },
    initial: Pick<ViewerPlugins, "plugins" | "mocks">,
    personal?: LocalPluginStorage,
) => {
    const active = new Map<string, { hash: string; config: ViewerPlugins; directory: string }>();
    const scope = createHash("sha256").update(realpathSync(root)).digest("hex");
    const approvalFile = `extensions-${scope}.json`;
    const approval = () => {
        const value = personal?.read(approvalFile);
        return value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, string>)
            : {};
    };
    const remember = (file: string, revision?: string) => {
        if (!personal) return;
        const approved = approval();
        if (revision) approved[file] = revision;
        else delete approved[file];
        personal.write(approvalFile, approved);
    };
    let queued: Promise<unknown> = Promise.resolve();
    const directory = () => {
        for (const name of [".dooc", EXTENSIONS_DIR]) {
            const entry = lstatSync(join(root, name), { throwIfNoEntry: false });
            if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
                throw new Error("Plugin folders must be local directories");
        }
        return textfilePath(root, EXTENSIONS_DIR);
    };
    const read = (name: string): Buffer | null => {
        const path = join(directory(), name);
        const entry = lstatSync(path, { throwIfNoEntry: false });
        if (!entry) return null;
        if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_EXTENSION_BYTES)
            throw new Error("Expected a plugin ZIP smaller than 16 MiB");
        return readFileSync(path);
    };
    const disable = (name: string) => {
        const value = active.get(name);
        if (!value) return;
        for (const plugin of value.config.plugins)
            if (!registry.configuration || registry.configuration().plugins.includes(plugin))
                registry.unregister(plugin.id);
        rmSync(value.directory, { recursive: true, force: true });
        active.delete(name);
    };
    const list = async () => {
        const path = directory();
        const entries = lstatSync(path, { throwIfNoEntry: false })
            ? readdirSync(path, { withFileTypes: true })
            : [];
        const items: ExtensionSummary[] = [];
        for (const entry of entries.filter(
            (entry) => entry.isFile() && entry.name.endsWith(".zip"),
        )) {
            let file: string;
            try {
                file = extensionFile(entry.name);
            } catch {
                continue;
            }
            const data = read(file);
            if (!data) continue;
            const revision = hash(data);
            const loaded = active.get(file);
            if (
                loaded &&
                (loaded.hash !== revision ||
                    (registry.configuration &&
                        loaded.config.plugins.some(
                            (plugin) => !registry.configuration?.().plugins.includes(plugin),
                        )))
            )
                disable(file);
            try {
                const pkg = await unpack(data);
                items.push({
                    file,
                    name: pkg.name,
                    icon:
                        pkg.icon ??
                        active.get(file)?.config.plugins.find((plugin) => plugin.icon)?.icon,
                    version: pkg.version,
                    hash: revision,
                    size: data.length,
                    enabled: active.has(file),
                    plugins: active.get(file)?.config.plugins.map((plugin) => plugin.id) ?? [],
                });
            } catch (error) {
                disable(file);
                items.push({
                    file,
                    name: file,
                    version: "",
                    hash: revision,
                    size: data.length,
                    enabled: false,
                    plugins: [],
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        for (const name of active.keys())
            if (!items.some((item) => item.file === name)) disable(name);
        const owned = new Set([...active.values()].flatMap((value) => value.config.plugins));
        for (const plugin of (registry.configuration?.() ?? initial).plugins) {
            if (owned.has(plugin)) continue;
            items.push({
                file: `viewer/${plugin.id}`,
                name: plugin.name ?? plugin.id,
                icon: plugin.icon,
                version: "",
                hash: "",
                size: 0,
                enabled: true,
                plugins: [plugin.id],
                readonly: true,
            });
        }
        return { scope, items: items.sort((a, b) => a.name.localeCompare(b.name)) };
    };
    const activate = async (name: string, data: Buffer, save: boolean, base: string | null) => {
        const revision = hash(data);
        if (!save && active.get(name)?.hash === revision) return;
        const pkg = await unpack(data);
        const folder = mkdtempSync(join(tmpdir(), "dooc-extension-"));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            for (const file of pkg.files) {
                const path = join(folder, file.name);
                mkdirSync(dirname(path), { recursive: true });
                writeFileSync(path, file.data, { flag: "wx" });
            }
            const module = await Promise.race([
                import(pathToFileURL(join(folder, pkg.main)).href),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error("Plugin initialization timed out")),
                        10000,
                    );
                }),
            ]);
            const config = validateViewerPlugins(module.default);
            if (
                !config.plugins.length ||
                config.setup ||
                config.gitOrigin ||
                config.workspace ||
                config.allowedDomains
            )
                throw new Error("Export a viewer configuration with plugins and optional mocks");
            const live = registry.configuration?.();
            const owned = active.get(name)?.config.plugins ?? [];
            for (const plugin of config.plugins) {
                const existing = live?.plugins.find((item) => item.id === plugin.id);
                if (existing && !owned.includes(existing))
                    throw new Error(`Plugin ID is already registered: ${plugin.id}`);
            }
            if (
                Object.keys(config.mocks).some(
                    (id) => !config.plugins.some((plugin) => plugin.id === id),
                )
            )
                throw new Error("Mocks must belong to plugins in this package");
            const other = live
                ? [
                      {
                          plugins: live.plugins.filter((plugin) => !owned.includes(plugin)),
                          mocks: Object.fromEntries(
                              Object.entries(live.mocks).filter(
                                  ([id]) => !owned.some((plugin) => plugin.id === id),
                              ),
                          ),
                      },
                  ]
                : [
                      initial,
                      ...[...active]
                          .filter(([key]) => key !== name)
                          .map(([, value]) => value.config),
                  ];
            validateViewerPlugins({
                plugins: [...other.flatMap((config) => config.plugins), ...config.plugins],
                mocks: Object.assign({}, ...other.map((config) => config.mocks), config.mocks),
            });
            if (save) {
                const current = read(name);
                if ((current ? hash(current) : null) !== base)
                    throw new Error("Plugin changed. Reopen it before saving.");
                const target = join(directory(), name);
                mkdirSync(dirname(target), { recursive: true });
                const temporary = join(dirname(target), `.upload-${Date.now()}.tmp`);
                try {
                    writeFileSync(temporary, data, { flag: "wx" });
                    renameSync(temporary, target);
                } finally {
                    rmSync(temporary, { force: true });
                }
            }
            disable(name);
            for (const plugin of config.plugins)
                registry.register(plugin, { mock: config.mocks[plugin.id] });
            active.set(name, { hash: revision, config, directory: folder });
            remember(name, revision);
        } finally {
            clearTimeout(timer);
            if (active.get(name)?.directory !== folder)
                rmSync(folder, { recursive: true, force: true });
        }
    };
    const perform = async (input: Record<string, unknown>) => {
        if (input.action === "list") return list();
        const name = extensionFile(input.file);
        const current = read(name);
        if (input.action === "read") {
            if (!current) throw new Error("Plugin not found");
            const pkg = await unpack(current);
            return {
                file: name,
                hash: hash(current),
                ...pkg,
                files: pkg.files.map((file) => ({
                    name: file.name,
                    data: Buffer.from(file.data).toString("base64"),
                })),
            };
        }
        if (input.action === "install") {
            if (
                typeof input.data !== "string" ||
                input.data.length > Math.ceil((MAX_EXTENSION_BYTES * 4) / 3) ||
                input.data.length % 4 !== 0 ||
                !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)
            )
                throw new Error("Expected a ZIP smaller than 16 MiB");
            if ((current ? hash(current) : null) !== input.base)
                throw new Error("Plugin changed. Reopen it before saving.");
            await activate(
                name,
                Buffer.from(input.data, "base64"),
                true,
                input.base as string | null,
            );
        } else {
            if (!current || hash(current) !== input.hash)
                throw new Error("Plugin changed. Reopen it before continuing.");
            if (input.action === "enable")
                await activate(name, current, false, input.hash as string);
            else if (input.action === "disable") {
                disable(name);
                remember(name);
            } else if (input.action === "delete") {
                unlinkSync(join(directory(), name));
                disable(name);
                remember(name);
            } else if (input.action === "edit") {
                if (
                    typeof input.source !== "string" ||
                    Buffer.byteLength(input.source) > MAX_EXTENSION_BYTES ||
                    input.source.includes("\0")
                )
                    throw new Error("Expected UTF-8 text smaller than 16 MiB");
                const pkg: ExtensionPackage = await unpack(current);
                const file = pkg.files.find((file) => file.name === input.path);
                if (!file) throw new Error("Plugin file not found");
                file.data = Buffer.from(input.source);
                extensionManifest(pkg.files);
                const data = zip(
                    pkg.files.map((file) => ({ name: file.name, data: Buffer.from(file.data) })),
                );
                await activate(name, data, true, input.hash as string);
            } else throw new Error("Unknown plugin action");
        }
        return list();
    };
    const request = (input: Record<string, unknown>): Promise<unknown> => {
        const result = queued.then(() => perform(input));
        queued = result.catch(() => {});
        return result;
    };
    return Object.assign(request, {
        async restore() {
            const approved = approval();
            const errors: string[] = [];
            for (const item of (await list()).items)
                if (!item.readonly && !item.error && approved[item.file] === item.hash) {
                    try {
                        await request({ action: "enable", file: item.file, hash: item.hash });
                    } catch (error) {
                        errors.push(
                            `${item.file}: ${error instanceof Error ? error.message : String(error)}`,
                        );
                    }
                }
            return errors;
        },
        dispose: () => {
            for (const name of active.keys()) disable(name);
        },
    });
};
