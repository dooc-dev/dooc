import { execFileSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    watch,
    writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import { addProjectFont } from "../packages/engine/src/compiler/fonts.js";
import { textfilePath } from "../packages/engine/src/compiler/textfile.js";

const repository = fileURLToPath(new URL("../", import.meta.url));

export const devWorkspaceSnapshot = (root: string): Map<string, Buffer> =>
    new Map(
        execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" })
            .split("\0")
            .filter(Boolean)
            .map((file) => [file, readFileSync(join(root, file))]),
    );

/** Apply source updates only while the working copy still matches its previous source. */
export const syncDevWorkspace = (
    root: string,
    before: Map<string, Buffer>,
    after: Map<string, Buffer>,
): { updated: string[]; conflicts: string[] } => {
    const updated: string[] = [];
    const conflicts: string[] = [];
    const same = (a?: Buffer, b?: Buffer) => (a && b ? a.equals(b) : a === b);
    for (const file of new Set([...before.keys(), ...after.keys()])) {
        const old = before.get(file);
        const next = after.get(file);
        if (same(old, next)) continue;
        let path: string;
        let current: Buffer | undefined;
        try {
            path = textfilePath(root, file);
            if (path !== resolve(root, file)) throw new Error("Generated path was redirected");
            current = existsSync(path) ? readFileSync(path) : undefined;
        } catch {
            conflicts.push(file);
            continue;
        }
        if (same(current, next)) continue;
        if (!same(current, old)) {
            conflicts.push(file);
            continue;
        }
        if (next) {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, next);
        } else rmSync(path);
        updated.push(file);
    }
    return { updated, conflicts };
};

export const watchDevWorkspace = (
    root: string,
    testPageUrl?: string,
    initial = devWorkspaceSnapshot(root),
): { close: () => void } => {
    let before = initial;
    let timer: NodeJS.Timeout | undefined;
    const refresh = () => {
        timer = undefined;
        const generated = mkdtempSync(join(tmpdir(), "dooc-dev-source-"));
        try {
            createDevWorkspace(generated, testPageUrl);
            const after = devWorkspaceSnapshot(generated);
            const result = syncDevWorkspace(root, before, after);
            before = after;
            if (result.updated.length)
                console.log(`Updated ${result.updated.length} playground files from source.`);
            if (result.conflicts.length)
                console.warn(`Kept local playground edits: ${result.conflicts.join(", ")}`);
        } catch (error) {
            console.error("Could not update the playground:", error);
        } finally {
            rmSync(generated, { recursive: true, force: true });
        }
    };
    const watchers = [
        "dooc-docs",
        "sample/dooc-sample-project",
        "scripts/fixtures/dev-workspace",
    ].map((source) =>
        watch(join(repository, source), { recursive: true }, (_event, file) => {
            if (!file || /(^|[\\/])(?:\.git|dooc-imports)(?:[\\/]|$)|\.(?:tmp|swp)$/.test(file))
                return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(refresh, 150);
        }),
    );
    return {
        close() {
            if (timer) clearTimeout(timer);
            for (const watcher of watchers) watcher.close();
        },
    };
};

