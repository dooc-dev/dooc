import git from "isomorphic-git";
import { parseDoc } from "../../engine/src/compiler/dialect.js";
import {
    completeFilePaths,
    filesSnapshot,
    updateFiles,
    uploadFile,
} from "../../engine/src/compiler/files.js";
import { projectRoot } from "../../engine/src/compiler/manifest.js";
import type { WorkspaceSource } from "../../engine/src/core/workspace.js";
import {
    type BrowserGitOptions,
    createBrowserGit,
    gitOptions,
} from "../../workspace/src/browser-git.js";
import { fs } from "../../workspace/src/browser-host.js";
import { messagePort } from "../../workspace/src/browser-port.js";
import {
    changedFiles,
    type FileSnapshot,
    memoryFiles,
    persistFiles,
    readDirectory,
    replaceMemory,
} from "../../workspace/src/browser-storage.js";
import {
    runCodeTool,
    validateCodeTools,
    validateTextfileCode,
} from "../../workspace/src/editor-tools.js";
import type { GitState } from "../../workspace/src/git-types.js";
import { createWorkspaceServer } from "../../workspace/src/server.js";
import { type ApplicationRequest, applicationRequest } from "./application-request.js";
import { createDocumentApplication } from "./document-application.js";

const repository = "/workspace";
let directory: FileSystemDirectoryHandle;
let root: string;
let app: ReturnType<typeof createDocumentApplication>;
let driver: ReturnType<typeof createBrowserGit> | undefined;
let source: WorkspaceSource;
let base = new Map<string, string | null>();
let options: BrowserGitOptions = {};
let queue: Promise<unknown> = Promise.resolve();
let manifest = "dooc.yaml";
let label = "Documents";
let baseHead: string | undefined;

const manifestAt = async (ref: string): Promise<boolean> => {
    try {
        const oid = await git.resolveRef({ fs, dir: repository, ref });
        await git.readBlob({ fs, dir: repository, oid, filepath: manifest });
        return true;
    } catch {
        return false;
    }
};

const configure = async () => {
    const state = await driver?.state();
    source = state
        ? { protocol: "git", repo: label, branch: state.branch || "Detached HEAD" }
        : { protocol: "storage", folder: label, service: "Browser" };
    if (driver && state?.head !== baseHead) {
        baseHead = state?.head;
        base = new Map();
        const prefix = root.slice(repository.length + 1);
        const files = [...memoryFiles(root).keys()].filter((file) => !file.startsWith(".git/"));
        for (const file of files)
            base.set(file, await driver.base(prefix ? `${prefix}/${file}` : file));
    }
    app.configure({ workspace: source, downloads: true });
};

const initialize = async (input: Record<string, unknown>) => {
    if (directory) throw new Error("Workspace is already open");
    directory = input.directory as FileSystemDirectoryHandle;
    if (!directory || directory.kind !== "directory") throw new Error("Choose a storage directory");
    options = (input.git ?? {}) as BrowserGitOptions;
    label = typeof input.label === "string" ? input.label : directory.name;
    manifest = typeof input.manifest === "string" ? input.manifest : "dooc.yaml";
    if (
        manifest
            .split("/")
            .some((part) => !part || part === "." || part === ".." || /[\\\0]/.test(part))
    )
        throw new Error("Invalid manifest path");
    const before = await readDirectory(directory);
    replaceMemory(repository, before);
    try {
        if (input.files instanceof Map) {
            if (before.size) throw new Error("Branch storage must be empty");
            replaceMemory(repository, input.files as FileSnapshot);
            if (typeof input.branch !== "string") throw new Error("Choose a branch");
            if (!(await manifestAt(input.create ? "HEAD" : `refs/heads/${input.branch}`)))
                throw new Error(
                    input.create
                        ? `Commit ${manifest} before creating a branch; new workspaces start from HEAD.`
                        : `Branch ${input.branch} does not contain ${manifest}.`,
                );
            if (input.create) await git.branch({ fs, dir: repository, ref: input.branch });
            await git.checkout({ fs, dir: repository, ref: input.branch, force: true });
        } else if (input.clone) {
            if (before.size) throw new Error("Clone storage must be empty");
            if (!options.url) throw new Error("Enter a Git HTTPS URL");
            await git.clone({
                ...gitOptions(repository, options),
                url: options.url,
                singleBranch: false,
            });
        } else if (input.create) {
            if (before.size) throw new Error("New workspace storage must be empty");
            fs.mkdirSync(`${repository}/content`, { recursive: true });
            fs.writeFileSync(`${repository}/dooc.yaml`, "docs: [welcome]\n");
            fs.writeFileSync(
                `${repository}/content/welcome.md`,
                "# Welcome\n\nWrite your first document here.\n",
            );
            await git.init({ fs, dir: repository, defaultBranch: "main" });
            if (options.url)
                await git.addRemote({ fs, dir: repository, remote: "origin", url: options.url });
        }
        if (fs.existsSync(`${repository}/.git`) && !fs.statSync(`${repository}/.git`).isDirectory())
            throw new Error(
                "Linked Git worktrees require the Node server. Open a repository with its own .git directory.",
            );
        root = projectRoot(`${repository}/${manifest}`);
        driver = fs.existsSync(`${repository}/.git`)
            ? createBrowserGit(repository, options, label)
            : undefined;
        app = createDocumentApplication(root, {
            fontCss: () =>
                "@font-face{font-family:'UDEV Gothic';font-style:normal;font-weight:400;font-display:swap;src:url(/assets/fonts/udev-gothic-regular.woff2) format('woff2')}",
            readWorkspaceSource: () => source,
            sourceFileBase: () => undefined,
            gitBaseText: (_root, file) => base.get(file) ?? null,
            gitBaseBody: (_root, file) => {
                const raw = base.get(file);
                return raw == null ? null : parseDoc(raw).body;
            },
            setSubformatChanges: () => {},
            runCodeTool,
            validateCodeTools,
            validateTextfileCode,
        });
        await configure();
        server.broadcast("phase", "storage");
        await persistFiles(directory, before, memoryFiles(repository));
        return {
            label:
                source.protocol === "git" ? `${directory.name} / ${source.branch}` : directory.name,
            manifest,
            source,
        };
    } catch (error) {
        replaceMemory(repository, before);
        throw error;
    }
};

