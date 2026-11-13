import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createContext, runInContext } from "node:vm";
import git from "isomorphic-git";
import { ScriptTarget, transpileModule } from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import { createBrowserGit } from "../../workspace/src/browser-git.js";
import { fs } from "../../workspace/src/browser-host.js";
import { memoryFiles, replaceMemory } from "../../workspace/src/browser-storage.js";

const repository = "/workspace-branches-test";
const author = { name: "Test", email: "test@example.com" };
const source = readFileSync(new URL("./workspace-worker.ts", import.meta.url), "utf8");
const extract = (start: string, end: string): string => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);
    return source.slice(from, to);
};

// Exercise the worker's branch operations with real Git objects without booting its document UI.
const worker = (manifest: string) => {
    const context = createContext({
        repository,
        manifest,
        git,
        fs,
        Map,
        directory: undefined,
        root: repository,
        options: {},
        label: "Docs",
        source: undefined,
        driver: createBrowserGit(repository, {}, "Docs"),
        app: undefined,
        base: new Map(),
        createBrowserGit,
        readDirectory: vi.fn(async () => new Map()),
        replaceMemory,
        memoryFiles,
        persistFiles: vi.fn(),
        projectRoot: dirname,
        createDocumentApplication: vi.fn(() => ({ configure: vi.fn() })),
        server: { broadcast: vi.fn() },
        runCodeTool: vi.fn(),
        validateCodeTools: vi.fn(),
        validateTextfileCode: vi.fn(),
    });
    context.configure = async () => {
        const state = await context.driver.state();
        context.source = { protocol: "git", repo: "Docs", branch: state.branch };
    };
    runInContext(
        transpileModule(
            [
                extract("const manifestAt =", "\nconst configure ="),
                extract("const initialize =", "\nconst operations ="),
                extract("const operations =", "\nconst server ="),
                "globalThis.initialize = initialize; globalThis.readGit = operations.git;",
            ].join("\n"),
            { compilerOptions: { target: ScriptTarget.ES2022 } },
        ).outputText,
        context,
    );
    return context;
};

const repositoryWithoutDocs = async () => {
    fs.mkdirSync(repository, { recursive: true });
    await git.init({ fs, dir: repository, defaultBranch: "main" });
    fs.writeFileSync(`${repository}/other.txt`, "Original commit\n");
    await git.add({ fs, dir: repository, filepath: "other.txt" });
    await git.commit({ fs, dir: repository, message: "Initial", author });
    await git.branch({ fs, dir: repository, ref: "without-docs" });
};
const writeManifest = (manifest: string, content = "docs: []\n") => {
    fs.mkdirSync(dirname(`${repository}/${manifest}`), { recursive: true });
    fs.writeFileSync(`${repository}/${manifest}`, content);
};
const commitManifest = async (manifest: string) => {
    writeManifest(manifest);
    await git.add({ fs, dir: repository, filepath: manifest });
    return git.commit({ fs, dir: repository, message: "Add docs", author });
};
const branchFiles = () =>
    new Map([...memoryFiles(repository)].filter(([name]) => name.startsWith(".git/")));
const directory = { kind: "directory", name: "Docs" };

afterEach(() => {
    fs.rmSync(repository, { recursive: true, force: true });
    vi.restoreAllMocks();
});

it.each([
    "dooc.yaml",
    "docs/team.dooc.yaml",
])("reports committed branch availability for %s without hiding the active untracked workspace", async (manifest) => {
    await repositoryWithoutDocs();
    writeManifest(manifest);
    const context = worker(manifest);
    expect((await context.readGit({ action: "branches" })).branchWorkspaces).toEqual({
        manifest,
        unavailable: ["without-docs"],
        canCreate: false,
    });
    await commitManifest(manifest);
    await git.branch({ fs, dir: repository, ref: "with-docs" });
    expect((await context.readGit({ action: "branches" })).branchWorkspaces).toEqual({
        manifest,
        unavailable: ["without-docs"],
        canCreate: true,
    });
    expect(await context.readGit({ action: "read" })).not.toHaveProperty("branchWorkspaces");
    fs.unlinkSync(`${repository}/${manifest}`);
    expect((await context.readGit({ action: "branches" })).branchWorkspaces).toEqual({
        manifest,
        unavailable: ["main", "without-docs"],
        canCreate: true,
    });
});

it.each([
    true,
    false,
])("rejects a missing manifest before creating or checking out a copied branch (create: %s)", async (create) => {
    const manifest = "dooc-docs/team.dooc.yaml";
    await repositoryWithoutDocs();
    writeManifest(manifest);
    const files = branchFiles();
    const context = worker(manifest);
    const branch = vi.spyOn(git, "branch");
    const checkout = vi.spyOn(git, "checkout");
    await expect(
        context.initialize({
            directory,
            manifest,
            files,
            branch: create ? "new-topic" : "without-docs",
            create,
        }),
    ).rejects.toThrow(
        create
            ? `Commit ${manifest} before creating a branch`
            : `Branch without-docs does not contain ${manifest}`,
    );
    expect(branch).not.toHaveBeenCalled();
    expect(checkout).not.toHaveBeenCalled();
    expect(context.persistFiles).not.toHaveBeenCalled();
    expect(memoryFiles(repository).size).toBe(0);
    expect(files.has(".git/refs/heads/new-topic")).toBe(false);
});

it("creates a branch from HEAD without carrying staged or untracked source edits or making a commit", async () => {
    const manifest = "docs/team.dooc.yaml";
    await repositoryWithoutDocs();
    const head = await commitManifest(manifest);
    writeManifest(manifest, "docs: [staged-only]\n");
    await git.add({ fs, dir: repository, filepath: manifest });
    fs.writeFileSync(`${repository}/untracked.txt`, "Keep in source workspace\n");
    const files = branchFiles();
    const context = worker(manifest);
    await context.initialize({ directory, manifest, files, branch: "topic", create: true });
    expect(await git.currentBranch({ fs, dir: repository })).toBe("topic");
    expect(await git.resolveRef({ fs, dir: repository, ref: "HEAD" })).toBe(head);
    expect(fs.readFileSync(`${repository}/${manifest}`, "utf8")).toBe("docs: []\n");
    expect(fs.existsSync(`${repository}/untracked.txt`)).toBe(false);
    expect(files.has(".git/refs/heads/topic")).toBe(false);
    expect(context.persistFiles).toHaveBeenCalledOnce();
});

it("reopens saved dirty branch storage even when its selected manifest is not committed", async () => {
    const manifest = "docs/team.dooc.yaml";
    await repositoryWithoutDocs();
    await git.branch({ fs, dir: repository, ref: "saved-topic" });
    await git.checkout({ fs, dir: repository, ref: "saved-topic" });
    writeManifest(manifest, "docs: [unfinished]\n");
    const snapshot = memoryFiles(repository);
    const context = worker(manifest);
    context.readDirectory.mockResolvedValue(snapshot);
    const checkout = vi.spyOn(git, "checkout");
    await context.initialize({ directory, manifest });
    expect(fs.readFileSync(`${repository}/${manifest}`, "utf8")).toBe("docs: [unfinished]\n");
    expect(await git.currentBranch({ fs, dir: repository })).toBe("saved-topic");
    expect(checkout).not.toHaveBeenCalled();
    expect((await context.readGit({ action: "branches" })).branchWorkspaces).toMatchObject({
        manifest,
        canCreate: false,
    });
});
