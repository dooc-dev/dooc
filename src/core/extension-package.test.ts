import { inflateRawSync } from "node:zlib";
import { expect, it } from "vitest";
import { zip } from "../compiler/zip.js";
import { MAX_EXTENSION_BYTES, MAX_EXTENSION_FILES, readExtensionZip } from "./extension-package.js";

const manifest = {
    name: "@dooc/example",
    version: "1.0.0",
    type: "module",
    main: "dist/index.mjs",
};
const entries = [
    { name: "package.json", data: Buffer.from(JSON.stringify(manifest)) },
    { name: "dist/index.mjs", data: Buffer.from("export default { plugins: [] };") },
    { name: "assets/icon.svg", data: Buffer.from("<svg/>") },
];
const unpack = (bytes: Uint8Array) =>
    readExtensionZip(bytes, async (data, size) =>
        inflateRawSync(data, { maxOutputLength: Math.max(1, size) }),
    );
it("reads compressed packages with bundled entries and SVG assets", async () => {
    const pkg = await unpack(zip(entries));
    expect(pkg).toMatchObject({
        name: manifest.name,
        version: manifest.version,
        main: manifest.main,
    });
    expect(Buffer.from(pkg.files[2]?.data ?? []).toString()).toBe("<svg/>");
});
it("reads an icon from package assets without accepting external or missing paths", async () => {
    const withIcon = (icon: unknown) =>
        zip([
            { name: "package.json", data: Buffer.from(JSON.stringify({ ...manifest, icon })) },
            ...entries.slice(1),
        ]);
    expect((await unpack(withIcon("assets/icon.svg"))).icon).toEqual({
        light: `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`,
    });
    for (const icon of [
        "https://example.com/icon.svg",
        "../icon.svg",
        "missing.svg",
        "dist/index.mjs",
        null,
    ])
        await expect(unpack(withIcon(icon))).rejects.toThrow("icon must reference");
    await expect(
        unpack(
            zip([
                {
                    name: "package.json",
                    data: Buffer.from(JSON.stringify({ ...manifest, icon: "assets/icon.svg" })),
                },
                ...entries.slice(1, 2),
                { name: "assets/icon.svg", data: Buffer.alloc(65537, 32) },
            ]),
        ),
    ).rejects.toThrow("64 KiB");
});
it("rejects path escapes, duplicate paths, file-directory conflicts and excessive entries", async () => {
    for (const name of [
        "../escape",
        "/absolute",
        "a/../../escape",
        "a\\b",
        "C:/file",
        "a/./b",
        "a//b",
        "a/evil. ",
        "PACKAGE.JSON",
        "dist",
        "DIST",
    ])
        await expect(
            unpack(zip([...entries, { name, data: Buffer.from("bad") }])),
        ).rejects.toThrow();
    await expect(
        unpack(
            zip(
                Array.from({ length: MAX_EXTENSION_FILES + 1 }, (_, index) => ({
                    name: String(index),
                    data: Buffer.alloc(0),
                })),
            ),
        ),
    ).rejects.toThrow();
});
it("rejects symlinks, encryption, forged sizes, CRC corruption and truncated archives", async () => {
    const good = zip(entries);
    const directory = good.readUInt32LE(good.length - 6);
    for (const mutate of [
        (copy: Buffer) => copy.writeUInt32LE((0o120777 << 16) >>> 0, directory + 38),
        (copy: Buffer) => copy.writeUInt16LE(1, directory + 8),
        (copy: Buffer) => copy.writeUInt32LE(MAX_EXTENSION_BYTES + 1, directory + 24),
        (copy: Buffer) => copy.writeUInt32LE(0, directory + 16),
        (copy: Buffer) => copy.writeUInt32LE(0xffffffff, directory + 42),
    ]) {
        const copy = Buffer.from(good);
        mutate(copy);
        await expect(unpack(copy)).rejects.toThrow();
    }
    await expect(unpack(good.subarray(0, good.length - 1))).rejects.toThrow();
});
it("requires a root manifest, bundled dependencies and an existing JavaScript entry", async () => {
    for (const change of [
        { main: "../main.mjs" },
        { main: "missing.js" },
        { type: "commonjs" },
        { dependencies: { example: "*" } },
        { version: "latest" },
    ]) {
        await expect(
            unpack(
                zip([
                    {
                        name: "package.json",
                        data: Buffer.from(JSON.stringify({ ...manifest, ...change })),
                    },
                    ...entries.slice(1),
                ]),
            ),
        ).rejects.toThrow();
    }
    await expect(unpack(zip(entries.slice(1)))).rejects.toThrow("package.json");
});
