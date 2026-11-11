import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const [target = `bun-${process.platform}-${process.arch}`] = process.argv.slice(2);
const outfile = "build/bin/dooc";
const require = createRequire(import.meta.url);
const preset = createRequire(require.resolve("textlint-rule-preset-ja-technical-writing"));
const rule = createRequire(preset.resolve("textlint-rule-no-doubled-joshi"));
const dictionary = join(
    dirname(createRequire(rule.resolve("kuromojin")).resolve("kuromoji")),
    "../dict",
);
const dictFiles = readdirSync(dictionary).filter((name) => name.endsWith(".dat.gz"));
const assets = [
    "fonts/udev-gothic-regular.woff2",
    "fonts/LICENSE.txt",
    "flow.global.js",
    ...readdirSync("dist/graph")
        .filter((name) => name.endsWith(".js"))
        .map((name) => `graph/${name}`),
    "edit.global.js",
    "ui.global.js",
    "code.global.js",
    "code-worker.global.js",
    "plugins.global.js",
    "subformats.global.js",
];
const files = [
    ...assets.map((name) => resolve("dist", name.startsWith("fonts/") ? `viewer/${name}` : name)),
    ...dictFiles.map((name) => join(dictionary, name)),
];
mkdirSync("build", { recursive: true });
mkdirSync(dirname(outfile), { recursive: true });
writeFileSync(
    "build/entry.mjs",
    `
import { dirname } from "node:path";
import { dictionaryFiles } from ${JSON.stringify(resolve("src/viewer/assets.ts"))};
process.env.KUROMOJIN_DIC_PATH = dirname(dictionaryFiles[0]);
await import(${JSON.stringify(resolve("src/cli.ts"))});
`,
);
const result = await Bun.build({
    entrypoints: ["build/entry.mjs"],
    compile: { target, outfile, autoloadDotenv: false, autoloadBunfig: false },
    naming: { asset: "[name].[ext]" },
    external: ["esbuild"],
    plugins: [
        {
            name: "embedded-viewer-assets",
            setup(build) {
                build.onLoad({ filter: /\/viewer\/assets\.ts$/ }, () => ({
                    loader: "js",
                    contents: `
import { readFileSync } from "node:fs";
${files.map((file, i) => `import asset${i} from ${JSON.stringify(file)} with { type: "file" };`).join("\n")}
const assets = { ${assets.map((name, i) => `${JSON.stringify(name)}: asset${i}`).join(",")} };
export const dictionaryFiles = [${dictFiles.map((_, i) => `asset${i + assets.length}`).join(",")}];
export const prebuilt = true;
export const readViewerAsset = (name) => readFileSync(assets[name]);
`,
                }));
            },
        },
    ],
});
if (!result.success) throw new AggregateError(result.logs, "Binary build failed");
console.log(`Built ${outfile} (${target})`);
