import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { classifyChange, watchProject } from "./hmr.js";

const assets = vi.hoisted(() => ({ prebuilt: false }));
vi.mock("./assets.js", () => assets);
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return { ...actual, watch: vi.fn(actual.watch) };
});

describe("classifyChange", () => {
    it("content bodies / manifest and figures count as content", () => {
        expect(classifyChange("content/setup.md")).toBe("content");
        expect(classifyChange("dooc.yaml")).toBe("content");
        expect(classifyChange("team.dooc.yaml")).toBe("content");
        expect(classifyChange("locales/eng/content/setup.md")).toBe("content");
        expect(classifyChange("figures/shot.png")).toBe("content");
        expect(classifyChange("figures/system-overview.svg")).toBe("content");
        expect(classifyChange("figures/anim.html")).toBe("content");
    });

    it("the edit client bundle (edit-client.ts) and *.tsx (schema graph bundle sources) count as client (re-fetching the bundle needs a reload)", () => {
        expect(classifyChange("packages/frontend/src/edit-client.ts")).toBe("client");
        expect(classifyChange("packages/frontend/src/nav-focus.ts")).toBe("client");
        expect(classifyChange("packages/frontend/src/nav-update.ts")).toBe("client");
        expect(classifyChange("packages/frontend/src/language-picker.ts")).toBe("client");
        expect(classifyChange("packages/frontend/src/edit-schema-completion.ts")).toBe("client");
        expect(classifyChange("packages/frontend/src/edit-git-diff.ts")).toBe("client");
        expect(classifyChange("packages/frontend/src/preview-update.ts")).toBe("client");
        expect(classifyChange("packages/frontend/src/plugin-resize.ts")).toBe("client");
        expect(classifyChange("packages/frontend/src/code-worker.ts")).toBe("client");
        expect(classifyChange("packages/frontend/src/subformats-ui.ts")).toBe("client");
        expect(classifyChange("packages/frontend/src/schema-graph-global.tsx")).toBe("client");
        expect(classifyChange("packages/frontend/src/schema-graph-flow.tsx")).toBe("client");
        expect(classifyChange("packages/frontend/src/schema-graph-mount.tsx")).toBe("client");
    });

    it("ignores server sources (picked up by tsx watch restarting) and out-of-scope files", () => {
        // src/*.ts is imported = tsx watch restarts → the client picks it up via the bootId diff.
        expect(classifyChange("packages/server/src/serve.ts")).toBeUndefined();
        expect(classifyChange("packages/engine/src/core/html.ts")).toBeUndefined();
        expect(classifyChange("packages/engine/src/core/schema-graph.ts")).toBeUndefined();
        // Editor temp files / generated output.
        expect(classifyChange("content/guide/setup.md.swp")).toBeUndefined();
        expect(classifyChange("dist/index.js")).toBeUndefined();
    });

    it("resolves Windows separators too", () => {
        expect(classifyChange("content\\guide\\setup.md")).toBe("content");
    });
});