const operations = {
    initialize,
    http: async (input: Record<string, unknown>) => {
        const result = await applicationRequest(
            app,
            "edit",
            input as unknown as ApplicationRequest,
        );
        return {
            ...result,
            body: typeof result.body === "string" ? result.body : Array.from(result.body),
        };
    },
    files: (input: Record<string, unknown>) =>
        input.action === "read"
            ? filesSnapshot(root)
            : input.action === "complete"
              ? completeFilePaths(root, input.prefix)
              : input.action === "upload"
                ? uploadFile(root, input)
                : updateFiles(root, input),
    git: async (input: Record<string, unknown>) => {
        if (!driver) throw new Error("This directory is not a Git repository");
        const result = await driver.execute(input);
        if (input.action === "branches") {
            const state = result as GitState;
            const unavailable: string[] = [];
            for (const branch of state.branches)
                if (
                    !(branch === state.branch
                        ? fs.existsSync(`${repository}/${manifest}`) &&
                          fs.statSync(`${repository}/${manifest}`).isFile()
                        : await manifestAt(`refs/heads/${branch}`))
                )
                    unavailable.push(branch);
            state.branchWorkspaces = {
                manifest,
                unavailable,
                canCreate: await manifestAt("HEAD"),
            };
        }
        return result;
    },
    workspaces: async (input: Record<string, unknown>) => {
        if (input.action !== "branch" || !driver)
            throw new Error("Open a Git repository to switch branches");
        const state = await driver.state();
        if (!state.head) throw new Error("Create the first commit before opening another branch");
        // A branch opens from committed files; drafts and working changes stay in their original pane.
        return {
            files: new Map(
                [...memoryFiles(repository)].filter(([file]) => file.startsWith(".git/")),
            ),
            manifest,
        };
    },
};

const server = createWorkspaceServer(
    Object.fromEntries(
        Object.entries(operations).map(([name, op]) => [
            name,
            (input: Record<string, unknown>) => {
                const run = async (): Promise<unknown> => {
                    if (name === "initialize") return initialize(input);
                    if (!app) throw new Error("Open a workspace first");
                    // Draft previews use the current snapshot; saves and navigation resync storage.
                    if (
                        name === "http" &&
                        input.method === "POST" &&
                        typeof input.url === "string" &&
                        ["/api/render", "/api/lint"].includes(input.url.split("?")[0] ?? "")
                    )
                        return op(input);
                    const known = memoryFiles(repository);
                    const before = await readDirectory(directory);
                    replaceMemory(repository, before);
                    await configure();
                    try {
                        const value = await op(input);
                        if (
                            name === "http" &&
                            value &&
                            typeof value === "object" &&
                            "status" in value &&
                            Number(value.status) >= 400
                        ) {
                            replaceMemory(repository, before);
                            return value;
                        }
                        const after = memoryFiles(repository);
                        server.broadcast("phase", "storage");
                        await persistFiles(directory, before, after);
                        const prefix =
                            root === repository ? "" : `${root.slice(repository.length + 1)}/`;
                        const changed = changedFiles(known, after)
                            .filter((file) => !file.startsWith(".git/") && file.startsWith(prefix))
                            .map((file) => file.slice(prefix.length));
                        if (
                            changed.length > 0 ||
                            (name === "git" &&
                                !["read", "branches", "diff"].includes(String(input.action))) ||
                            (name === "files" &&
                                !["read", "complete"].includes(String(input.action))) ||
                            (name === "http" &&
                                input.method === "POST" &&
                                !["/api/render", "/api/lint"].includes(String(input.url)))
                        )
                            server.broadcast("change", { kind: "content", files: changed });
                        return value;
                    } catch (error) {
                        replaceMemory(repository, before);
                        throw error;
                    }
                };
                const locked = () =>
                    navigator.locks
                        ? navigator.locks.request(
                              `dooc-storage:${directory?.name ?? String(input.label)}`,
                              run,
                          )
                        : run();
                const pending = queue.then(locked, locked);
                queue = pending.catch(() => {});
                return pending;
            },
        ]),
    ),
);
server.connect(messagePort(self as unknown as Worker), {});
