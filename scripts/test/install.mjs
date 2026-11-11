import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
    chmodSync,
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const root = mkdtempSync(join(tmpdir(), "dooc-install-"));
const installer = resolve("scripts/release/install.sh");
const workflow = parse(readFileSync(".github/workflows/release.yml", "utf8"));
const checksums = workflow.jobs.release.steps.find((step) => step.name === "Prepare checksums");
const checksumArgs = ["-e", "-c", checksums.run];
try {
    const releases = join(root, checksums["working-directory"]);
    const mocks = join(root, "mocks");
    const installDir = join(root, "install with spaces");
    mkdirSync(releases, { recursive: true });
    mkdirSync(mocks);
    writeFileSync(join(root, "dooc"), "#!/bin/sh\necho fixture\n");
    chmodSync(join(root, "dooc"), 0o755);
    const archive = join(releases, "dooc-linux-x64.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", root, "dooc"]);
    for (const platform of ["linux-arm64", "darwin-arm64", "darwin-x64"])
        copyFileSync(archive, join(releases, `dooc-${platform}.tar.gz`));
    execFileSync("bash", checksumArgs, { cwd: releases });
    const sums = readFileSync(join(releases, "SHA256SUMS"), "utf8");
    assert.equal((sums.match(/^[a-f0-9]{64} {2}dooc-.+\.tar\.gz$/gm) ?? []).length, 4);
    writeFileSync(
        join(mocks, "uname"),
        '#!/bin/sh\ncase "$1" in -s) echo "$DOOC_TEST_OS";; -m) echo "$DOOC_TEST_ARCH";; esac\n',
    );
    writeFileSync(
        join(mocks, "curl"),
        `#!/bin/sh
set -eu
[ "\${DOOC_TEST_FAIL:-0}" = 0 ] || exit 22
while [ "$#" -gt 0 ]; do
    case "$1" in
        -o) shift; dest=$1 ;;
        https://*) url=$1 ;;
    esac
    shift
done
printf '%s\n' "$url" >> "$DOOC_TEST_LOG"
cp "$DOOC_TEST_RELEASES/\${url##*/}" "$dest"
`,
    );
    chmodSync(join(mocks, "uname"), 0o755);
    chmodSync(join(mocks, "curl"), 0o755);
    const install = (env = {}) =>
        spawnSync("sh", [installer], {
            cwd: root,
            encoding: "utf8",
            env: {
                ...process.env,
                PATH: `${mocks}:${process.env.PATH}`,
                DOOC_INSTALL_DIR: installDir,
                DOOC_VERSION: "latest",
                DOOC_TEST_OS: "Linux",
                DOOC_TEST_ARCH: "x86_64",
                DOOC_TEST_RELEASES: releases,
                DOOC_TEST_LOG: join(root, "downloads"),
                ...env,
            },
        });
    let result = install();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(execFileSync(join(installDir, "dooc"), { encoding: "utf8" }), "fixture\n");
    result = install({ DOOC_VERSION: "1.2.3" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
        readFileSync(join(root, "downloads"), "utf8"),
        /dooc-dev\/dooc\/releases\/download\/dooc-v1\.2\.3\/dooc-linux-x64\.tar\.gz/,
    );
    result = install({ DOOC_TEST_OS: "Darwin", DOOC_TEST_ARCH: "arm64", DOOC_VERSION: "v1.2.3" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
        readFileSync(join(root, "downloads"), "utf8"),
        /download\/dooc-v1\.2\.3\/dooc-darwin-arm64\.tar\.gz/,
    );
    writeFileSync(join(installDir, "dooc"), "keep previous installation");
    writeFileSync(archive, "corrupted download");
    result = install();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Checksum mismatch/);
    assert.equal(readFileSync(join(installDir, "dooc"), "utf8"), "keep previous installation");
    assert.notEqual(install({ DOOC_TEST_FAIL: "1" }).status, 0);
    assert.notEqual(install({ DOOC_TEST_OS: "FreeBSD" }).status, 0);
    assert.notEqual(install({ DOOC_TEST_ARCH: "riscv64" }).status, 0);
    assert.notEqual(install({ DOOC_VERSION: "../../invalid" }).status, 0);
    rmSync(archive);
    assert.notEqual(spawnSync("bash", checksumArgs, { cwd: releases }).status, 0);
    console.log(
        "Installer checksums, platform selection, upgrades, and incomplete-release rejection passed.",
    );
} finally {
    rmSync(root, { recursive: true, force: true });
}
