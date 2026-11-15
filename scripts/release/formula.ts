import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Points the Homebrew formula at a published release, using that release's SHA256SUMS. */
export function updateFormula(formula: string, version: string, sums: string): string {
    const hashes = new Map(
        sums
            .trim()
            .split("\n")
            .map((line) => line.trim().split(/\s+/).reverse() as [string, string]),
    );
    return formula
        .replace(/^( {2}version ")[^"]+/m, `$1${version}`)
        .replace(
            /dooc-v[\d.]+\/(dooc-[\w-]+\.tar\.gz)"\n(\s+sha256 ")[0-9a-f]+/g,
            (_, asset: string, sha: string) => {
                const hash = hashes.get(asset);
                if (!hash || !/^[0-9a-f]{64}$/.test(hash))
                    throw new Error(`Missing or invalid checksum for ${asset}`);
                return `dooc-v${version}/${asset}"\n${sha}${hash}`;
            },
        );
}

export const updateInstallExample = (page: string, version: string): string =>
    page.replace(/DOOC_VERSION=[\d.]+/, `DOOC_VERSION=${version}`);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const version: string = JSON.parse(readFileSync("package.json", "utf8")).version;
    const url = `https://github.com/dooc-dev/dooc/releases/download/dooc-v${version}/SHA256SUMS`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} for ${url}; is ${version} published?`);
    const sums = await response.text();
    for (const [file, update] of [
        ["Formula/dooc.rb", (text: string) => updateFormula(text, version, sums)],
        ["dooc-docs/contents/md/install.md", (text: string) => updateInstallExample(text, version)],
    ] as const)
        writeFileSync(file, update(readFileSync(file, "utf8")));
    console.log(`Updated the Homebrew formula and install example for dooc ${version}`);
}
