import { execFileSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { docFile, readManifest } from "./compiler/manifest.js";
import { fetchPublicFile } from "./compiler/public-file.js";
import { createTools, handleRpc } from "./mcp.js";
import type { GitOrigin, GitPullRequest } from "./viewer/git-types.js";

vi.mock("./compiler/public-file.js", () => ({ fetchPublicFile: vi.fn() }));
vi.mock("./viewer/serve.js", async (original) => ({
    ...(await original<typeof import("./viewer/serve.js")>()),
    bundleClient: vi.fn().mockResolvedValue("/* bundled runtime */"),
}));
const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
});

const fixture = (sample = true): string => {
    const root = mkdtempSync(join(tmpdir(), "docs-mcp-"));
    roots.push(root);
    if (sample)
        cpSync(new URL("../sample-content", import.meta.url).pathname, root, { recursive: true });
    else {
        mkdirSync(join(root, "content"));
        writeFileSync(join(root, "dooc.yaml"), "defaultLang: eng\ndocs: [guide]\n");
        writeFileSync(join(root, "content/guide.md"), "---\ntitle: Guide\n---\n\nHello\n");
    }
    return root;
};

const call = async (tools: ReturnType<typeof createTools>, name: string, args: unknown = {}) => {
    const res = (await handleRpc(tools, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
    })) as { result: { content: { text: string }[]; isError: boolean } };
    return { ...JSON.parse(res.result.content[0]?.text ?? "null"), isError: res.result.isError };
};

