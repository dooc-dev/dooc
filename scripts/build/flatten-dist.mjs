// Flatten the mirrored package and SDK sources into their published dist/<name>/ paths.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const sources = [
    ...readdirSync("packages").map((pkg) => [pkg, `dist/packages/${pkg}/src`]),
    ["plugins", "dist/plugins/src"],
];
for (const [pkg, source] of sources) {
    const out = `dist/${pkg}`;
    if (!existsSync(source)) continue;
    cpSync(source, out, { recursive: true });
    rmSync(source, { recursive: true });
    for (const name of readdirSync(out, { recursive: true, encoding: "utf8" })) {
        if (!/\.(js|d\.ts)$/.test(name)) continue;
        const file = `${out}/${name}`;
        const text = readFileSync(file, "utf8");
        // shortcut: textual source-path rewrites, switch to a bundler if a string literal needs those paths
        const flat = text
            .replace(/\.\.\/\.\.\/plugins\/src\//g, "plugins/")
            .replace(/\.\.\/(\w+)\/src\//g, "$1/");
        if (flat !== text) writeFileSync(file, flat);
    }
}
rmSync("dist/packages", { recursive: true, force: true });
