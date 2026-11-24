import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as compiler from "../../engine/src/compiler/compile.js";
import { git } from "./git.js";
import { nodeWorkspaceOperations } from "./workspace-server.js";

const roots: string[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-workspace-ux-"));
    roots.push(root);
    mkdirSync(join(root, "content"));
    writeFileSync(
        join(root, "dooc.yaml"),
        "document:\n  title: Handbook\n  url: content/home.md\n  children:\n    - document: { title: Guide, url: content/guide.md }\n    - document: { title: Website, url: 'https://example.com/' }\n",
    );
    writeFileSync(join(root, "content/home.md"), "Home.\n");
    writeFileSync(join(root, "content/guide.md"), "Guide.\n");
    return root;
};
const get = (url: string) => ({ url, method: "GET", headers: {}, body: "" });

it("builds navigation from manifest metadata without compiling changed document bodies", async () => {
    const root = fixture();
    const create = compiler.createCompiler;
    const compile = vi.fn();
    vi.spyOn(compiler, "createCompiler").mockImplementation((...args) => {
        const actual = create(...args);
        return {
            compile: () => {
                compile();
                return actual.compile();
            },
        };
    });
    const manager = await nodeWorkspaceOperations(join(root, "dooc.yaml"));
    try {
        for (const paragraphs of [1, 1000]) {
            writeFileSync(
                join(root, "content/guide.md"),
                "Changed **paragraph**.\n\n".repeat(paragraphs),
            );
            const response = (await manager.ops.http?.(get("/api/nav"), { local: true })) as {
                status: number;
                body: string;
            };
            expect(response.status).toBe(200);
            const data = JSON.parse(response.body);
            expect(data.siteTitle).toBe("Handbook");
            expect(data.html).toContain('href="/guide?');
            expect(data.html).toContain('data-jump-url="https://example.com/"');
            expect(data.html).toContain("Guide");
        }
        expect(compile).not.toHaveBeenCalled();
        await manager.ops.http?.(get("/api/page?route=/guide"), { local: true });
        expect(compile).toHaveBeenCalled();
    } finally {
        manager.close();
    }
});

it("lets navigation pass a remote Git read, keeps writes ordered and skips canceled queued reads", async () => {
    const root = fixture();
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Test"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Fixture"]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const read = vi.fn(async () => {
        await gate;
        return { url: "", defaultBranch: "main", pullRequests: [] };
    });
    vi.stubGlobal("__doocUxOriginRead", read);
    const config = join(root, "reader.mjs");
    writeFileSync(
        config,
        "export default { plugins: [], gitOrigin: { name: 'Test origin', capabilities: [], read: () => globalThis.__doocUxOriginRead(), async execute() {} } };\n",
    );
    const manager = await nodeWorkspaceOperations(join(root, "dooc.yaml"), config);
    const session = { local: true };
    try {
        const remote = manager.ops.git?.({ action: "read" }, session);
        await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
        let response: { status: number } | undefined;
        const navigation = Promise.resolve(manager.ops.http?.(get("/api/nav"), session)).then(
            (value) => {
                response = value as { status: number };
            },
        );
        await vi.waitFor(() => expect(response?.status).toBe(200));
        await navigation;
        let written = false;
        const write = Promise.resolve(
            manager.ops.files?.({ action: "upload", name: "after.txt", data: "YWZ0ZXI=" }, session),
        ).then((value) => {
            written = true;
            return value as { file: string };
        });
        const controller = new AbortController();
        const canceled = Promise.resolve(
            manager.ops.http?.(get("/api/page?route=/guide"), session, controller.signal),
        );
        const rejection = expect(canceled).rejects.toMatchObject({ name: "AbortError" });
        controller.abort();
        await Promise.resolve();
        expect(written).toBe(false);
        release();
        await remote;
        const uploaded = await write;
        await rejection;
        expect(readFileSync(join(root, uploaded.file), "utf8")).toBe("after");
    } finally {
        release();
        manager.close();
    }
});