export const createDevWorkspace = (root: string, testPageUrl?: string): void => {
    rmSync(root, { recursive: true, force: true });
    const documentation = join(repository, "dooc-docs");
    const project = join(repository, "sample/dooc-sample-project");
    for (const directory of ["contents", "themes"])
        cpSync(join(documentation, directory), join(root, directory), { recursive: true });
    const renamed = [
        ["index", "atlas"],
        ["records", "atlas-records"],
    ] as const;
    cpSync(join(project, "contents"), join(root, "contents"), {
        recursive: true,
        filter: (file) =>
            !renamed.some(([name]) => file === join(project, `contents/md/${name}.md`)),
    });
    const atlas = parse(readFileSync(join(project, "dooc.yaml"), "utf8"));
    for (const [name, replacement] of renamed) {
        const file = `contents/md/${name}.md`;
        const destination = `contents/md/${replacement}.md`;
        writeFileSync(
            join(root, destination),
            readFileSync(join(project, file), "utf8").replaceAll(
                "contents/md/records.md",
                "contents/md/atlas-records.md",
            ),
        );
        for (const { document } of atlas.document.children)
            if (document.url === file) document.url = destination;
    }
    cpSync(join(repository, "scripts/fixtures/dev-workspace"), root, { recursive: true });
    addProjectFont(root, join(repository, "packages/server/src/fonts/udev-gothic-regular.woff2"));
    cpSync(
        join(repository, "packages/server/src/fonts/LICENSE.txt"),
        join(root, ".dooc/fonts/LICENSE.txt"),
    );
    const reference = parse(readFileSync(join(documentation, "dooc.yaml"), "utf8"));
    const [introduction, ...chapters] = reference.document.children;
    const [overview, ...projectPages] = atlas.document.children;
    const manifest = {
        ...reference,
        version: { major: 1, minor: "git", patch: "git" },
        document: {
            title: "dooc playground",
            url: "redirect:first",
            icon: reference.document.icon,
            sidebar: { ...reference.document.sidebar, title: { eng: "dooc playground" } },
            children: [
                {
                    document: {
                        url: "contents/md/start.md",
                        title: "Start here",
                        children: [
                            {
                                document: {
                                    url: "contents/md/playground.md",
                                    title: "Editing playground",
                                },
                            },
                            {
                                document: {
                                    url: "contents/md/form-controls.md",
                                    title: "Form controls",
                                    children: [{ document: { subformat: "task", title: "Tasks" } }],
                                },
                            },
                            {
                                document: {
                                    url: "contents/md/integrations.md",
                                    title: "Local integrations",
                                },
                            },
                            {
                                document: {
                                    url: "contents/md/history.md",
                                    title: "History playground",
                                },
                            },
                            ...(testPageUrl
                                ? [{ document: { url: testPageUrl, title: "Iframe test page" } }]
                                : []),
                            {
                                document: {
                                    url: "https://dooc.dev/",
                                    title: "dooc.dev",
                                },
                            },
                        ],
                    },
                },
                {
                    document: {
                        ...overview.document,
                        title: "Project delivery",
                        children: projectPages,
                    },
                },
                {
                    document: {
                        ...introduction.document,
                        title: "Feature reference",
                        children: [...introduction.document.children, ...chapters],
                    },
                },
            ],
        },
        json_subformats: [
            {
                ext: "task",
                format: "json",
                schema: "contents/json/task.schema.json",
                icon: "contents/svg/icons/issue.svg",
                layouts: { card_title: "title", group_by: "status", sort_by: "due" },
            },
            ...atlas.json_subformats,
            ...reference.json_subformats,
        ],
    };
    delete manifest.default_subformat_folder;
    writeFileSync(join(root, "dooc.yaml"), stringify(manifest));
    // A separate repository keeps development edits and ignore rules out of dooc's own worktree.
    const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    const git = (...args: string[]) =>
        execFileSync("git", ["-C", root, ...args], {
            env: {
                ...env,
                GIT_CONFIG_GLOBAL: devNull,
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_TERMINAL_PROMPT: "0",
            },
            stdio: "pipe",
        });
    git("init", "--initial-branch=main");
    git("config", "user.name", "Dooc Development");
    git("config", "user.email", "dev@dooc.invalid");
    git("config", "commit.gpgsign", "false");
    git("config", "core.hooksPath", devNull);
    git("add", ".");
    git("commit", "-m", "Generate disposable workspace");
    const taskFile = "contents/task/first.task";
    const task = JSON.parse(readFileSync(join(root, taskFile), "utf8"));
    task.status = "Doing";
    task.progress = 50;
    writeFileSync(join(root, taskFile), `${JSON.stringify(task, null, 2)}\n`);
    git("add", taskFile);
    git("commit", "-m", "Start the form-control review");
    git("branch", "example", "HEAD~1");
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    if (process.argv.length !== 2) throw new Error("Expected no arguments");
    const root = fileURLToPath(new URL("../build/dev/workspace/", import.meta.url));
    createDevWorkspace(root);
    console.log(`Created disposable workspace: ${root}`);
}
