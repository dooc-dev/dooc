import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cache = mkdtempSync(join(tmpdir(), "dooc-package-check-"));
try {
    const [packed] = JSON.parse(
        execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json", "--cache", cache], {
            cwd: new URL("../../", import.meta.url),
            encoding: "utf8",
            timeout: 60_000,
        }),
    );
    const paths = packed.files.map((file) => file.path);
    assert.deepEqual(
        paths.filter((path) => !path.startsWith("dist/")),
        ["LICENSE", "README.md", "package.json"],
        "Only runtime files and package metadata may be published",
    );
    assert.deepEqual(
        paths.filter((path) => /(^|\/)(dooc-docs|sample|examples|fixtures)(\/|$)/.test(path)),
        [],
        "Documentation and example workspaces must be fetched separately",
    );
    for (const path of [
        "dist/server/cli.js",
        "dist/server/application.js",
        "dist/client.global.js",
        "dist/workspace-worker.global.js",
        "dist/install.sh",
    ])
        assert.ok(paths.includes(path), `Missing runtime file: ${path}`);
    console.log(`npm package verified: ${paths.length} files, no bundled documentation or samples`);
} finally {
    rmSync(cache, { recursive: true, force: true });
}
