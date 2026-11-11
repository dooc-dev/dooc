import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
    createServer,
    type IncomingMessage,
    type RequestListener,
    type Server,
    type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { fetchPublicFile } from "../compiler/public-file.js";
import { createHmrHub } from "./hmr.js";

vi.mock("node:http", async (original) => ({
    ...(await original<typeof import("node:http")>()),
    createServer: vi.fn(),
}));
vi.mock("node:child_process", async (original) => ({
    ...(await original<typeof import("node:child_process")>()),
    execFileSync: vi.fn(),
}));
vi.mock("../compiler/public-file.js", () => ({ fetchPublicFile: vi.fn() }));
vi.mock("./hmr.js", async (original) => ({
    ...(await original<typeof import("./hmr.js")>()),
    createHmrHub: vi.fn(() => ({ broadcast: vi.fn(), handle: vi.fn() })),
}));

let root: string;
afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    if (root) rmSync(root, { recursive: true, force: true });
});

it("injects and replaces network policy at runtime without editor controls or persistent settings", async () => {
    root = mkdtempSync(join(tmpdir(), "dooc-viewer-runtime-"));
    mkdirSync(join(root, "content"));
    writeFileSync(join(root, "dooc.yaml"), "docs: [guide]\n");
    const file = "https://example.com/runtime-policy.txt";
    writeFileSync(
        join(root, "content/guide.md"),
        "---\ntitle: Guide\n---\n\nRuntime policy fixture.\n",
    );
    const oldSettings = join(root, "allowed-domains.json");
    writeFileSync(oldSettings, JSON.stringify({ domains: ["old.example.com"] }));
    const module = join(root, "viewer.mjs");
    writeFileSync(
        module,
        `export default {
        plugins: [], allowedDomains: ["initial.example.com"],
        setup(viewer) { viewer.setAllowedDomains(["setup.example.com"]); },
    };`,
    );
    vi.stubEnv("DOCS_ROOT", root);
    vi.stubEnv("DOCS_HMR", "0");
    vi.stubEnv("DOOC_ALLOWED_DOMAINS_FILE", oldSettings);
    vi.mocked(execFileSync).mockReturnValue(Buffer.from("Runtime sample content"));
    vi.mocked(fetchPublicFile).mockResolvedValue(Buffer.from("Runtime sample content"));
    let listener: RequestListener;
    vi.mocked(createServer).mockImplementation((...args) => {
        listener = args.at(-1) as RequestListener;
        return Object.assign(new EventEmitter(), { listen: vi.fn() }) as unknown as Server;
    });
    const { startServer } = await import("./serve.js");
    const viewer = await startServer("edit", 5179, module);
    const call = (
        path: string,
        input?: unknown,
        origin = "http://localhost:5179",
    ): Promise<{ status: number; body: string }> =>
        new Promise((resolve) => {
            const request = Object.assign(new PassThrough(), {
                url: path,
                method: input === undefined ? "GET" : "POST",
                headers: {
                    host: "localhost:5179",
                    origin,
                    "content-type": "application/json",
                },
                socket: { localPort: 5179 },
            });
            let status = 0;
            const response = {
                setHeader() {},
                writeHead(code: number) {
                    status = code;
                },
                end(body = "") {
                    resolve({ status, body });
                },
            };
            listener(request as unknown as IncomingMessage, response as unknown as ServerResponse);
            request.end(JSON.stringify(input ?? {}));
        });
    const page = async () => JSON.parse((await call("/api/page?route=/guide")).body);
    expect((await call("/api/files", { action: "complete", prefix: "content/" })).body).toBe(
        JSON.stringify(["content/guide.md"]),
    );
    expect((await call("/api/files", { action: "complete", prefix: "../" })).status).toBe(409);
    expect(
        (await call("/api/subformat", { file: "one.issue" }, "https://outside.example")).status,
    ).toBe(403);
    expect(
        (await call("/api/files", { action: "complete", prefix: "" }, "https://outside.example"))
            .status,
    ).toBe(403);
    expect(
        (
            await call(
                "/api/site-title",
                { title: "Project", baseTitle: null },
                "https://outside.example",
            )
        ).status,
    ).toBe(403);
    expect(await call("/api/site-title", { title: "Project", baseTitle: null })).toMatchObject({
        status: 200,
    });
    expect(JSON.parse((await call("/api/nav")).body).siteTitle).toBe("Project");
    expect((await call("/api/site-title", { title: "Stale", baseTitle: null })).status).toBe(409);

    expect((await call("/api/git", { action: "push" }, "https://outside.example")).status).toBe(
        403,
    );
    expect((await call("/api/git", { action: "read" })).status).toBe(409);
    expect((await call("/api/git")).status).toBe(404);
    viewer.setGitOrigin({ name: "External", capabilities: [], read: vi.fn(), execute: vi.fn() });
    expect(() => viewer.setGitOrigin({} as never)).toThrow("Git origin");
    viewer.setGitOrigin(undefined);
    const read = () => call("/api/textfile", { action: "read", file });
    expect((await page()).boot.previews.domains).toEqual(["setup.example.com"]);
    expect((await read()).status).toBe(400);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(fetchPublicFile).not.toHaveBeenCalled();
    const html = await call("/guide");
    expect(html.status).toBe(200);
    expect(html.body).not.toContain("allowed-domains-open");
    expect(
        (
            await call("/api/allowed-domains", {
                action: "save",
                settings: { domains: ["example.com"] },
            })
        ).status,
    ).toBe(404);

    const domains = [" EXAMPLE.COM "];
    viewer.setAllowedDomains(domains);
    domains.push("unvalidated.example.com");
    const allowed = await page();
    expect(allowed.boot.previews.domains).toEqual(["example.com"]);
    expect(allowed.errors).toEqual([]);
    const result = await read();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).content).toBe("Runtime sample content");
    for (const invalid of [["*"], ["localhost"], ["example.com", "EXAMPLE.COM"], undefined]) {
        expect(() => viewer.setAllowedDomains(invalid as string[])).toThrow();
    }
    expect((await page()).boot.previews.domains).toEqual(["example.com"]);
    expect(vi.mocked(createHmrHub).mock.results[0]?.value.broadcast).toHaveBeenLastCalledWith(
        "content",
        [],
    );

    viewer.setAllowedDomains([]);
    const revoked = await page();
    expect(revoked.boot.previews.domains).toEqual([]);
    const denied = await read();
    expect(denied.status).toBe(400);
    expect(denied.body).toContain("Domain is not allowed");
    expect(fetchPublicFile).toHaveBeenCalledTimes(1);
    viewer.setWorkspace({
        protocol: "storage",
        folder: "host/documents",
        service: "Injected storage",
    });
    const storage = await call("/_files");
    expect(storage.body).toContain("host/documents");
    expect(storage.body).toContain("Injected storage");
    expect(storage.body).toContain('id="nav-statics"');
    const subformats = await call("/_subformats");
    expect(subformats.status).toBe(200);
    expect(subformats.body).toContain('id="nav-subformats"');
    expect(
        subformats.body.match(/class="nav-link cur" href="\/_subformats(?:\?|")/),
    ).not.toBeNull();
    expect(subformats.body).toContain("No subformats configured. Add subformats to dooc.yaml.");
    expect(() => viewer.setWorkspace({ protocol: "storage" } as never)).toThrow("Workspace");
    viewer.setWorkspace({ protocol: "git", repo: "Injected repository", branch: "host/topic" });
    expect((await call("/guide")).body).toContain("Injected repository");
    viewer.setWorkspace(undefined);
    expect((await call("/guide")).body).not.toContain("Injected repository");

    mkdirSync(join(root, "figures"));
    const payload = "Large figure data".repeat(10_000);
    writeFileSync(
        join(root, "figures/large.svg"),
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><!--${payload}--><rect width="20" height="20"/></svg>`,
    );
    writeFileSync(join(root, "content/guide.md"), "# Guide\n\n![](figures/large.svg)\n");
    const deferred = await call("/guide");
    expect(deferred.body).toContain("data-figure-preview=");
    expect(deferred.body).not.toContain(payload);
    expect(deferred.body).toContain('data-src="/assets/code-grammars.json"');
    expect(JSON.parse((await call("/assets/code-grammars.json")).body)).toBeInstanceOf(Array);
    expect(
        JSON.parse((await call("/assets/code-grammars.json?language=js")).body).map(
            (grammar: { name: string }) => grammar.name,
        ),
    ).toEqual(["javascript"]);
    expect(
        JSON.parse((await call("/assets/code-grammars.json?language=termth")).body).map(
            (grammar: { name: string }) => grammar.name,
        ),
    ).toEqual(["termth", "yaml"]);
    expect(JSON.parse((await call("/assets/code-grammars.json?language=unknown")).body)).toEqual(
        [],
    );
    const preview = await call("/api/figure-preview?file=figures%2Flarge.svg");
    expect(preview.status).toBe(200);
    expect(preview.body).toContain('sandbox=""');
    expect(preview.body).toContain(payload);
    expect((await call("/api/figure-preview?file=../private.svg")).status).toBe(404);
    writeFileSync(join(root, ".gitignore"), "figures/large.svg\n");
    expect((await call("/api/figure-preview?file=figures%2Flarge.svg")).status).toBe(404);
});