describe("watchProject", () => {
    it("refreshes the workspace when a branch changes outside the document root", async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-hmr-branch-"));
        const docs = join(root, "docs");
        mkdirSync(docs);
        mkdirSync(join(root, ".git"));
        const head = join(root, ".git/HEAD");
        writeFileSync(head, "ref: refs/heads/main\n");
        const seen: string[] = [];
        const watcher = watchProject(docs, docs, (_kind, files) => seen.push(...files), 10);
        try {
            writeFileSync(`${head}.lock`, "ref: refs/heads/docs/update\n");
            renameSync(`${head}.lock`, head);
            await expect.poll(() => seen, { timeout: 2000 }).toContain(".git/HEAD");
            seen.length = 0;
            mkdirSync(join(root, ".git/refs/heads"), { recursive: true });
            writeFileSync(join(root, ".git/refs/heads/main"), `${"a".repeat(40)}\n`);
            await expect.poll(() => seen, { timeout: 2000 }).toContain(".git/HEAD");
        } finally {
            watcher.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it.each([
        true,
        false,
    ])("watches application sources only in development (prebuilt=%s)", (prebuilt) => {
        const root = mkdtempSync(join(tmpdir(), "dooc-watch-mode-"));
        mkdirSync(join(root, "packages"));
        assets.prebuilt = prebuilt;
        const watch = vi.mocked(fs.watch);
        watch.mockClear();
        const watcher = watchProject(root, root, () => {});
        try {
            const paths = watch.mock.calls.map(([path]) => path);
            expect(paths).toContain(root);
            expect(paths.includes(join(root, "packages"))).toBe(!prebuilt);
        } finally {
            watcher.close();
            assets.prebuilt = false;
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("watches referenced files through edits, atomic replacement, deletion and creation", async () => {
        const root = mkdtempSync(join(tmpdir(), "docs-hmr-files-"));
        mkdirSync(join(root, "examples"));
        const path = join(root, "examples/hello.rs");
        const seen: string[] = [];
        const watcher = watchProject(root, root, (_kind, files) => seen.push(...files), 10);
        watcher.watchTextfiles(["examples/hello.rs", "../outside", "https://example.com/x"]);
        const changed = async (change: () => void) => {
            seen.length = 0;
            change();
            await expect.poll(() => seen, { timeout: 2000 }).toContain("examples/hello.rs");
        };
        try {
            // The initial missing-file notification confirms the stat watcher is ready.
            await expect.poll(() => seen, { timeout: 2000 }).toContain("examples/hello.rs");
            await changed(() => writeFileSync(path, "old"));
            await changed(() => writeFileSync(path, "edited"));
            await changed(() => {
                writeFileSync(`${path}.tmp`, "replaced");
                renameSync(`${path}.tmp`, path);
            });
            await changed(() => rmSync(path));
            await changed(() => writeFileSync(path, "created"));
        } finally {
            watcher.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refreshes Files when a parent repository's ignore rules change", async () => {
        const root = mkdtempSync(join(tmpdir(), "docs-ignore-hmr-"));
        mkdirSync(join(root, ".git"));
        mkdirSync(join(root, "docs"));
        writeFileSync(join(root, ".git/HEAD"), "ref: refs/heads/main\n");
        writeFileSync(join(root, ".gitignore"), "");
        const seen: string[] = [];
        const watcher = watchProject(
            join(root, "docs"),
            root,
            (_kind, files) => seen.push(...files),
            20,
        );
        try {
            const ignore = join(root, ".gitignore");
            const changed = async (change: () => void) => {
                seen.length = 0;
                change();
                await expect.poll(() => seen, { timeout: 2000 }).toContain(".gitignore");
            };
            await changed(() => writeFileSync(ignore, "docs/private.txt\n"));
            await changed(() => {
                writeFileSync(`${ignore}.tmp`, "docs/hidden.txt\n");
                renameSync(`${ignore}.tmp`, ignore);
            });
            await changed(() => rmSync(ignore));
            await changed(() => writeFileSync(ignore, "docs/private.txt\n"));
        } finally {
            watcher.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("notifies batched per kind (out-of-scope files are not notified)", async () => {
        const root = mkdtempSync(join(tmpdir(), "docs-hmr-"));
        for (const dir of ["content/dev", "figures", "src"]) {
            mkdirSync(join(root, dir), { recursive: true });
        }
        const seen: { kind: string; files: string[] }[] = [];
        const stop = watchProject(root, root, (kind, files) => seen.push({ kind, files }), 20);
        try {
            writeFileSync(join(root, "content/dev/10-a.md"), "");
            writeFileSync(join(root, "figures/x.svg"), "<svg/>");
            writeFileSync(join(root, ".gitignore"), "cache/\n");
            writeFileSync(join(root, "figures/.gitignore"), "generated.svg\n");
            writeFileSync(join(root, "src/serve.ts"), "// ignored");
            writeFileSync(join(root, "manifest.tmp"), "- a\n");
            renameSync(join(root, "manifest.tmp"), join(root, "dooc.yaml"));
            writeFileSync(join(root, "manifest.tmp"), "docs: []\n");
            renameSync(join(root, "manifest.tmp"), join(root, "team.dooc.yaml"));
            await new Promise((r) => setTimeout(r, 400));
            const content = seen.filter((e) => e.kind === "content").flatMap((e) => e.files);
            expect(new Set(content)).toEqual(
                new Set([
                    "content/dev/10-a.md",
                    "figures/x.svg",
                    "dooc.yaml",
                    "team.dooc.yaml",
                    ".gitignore",
                    "figures/.gitignore",
                ]),
            );
            expect(seen.some((e) => e.files.some((f) => f.endsWith("serve.ts")))).toBe(false);
        } finally {
            stop.close();
            rmSync(root, { recursive: true, force: true });
        }
    });
});
