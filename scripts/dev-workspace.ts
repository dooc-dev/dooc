import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import { addProjectFont } from "../packages/engine/src/compiler/fonts.js";

const repository = fileURLToPath(new URL("../", import.meta.url));

export const createDevWorkspace = (root: string): void => {
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
        for (const page of atlas.center_contents) if (page.file === file) page.file = destination;
    }
    cpSync(join(repository, "scripts/fixtures/dev-workspace"), root, { recursive: true });
    addProjectFont(root, join(repository, "packages/server/src/fonts/udev-gothic-regular.woff2"));
    cpSync(
        join(repository, "packages/server/src/fonts/LICENSE.txt"),
        join(root, ".dooc/fonts/LICENSE.txt"),
    );
    const reference = parse(readFileSync(join(documentation, "dooc.yaml"), "utf8"));
    const [introduction, ...chapters] = reference.center_contents;
    const [overview, ...projectPages] = atlas.center_contents;
    const manifest = {
        ...reference,
        version: { major: 1, minor: "git", patch: "git" },
        left_sidebar: {
            ...reference.left_sidebar,
            title: { eng: "dooc playground" },
        },
        center_contents: [
            {
                file: "contents/md/start.md",
                title: "Start here",
                children: [
                    { file: "contents/md/playground.md", title: "Editing playground" },
                    {
                        file: "contents/md/form-controls.md",
                        title: "Form controls",
                        children: [{ subformat: "task", title: "Tasks" }],
                    },
                    { file: "contents/md/integrations.md", title: "Local integrations" },
                    { file: "contents/md/history.md", title: "History playground" },
                ],
            },
            { ...overview, title: "Project delivery", children: projectPages },
            {
                ...introduction,
                title: "Feature reference",
                children: [...introduction.children, ...chapters],
            },
        ],
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
    const product = process.argv[2];
    if (process.argv.length !== 3 || (product !== "editor" && product !== "viewer"))
        throw new Error("Expected editor or viewer");
    const root = fileURLToPath(new URL(`../build/dev/${product}/`, import.meta.url));
    createDevWorkspace(root);
    console.log(`Created disposable workspace: ${root}`);
}
