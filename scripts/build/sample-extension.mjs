import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { build } from "esbuild";
import { zip } from "../../src/compiler/zip.ts";
import { readExtensionZip } from "../../src/core/extension-package.ts";

const output = resolve(process.argv[2] ?? "build/sample-extension.zip");
const bundle = await build({
    entryPoints: ["examples/viewer-plugins/extension.mjs"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    write: false,
});
const data = zip([
    {
        name: "package.json",
        data: Buffer.from(
            JSON.stringify(
                {
                    name: "@dooc/sample-services",
                    version: "1.0.0",
                    type: "module",
                    main: "index.mjs",
                    icon: "assets/taskapp.svg",
                },
                null,
                2,
            ),
        ),
    },
    { name: "index.mjs", data: Buffer.from(bundle.outputFiles[0].contents) },
    ...["taskapp", "gitapp", "chatapp"].map((name) => ({
        name: `assets/${name}.svg`,
        data: readFileSync(`examples/viewer-plugins/assets/${name}.svg`),
    })),
]);
const checked = await readExtensionZip(data, async (bytes, size) =>
    inflateRawSync(bytes, { maxOutputLength: Math.max(1, size) }),
);
assert.equal(checked.files.length, 5);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, data);
console.log(output);
