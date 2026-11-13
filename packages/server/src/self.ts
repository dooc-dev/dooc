import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prebuilt, readInstaller, standalone } from "./assets.js";
import { downloadGitHubArchive } from "./github-archive.js";

export const selfUpdate = (): void => {
    if (!standalone) {
        const hint =
            "Update with your package manager (npm: npm install -g @dooc-dev/dooc@latest).";
        if (!prebuilt) throw new Error(`Cannot self-update a source checkout. ${hint}`);
        const globalRoot = execFileSync("npm", ["root", "--global"], { encoding: "utf8" }).trim();
        const installed = join(globalRoot, "@dooc-dev/dooc");
        if (
            !existsSync(installed) ||
            realpathSync(fileURLToPath(new URL("../..", import.meta.url))) !==
                realpathSync(installed)
        )
            throw new Error(`This is not a global npm installation. ${hint}`);
        execFileSync("npm", ["install", "--global", "@dooc-dev/dooc@latest"], { stdio: "inherit" });
        return;
    }
    const executable = realpathSync(process.execPath);
    if (executable.includes("/Cellar/"))
        throw new Error(
            "This installation is managed by Homebrew. Run: brew upgrade dooc-dev/dooc/dooc",
        );
    if (executable.includes("/mise/installs/"))
        throw new Error(
            "This installation is managed by mise. Run: mise upgrade github:dooc-dev/dooc",
        );
    execFileSync("sh", ["-s"], {
        input: readInstaller(),
        stdio: ["pipe", "inherit", "inherit"],
        env: { ...process.env, DOOC_VERSION: "latest", DOOC_INSTALL_PATH: executable },
    });
};

export const prepareSelfDocs = async (): Promise<{ root: string; dispose: () => void }> => {
    let root: string | undefined;
    const dispose = () => {
        if (root) rmSync(root, { recursive: true, force: true });
    };
    try {
        const files = await downloadGitHubArchive(
            "https://codeload.github.com/dooc-dev/dooc/zip/refs/heads/main",
            "dooc-docs",
            "documentation",
        );
        if (!files["dooc.yaml"]?.length)
            throw new Error("GitHub main does not contain dooc-docs/dooc.yaml");
        root = mkdtempSync(join(tmpdir(), "dooc-docs-"));
        for (const [name, data] of Object.entries(files)) {
            const path = join(root, name);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, data, { flag: "wx" });
        }
        return { root, dispose };
    } catch (error) {
        dispose();
        throw new Error(
            `Failed to download documentation from GitHub: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
        );
    }
};
