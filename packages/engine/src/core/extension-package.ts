export const MAX_EXTENSION_BYTES = 16 * 1024 * 1024;
export const MAX_EXTENSION_FILES = 256;
export interface ExtensionFile {
    name: string;
    data: Uint8Array;
}
export interface ExtensionPackage {
    name: string;
    version: string;
    main: string;
    icon?: { light: string; dark?: string };
    files: ExtensionFile[];
}
export interface ExtensionSummary {
    file: string;
    name: string;
    version: string;
    hash: string;
    size: number;
    enabled: boolean;
    plugins: string[];
    icon?: ExtensionPackage["icon"];
    error?: string;
    readonly?: boolean;
}
export const extensionFile = (value: unknown): string => {
    if (typeof value !== "string" || !/^[\w][\w. -]{0,119}\.zip$/.test(value))
        throw new Error("Choose a plugin ZIP file");
    return value;
};
export const extensionPath = (value: string): boolean =>
    !!value &&
    value.length <= 240 &&
    !/[\\:]/.test(value) &&
    [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
    value
        .split("/")
        .every(
            (part) =>
                !!part &&
                part !== "." &&
                part !== ".." &&
                !part.endsWith(".") &&
                !part.endsWith(" "),
        );
const table = new Uint32Array(256).map((_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    return crc >>> 0;
});
export const extensionCrc = (data: Uint8Array): number => {
    let crc = 0xffffffff;
    for (const byte of data) crc = (crc >>> 8) ^ (table[(crc ^ byte) & 255] ?? 0);
    return (crc ^ 0xffffffff) >>> 0;
};
export const extensionManifest = (files: ExtensionFile[]): ExtensionPackage => {
    const entry = files.find((file) => file.name === "package.json");
    if (!entry || entry.data.length > 65536)
        throw new Error("The ZIP needs package.json at its root");
    const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(entry.data));
    if (
        !manifest ||
        typeof manifest.name !== "string" ||
        !/^(?:@[\w.-]+\/)?[\w.-]{1,100}$/.test(manifest.name) ||
        typeof manifest.version !== "string" ||
        !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(manifest.version) ||
        manifest.type !== "module" ||
        typeof manifest.main !== "string" ||
        !extensionPath(manifest.main) ||
        !/\.m?js$/.test(manifest.main) ||
        !files.some((file) => file.name === manifest.main)
    )
        throw new Error(
            "package.json needs name, version, type: module and a bundled JavaScript main",
        );
    if (manifest.dependencies && Object.keys(manifest.dependencies).length)
        throw new Error("Bundle dependencies into the JavaScript entry before packaging");
    let icon: ExtensionPackage["icon"];
    if (manifest.icon !== undefined) {
        const asset = files.find((file) => file.name === manifest.icon);
        if (
            typeof manifest.icon !== "string" ||
            !extensionPath(manifest.icon) ||
            !manifest.icon.endsWith(".svg") ||
            !asset ||
            !asset.data.length ||
            asset.data.length > 65536
        )
            throw new Error("package.json icon must reference an SVG asset up to 64 KiB");
        icon = {
            light: `data:image/svg+xml;base64,${btoa(Array.from(asset.data, (byte) => String.fromCharCode(byte)).join(""))}`,
        };
    }
    return { name: manifest.name, version: manifest.version, main: manifest.main, files, icon };
};

/** Read bounded, single-disk ZIPs without extracting paths supplied by the archive. */
export const readExtensionZip = async (
    bytes: Uint8Array,
    inflate: (data: Uint8Array, size: number) => Promise<Uint8Array>,
): Promise<ExtensionPackage> => {
    const invalid = () => new Error("Invalid or unsupported plugin ZIP");
    if (bytes.length < 22 || bytes.length > MAX_EXTENSION_BYTES) throw invalid();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = bytes.length - 22;
    while (
        end >= Math.max(0, bytes.length - 65557) &&
        (view.getUint32(end, true) !== 0x06054b50 ||
            end + 22 + view.getUint16(end + 20, true) !== bytes.length)
    )
        end--;
    if (
        end < Math.max(0, bytes.length - 65557) ||
        view.getUint16(end + 4, true) ||
        view.getUint16(end + 6, true)
    )
        throw invalid();
    const count = view.getUint16(end + 10, true);
    const directory = view.getUint32(end + 16, true);
    if (
        !count ||
        count > MAX_EXTENSION_FILES ||
        view.getUint16(end + 8, true) !== count ||
        directory + view.getUint32(end + 12, true) !== end
    )
        throw invalid();
    const files: ExtensionFile[] = [];
    const names = new Set<string>();
    const ranges: [number, number][] = [];
    let at = directory,
        total = 0;
    for (let index = 0; index < count; index++) {
        if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) throw invalid();
        const flags = view.getUint16(at + 8, true),
            method = view.getUint16(at + 10, true);
        const compressed = view.getUint32(at + 20, true),
            size = view.getUint32(at + 24, true);
        const length = view.getUint16(at + 28, true),
            extra = view.getUint16(at + 30, true),
            comment = view.getUint16(at + 32, true);
        const offset = view.getUint32(at + 42, true),
            type = (view.getUint32(at + 38, true) >>> 16) & 0xf000;
        total += size;
        if (
            flags & ~0x080e ||
            ![0, 8].includes(method) ||
            (method === 0 && size !== compressed) ||
            total > MAX_EXTENSION_BYTES ||
            at + 46 + length + extra + comment > end ||
            offset + 30 > directory ||
            view.getUint16(at + 34, true) ||
            ![0, 0x8000, 0x4000].includes(type)
        )
            throw invalid();
        const name = new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(at + 46, at + 46 + length),
        );
        const folder = name.endsWith("/");
        const path = folder ? name.slice(0, -1) : name;
        const key = path.normalize("NFC").toLowerCase();
        if (
            !extensionPath(path) ||
            names.has(key) ||
            (folder && size !== 0) ||
            (!folder && type === 0x4000)
        )
            throw invalid();
        names.add(key);
        if (
            view.getUint32(offset, true) !== 0x04034b50 ||
            view.getUint16(offset + 6, true) !== flags ||
            view.getUint16(offset + 8, true) !== method
        )
            throw invalid();
        const localName = view.getUint16(offset + 26, true),
            localExtra = view.getUint16(offset + 28, true);
        const start = offset + 30 + localName + localExtra;
        if (
            start + compressed > directory ||
            new TextDecoder("utf-8", { fatal: true }).decode(
                bytes.subarray(offset + 30, offset + 30 + localName),
            ) !== name
        )
            throw invalid();
        if (ranges.some(([from, to]) => offset < to && start + compressed > from)) throw invalid();
        ranges.push([offset, start + compressed]);
        const input = bytes.subarray(start, start + compressed);
        const data = method === 0 ? input.slice() : await inflate(input, size);
        if (data.length !== size || extensionCrc(data) !== view.getUint32(at + 16, true))
            throw invalid();
        if (!folder) files.push({ name, data });
        at += 46 + length + extra + comment;
    }
    if (at !== end) throw invalid();
    for (const file of files)
        if (
            files.some((other) =>
                file.name
                    .normalize("NFC")
                    .toLowerCase()
                    .startsWith(`${other.name.normalize("NFC").toLowerCase()}/`),
            )
        )
            throw invalid();
    return extensionManifest(files);
};
