import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyChange, createHmrHub, hmrClientScript, sseFrame, watchProject } from "./hmr.js";

describe("classifyChange", () => {
    it("content bodies / manifest and figures count as content", () => {
        expect(classifyChange("content/setup.md")).toBe("content");
        expect(classifyChange("manifest.yaml")).toBe("content");
        expect(classifyChange("figures/shot.png")).toBe("content");
        expect(classifyChange("figures/system-overview.svg")).toBe("content");
        expect(classifyChange("figures/anim.html")).toBe("content");
    });

    it("the edit client bundle (edit-client.ts) and *.tsx (schema graph bundle sources) count as client (re-fetching the bundle needs a reload)", () => {
        expect(classifyChange("src/viewer/edit-client.ts")).toBe("client");
        expect(classifyChange("src/viewer/edit-schema-completion.ts")).toBe("client");
        expect(classifyChange("src/core/schema-graph-global.tsx")).toBe("client");
        expect(classifyChange("src/core/schema-graph-flow.tsx")).toBe("client");
        expect(classifyChange("src/core/schema-graph-mount.tsx")).toBe("client");
    });

    it("ignores server sources (picked up by tsx watch restarting) and out-of-scope files", () => {
        // src/*.ts is imported = tsx watch restarts → the client picks it up via the bootId diff.
        expect(classifyChange("src/viewer/serve.ts")).toBeUndefined();
        expect(classifyChange("src/core/html.ts")).toBeUndefined();
        expect(classifyChange("src/core/schema-graph.ts")).toBeUndefined();
        // Editor temp files / generated output.
        expect(classifyChange("content/guide/setup.md.swp")).toBeUndefined();
        expect(classifyChange("artifact/docs.json")).toBeUndefined();
        expect(classifyChange("dist/index.js")).toBeUndefined();
    });

    it("resolves Windows separators too", () => {
        expect(classifyChange("content\\guide\\setup.md")).toBe("content");
    });
});

describe("sseFrame", () => {
    it("the event/data lines read by EventSource + a blank line", () => {
        expect(sseFrame("change", { kind: "content", files: ["content/dev/10-a.md"] })).toBe(
            'event: change\ndata: {"kind":"content","files":["content/dev/10-a.md"]}\n\n',
        );
    });
});

describe("createHmrHub", () => {
    const fakeRes = (): {
        written: string[];
        res: Parameters<ReturnType<typeof createHmrHub>["handle"]>[0];
    } => {
        const written: string[] = [];
        const res = {
            writeHead: () => res,
            write: (chunk: string) => {
                written.push(chunk);
                return true;
            },
            on: () => res,
        };
        return {
            written,
            res: res as unknown as Parameters<ReturnType<typeof createHmrHub>["handle"]>[0],
        };
    };

    it("sends bootId on connect and pushes later broadcasts to all clients", () => {
        const hub = createHmrHub("boot-1");
        const a = fakeRes();
        const b = fakeRes();
        hub.handle(a.res);
        hub.handle(b.res);
        expect(a.written).toEqual([
            "retry: 300\n\n",
            'event: hello\ndata: {"bootId":"boot-1"}\n\n',
        ]);
        hub.broadcast("content", ["content/dev/10-a.md"]);
        const frame = 'event: change\ndata: {"kind":"content","files":["content/dev/10-a.md"]}\n\n';
        expect(a.written.at(-1)).toBe(frame);
        expect(b.written.at(-1)).toBe(frame);
    });
});

describe("hmrClientScript", () => {
    it("edit: content delegates to onContent (registered by edit-client.ts) instead of reloading", () => {
        const script = hmrClientScript("edit");
        // In the "change" handler, the kind === "content" branch ends with the onContent call and
        // doesn't call reload right after (falls back to reload only when unregistered).
        expect(script).toContain("__docsHmr.onContent");
        expect(script).toContain("if (onContent) { onContent(files); return; }");
        // window.__docsHmr is merged (Object.assign) rather than overwritten, so that
        // edit-client.ts can register onContent first.
        expect(script).toContain("Object.assign(window.__docsHmr || {}");
    });

    it("edit: client bundle (edit-client.ts / *.tsx) changes and a hello bootId mismatch still reload", () => {
        const script = hmrClientScript("edit");
        expect(script).toContain("if (id !== bootId) reload();");
        // The kind !== "content" (= "client") branch (end of the change handler) stays reload().
        expect(script.endsWith("reload();\n  });\n})();")).toBe(true);
    });

    it("preview: content swaps the main view + nav via swap() (the MODE branch returns before the onContent branch)", () => {
        const script = hmrClientScript("preview");
        expect(script).toContain(
            'if (MODE === "preview") { if (kind === "content") void swap(); return; }',
        );
        expect(script).toContain('const MODE = "preview";');
    });
});

describe("watchProject", () => {
    it("notifies batched per kind (out-of-scope files are not notified)", async () => {
        const root = mkdtempSync(join(tmpdir(), "docs-hmr-"));
        for (const dir of ["content/dev", "figures", "src"]) {
            mkdirSync(join(root, dir), { recursive: true });
        }
        const seen: { kind: string; files: string[] }[] = [];
        const stop = watchProject(root, root, (kind, files) => seen.push({ kind, files }), 20);
        try {
            writeFileSync(join(root, "content/dev/10-a.md"), '---\ntitle: "a"\n---\n');
            writeFileSync(join(root, "figures/x.svg"), "<svg/>");
            writeFileSync(join(root, "src/serve.ts"), "// ignored");
            writeFileSync(join(root, "manifest.tmp"), "- a\n");
            renameSync(join(root, "manifest.tmp"), join(root, "manifest.yaml"));
            await new Promise((r) => setTimeout(r, 400));
            const content = seen.filter((e) => e.kind === "content").flatMap((e) => e.files);
            expect(new Set(content)).toEqual(
                new Set(["content/dev/10-a.md", "figures/x.svg", "manifest.yaml"]),
            );
            expect(seen.some((e) => e.files.some((f) => f.endsWith("serve.ts")))).toBe(false);
        } finally {
            stop();
            rmSync(root, { recursive: true, force: true });
        }
    });
});