describe("mcp", () => {
    it("reads and writes the manifest's document paths", async () => {
        const root = fixture();
        const tools = createTools(root);
        const file = docFile("guide", readManifest(root).files);
        expect(file).toBe("files/md/guide.md");
        const original = await call(tools, "read_doc", { id: "guide" });
        expect(original).toMatchObject({
            isError: false,
            file,
            raw: readFileSync(join(root, file), "utf8"),
        });
        expect(
            (await call(tools, "write_doc", { id: "guide", content: `${original.raw}\nUpdated\n` }))
                .isError,
        ).toBe(false);
        expect((await call(tools, "read_doc", { id: "guide" })).raw).toBe(
            `${original.raw}\nUpdated\n`,
        );
        expect(await call(tools, "read_doc", { id: "missing" })).toMatchObject({
            isError: true,
            status: 404,
        });
    });

    it("rejects malformed requests and tool arguments before changing files", async () => {
        const root = fixture(false);
        const tools = createTools(root);
        for (const request of [null, [], {}, { jsonrpc: "1.0", id: 1, method: "ping" }])
            expect(await handleRpc(tools, request)).toMatchObject({ error: { code: -32600 } });
        expect(
            await handleRpc(tools, {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "toString" },
            }),
        ).toMatchObject({ error: { code: -32602 } });
        for (const [name, args] of [
            ["add_doc", { id: "bad" }],
            ["add_doc", { id: "bad", title: 123 }],
            ["add_doc", null],
            ["add_doc", []],
            ["write_doc", { id: "guide" }],
            ["move_doc", { id: "guide", index: -1 }],
            ["move_doc", { id: "guide", index: 0.5 }],
            ["delete_doc", { id: "guide", force: "false" }],
            ["build", { format: "html", url_preview: "static" }],
            ["build", { format: "zip", mode: "embed" }],
            ["check", { only: ["invalid"] }],
            ["update_files", { action: "move", revision: "x", paths: [42] }],
        ] as const)
            expect((await call(tools, name, args)).isError).toBe(true);
        expect((await call(tools, "list_docs")).docs).toHaveLength(1);
        expect(existsSync(join(root, "dist"))).toBe(false);
    });

    it("updates files and references without losing concurrent edits", async () => {
        const root = fixture(false);
        const tools = createTools(root);
        const original = await call(tools, "read_file", { file: "content/guide.md" });
        const content = `${original.content}\n![Notes](files/txt/notes.txt)\n`;
        expect(
            await call(tools, "write_file", {
                file: original.file,
                content,
                base: original.content,
            }),
        ).toMatchObject({ ok: true });
        expect(
            await call(tools, "write_file", {
                file: original.file,
                content: "stale",
                base: original.content,
            }),
        ).toMatchObject({ isError: true, status: 409 });
        const uploaded = await call(tools, "upload_file", {
            name: "notes.txt",
            data: Buffer.from("Notes").toString("base64"),
        });
        expect(uploaded.file).toBe("files/txt/notes.txt");
        expect(
            (
                await call(tools, "upload_file", {
                    name: "notes.txt",
                    data: Buffer.from("Other").toString("base64"),
                })
            ).file,
        ).not.toBe(uploaded.file);
        const snapshot = await call(tools, "list_files");
        const renamed = await call(tools, "update_files", {
            action: "rename",
            revision: snapshot.revision,
            file: uploaded.file,
            name: "renamed.txt",
        });
        expect(renamed.isError).toBe(false);
        expect((await call(tools, "read_file", { file: original.file })).content).toContain(
            "files/txt/renamed.txt",
        );
        expect(
            (
                await call(tools, "update_files", {
                    action: "rename",
                    revision: snapshot.revision,
                    file: "files/txt/renamed.txt",
                    name: "stale.txt",
                })
            ).isError,
        ).toBe(true);
        const moved = await call(tools, "update_files", {
            action: "move",
            revision: renamed.revision,
            paths: ["files/txt/renamed.txt"],
            directory: "notes",
        });
        expect(moved.isError).toBe(false);
        expect((await call(tools, "read_file", { file: original.file })).content).toContain(
            "notes/renamed.txt",
        );
        expect(
            await call(tools, "write_file", {
                file: "locales/jpn/content/guide.md",
                content: "Translated",
                base: null,
            }),
        ).toMatchObject({ ok: true });
        expect(
            (
                await call(tools, "write_file", {
                    file: original.file,
                    content: "replacement",
                    base: null,
                })
            ).isError,
        ).toBe(true);
        const manifest = await call(tools, "read_file", { file: "dooc.yaml" });
        expect(
            await call(tools, "write_file", {
                file: "dooc.yaml",
                content: manifest.content,
                base: manifest.content,
            }),
        ).toMatchObject({ ok: true });
    });

    it("rejects file traversal and symlinks into hidden files or outside the bundle", async () => {
        const root = fixture(false);
        const outside = fixture(false);
        mkdirSync(join(root, ".private"));
        writeFileSync(join(root, ".private/secret"), "secret");
        symlinkSync(join(root, ".private"), join(root, "hidden"));
        symlinkSync(outside, join(root, "external"));
        const tools = createTools(root);
        for (const file of [
            "../outside",
            "/tmp/outside",
            ".private/secret",
            "hidden/secret",
            "external/content/guide.md",
            "https://example.com/file.txt",
        ])
            for (const [name, args] of [
                ["read_file", { file }],
                ["write_file", { file, content: "bad", base: null }],
            ] as const)
                expect((await call(tools, name, args)).isError).toBe(true);
        expect(readFileSync(join(root, ".private/secret"), "utf8")).toBe("secret");
    });

    it("indexes Statics and manages project fonts", async () => {
        const root = fixture();
        const tools = createTools(root);
        const resources = await call(tools, "list_resources");
        expect(resources.terms.length).toBeGreaterThan(0);
        expect(resources.code.length).toBeGreaterThan(0);
        expect(resources.urls.length).toBeGreaterThan(0);
        const path = new URL("./viewer/fonts/udev-gothic-regular.woff2", import.meta.url).pathname;
        expect(await call(tools, "add_font", { path })).toMatchObject({
            file: ".dooc/fonts/udev-gothic-regular.woff2",
            isError: false,
        });
        expect((await call(tools, "add_font", { path })).isError).toBe(true);
        expect((await call(tools, "list_fonts")).fonts).toEqual(["udev-gothic-regular.woff2"]);
        expect(
            await call(tools, "delete_font", { name: "udev-gothic-regular.woff2" }),
        ).toMatchObject({ ok: true });
        expect((await call(tools, "list_fonts")).fonts).toEqual([]);
    });

    it("returns the full consistency report with selectable checks", async () => {
        const root = fixture(false);
        writeFileSync(
            join(root, "dooc.yaml"),
            "defaultLang: eng\nlanguages: [eng, jpn]\ndocs: [guide]\n",
        );
        const tools = createTools(root);
        const report = await call(tools, "check");
        expect(report).toMatchObject({
            schemaVersion: 1,
            checks: ["render", "languages", "themes"],
        });
        expect(report.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ code: "TRANSLATION_MISSING", language: "jpn" }),
            ]),
        );
        expect(await call(tools, "check", { only: ["render"] })).toMatchObject({
            checks: ["render"],
            exitCode: 0,
            errors: [],
        });
    });

    it.each([
        { format: "zip", url_preview: "network" },
        { format: "zip" },
        { format: "html", url_preview: "network" },
        { format: "html", url_preview: "embed" },
    ])("builds $format with $url_preview through the async tool", async (args) => {
        const root = fixture(false);
        const source = "---\ntitle: Guide\n---\n\n![Sample](https://example.com/sample.txt)\n";
        writeFileSync(join(root, "content/guide.md"), source);
        vi.mocked(fetchPublicFile).mockResolvedValue(Buffer.from("Captured text"));
        const tools = createTools(root);
        const result = await call(tools, "build", args);
        expect(result).toMatchObject({
            isError: false,
            docs: 1,
            file: `dist/bundle.${args.format}`,
            url_preview: args.url_preview ?? "embed",
        });
        const data = readFileSync(result.path);
        expect(result.bytes).toBe(data.length);
        expect(data.length).toBeGreaterThan(0);
        expect(fetchPublicFile).toHaveBeenCalledTimes(args.url_preview === "network" ? 0 : 1);
        expect(
            existsSync(join(root, `dist/bundle.${args.format === "zip" ? "html" : "zip"}`)),
        ).toBe(false);
        expect(readFileSync(join(root, "content/guide.md"), "utf8")).toBe(source);
        writeFileSync(join(root, "dooc.yaml"), "docs: [missing]\n");
        expect((await call(tools, "build", args)).isError).toBe(true);
        expect(readFileSync(result.path)).toEqual(data);
    });

    it("connects local Git and injected origin actions while enforcing freshness", async () => {
        const root = fixture(false);
        const git = (...args: string[]) =>
            execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
        git("init", "--initial-branch=main");
        git("config", "user.name", "Test");
        git("config", "user.email", "test@example.invalid");
        git("config", "commit.gpgsign", "false");
        git("config", "core.hooksPath", "/dev/null");
        git("add", ".");
        git("commit", "-m", "Initial");
        const pr: GitPullRequest = {
            number: 1,
            title: "Change",
            body: "Body",
            url: "https://example.com/pr/1",
            head: "other",
            base: "main",
            headCommit: git("rev-parse", "HEAD").trim(),
            draft: false,
            status: "OPEN",
        };
        const origin: GitOrigin = {
            name: "Injected",
            capabilities: ["fetch", "pull", "push", "createPr", "updatePr", "mergePr"],
            read: vi.fn().mockResolvedValue({
                url: "https://example.com/repo",
                defaultBranch: "main",
                pullRequests: [pr],
            }),
            execute: vi.fn().mockResolvedValue(undefined),
        };
        const tools = createTools(root, { gitOrigin: origin });
        const state = () => call(tools, "git", { action: "read" });
        const act = async (action: string, args = {}) =>
            call(tools, "git", { action, version: (await state()).version, ...args });
        const old = await state();
        writeFileSync(join(root, "note.txt"), "New");
        expect(
            (await call(tools, "git", { action: "stage", path: "note.txt", version: old.version }))
                .isError,
        ).toBe(true);
        expect(await act("diff", { path: "note.txt" })).toMatchObject({ diff: "New" });
        expect(await act("stage", { path: "note.txt" })).toMatchObject({ ok: true });
        expect(await act("unstage", { path: "note.txt" })).toMatchObject({ ok: true });
        expect(await act("stage", { path: "note.txt" })).toMatchObject({ ok: true });
        expect(await act("commit", { message: "Add note" })).toMatchObject({ ok: true });
        expect(await act("branch", { branch: "other" })).toMatchObject({ ok: true });
        writeFileSync(join(root, "note.txt"), "Draft");
        expect(await act("switch", { branch: "main", stash: true })).toMatchObject({ ok: true });
        expect((await state()).stash).toBeDefined();
        expect(await act("restoreStash")).toMatchObject({ ok: true });
        expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("Draft");
        expect(await act("stash")).toMatchObject({ ok: true });
        for (const action of ["fetch", "pull", "push"])
            expect(await act(action)).toMatchObject({ ok: true });
        expect(
            await act("createPr", { title: "Change", body: "Body", base: "main", draft: false }),
        ).toMatchObject({ ok: true });
        expect(
            (await act("mergePr", { number: 1, method: "squash", revision: "stale" })).isError,
        ).toBe(true);
        for (const action of ["updatePr", "mergePr"])
            expect(
                await act(action, {
                    number: 1,
                    title: "Updated",
                    body: "Updated body",
                    method: "squash",
                    revision: JSON.stringify(pr),
                }),
            ).toMatchObject({ ok: true });
        expect(origin.execute).toHaveBeenCalledTimes(6);
        expect(origin.execute).toHaveBeenLastCalledWith(
            expect.objectContaining({ root, branch: "main" }),
            expect.objectContaining({ action: "mergePr", previous: pr, method: "squash" }),
        );
        const disconnected = createTools(root);
        expect(
            (await call(disconnected, "git", { action: "push", version: (await state()).version }))
                .isError,
        ).toBe(true);
    }, 20_000);

    it("initialize / tools/list / notification", async () => {
        const tools = createTools(fixture());
        const init = (await handleRpc(tools, { jsonrpc: "2.0", id: 0, method: "initialize" })) as {
            result: { capabilities: object };
        };
        expect(init.result.capabilities).toEqual({ tools: {} });
        expect(init.result).toMatchObject({ serverInfo: { name: "dooc" } });
        const list = (await handleRpc(tools, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
            result: { tools: { name: string }[] };
        };
        expect(list.result.tools.map((t) => t.name)).toEqual(
            expect.arrayContaining([
                "write_doc",
                "build",
                "check",
                "git",
                "list_files",
                "read_file",
                "write_file",
                "upload_file",
                "update_files",
                "list_resources",
                "list_fonts",
                "add_font",
                "delete_font",
            ]),
        );
        expect(
            await handleRpc(tools, { jsonrpc: "2.0", method: "notifications/initialized" }),
        ).toBeUndefined();
    });

    it("doc create → write → move → rename → delete", async () => {
        const root = fixture();
        const tools = createTools(root);
        expect(
            (await call(tools, "add_doc", { id: "new", title: "New", parent: "guide" })).isError,
        ).toBe(false);
        expect((await call(tools, "add_doc", { id: "new", title: "dup" })).isError).toBe(true);
        expect((await call(tools, "add_doc", { id: "target", title: "Target" })).isError).toBe(
            false,
        );
        const targetFile = docFile("target", readManifest(root).files);
        const w = await call(tools, "write_doc", {
            id: "new",
            content: `---\ntitle: "New"\n---\n\nmcp-search-fixture [target](${targetFile})`,
        });
        expect(w.errors).toEqual([]);
        expect(await call(tools, "search_docs", { query: "mcp-search-fixture" })).toMatchObject({
            0: { id: "new" },
        });
        expect((await call(tools, "move_doc", { id: "new" })).isError).toBe(false);
        expect((await call(tools, "list_docs", {})).docs.at(-1)).toMatchObject({
            id: "new",
            depth: 0,
        });
        expect((await call(tools, "rename_doc", { id: "target", new_id: "b" })).updatedRefs).toBe(
            1,
        );
        expect(
            readFileSync(join(root, docFile("new", readManifest(root).files)), "utf8"),
        ).toContain(docFile("b", readManifest(root).files));
        const blocked = await call(tools, "delete_doc", { id: "b" });
        expect(blocked).toMatchObject({
            isError: true,
            referencedBy: ["new.md"],
        });
        expect((await call(tools, "delete_doc", { id: "b", force: true })).isError).toBe(false);
        expect(existsSync(join(root, targetFile))).toBe(false);
        expect((await call(tools, "check", {})).errors.length).toBeGreaterThan(0);
    });

    it("figure add → read → delete", async () => {
        const root = fixture();
        const tools = createTools(root);
        const svg =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><title>Fig.x</title></svg>';
        const added = await call(tools, "add_figure", { file: "X Fig.svg", text: svg });
        expect(added.file).toBe("x-fig.svg");
        expect((await call(tools, "add_figure", { file: "x-fig.svg", text: svg })).file).toBe(
            "x-fig.svg",
        );
        const path = added.path ?? `figures/${added.file}`;
        const { name } = (await call(tools, "list_docs", {})).figures.find(
            (figure: { file: string }) => figure.file === path,
        );
        expect((await call(tools, "read_figure", { name })).kind).toBe("svg");
        expect((await call(tools, "add_figure", { file: "y.svg" })).isError).toBe(true);
        expect((await call(tools, "delete_figure", { name })).isError).toBe(false);
        expect(existsSync(join(root, path))).toBe(false);
    });
});
