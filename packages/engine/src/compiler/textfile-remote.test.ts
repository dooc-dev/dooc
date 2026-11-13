import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { textfileResponse } from "../../../server/src/textfile.js";
import { blocksHtml } from "../core/html.js";
import { textfileName } from "../core/textfile.js";
import { compileSite } from "./compile.js";
import { collectRefs, parseDoc } from "./dialect.js";
import { type DownloadProgress, setDownloadProgressListener } from "./download-progress.js";
import { exportEntries } from "./export.js";
import { formatMarkdown } from "./format.js";
import { fetchPublicFile } from "./public-file.js";
import { readTextfile } from "./textfile.js";
import {
    readRemoteTextfile,
    readRemoteTextfileAsync,
    remoteTextfileSource,
} from "./textfile-remote.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("./public-file.js", () => ({ fetchPublicFile: vi.fn() }));
let root: string;
const rust = 'fn main() {\n    println!("hello");\n}\n';
let domains: string[];
const allow = (next: string[]) => {
    domains = next;
};

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "docs-textfile-https-"));
    mkdirSync(join(root, "content"));
    writeFileSync(join(root, "dooc.yaml"), "docs: [sample]\n");
    allow(["example.com"]);
    vi.mocked(execFileSync).mockReset().mockReturnValue(Buffer.from(rust));
    vi.mocked(fetchPublicFile).mockReset().mockResolvedValue(Buffer.from(rust));
});
afterEach(() => {
    setDownloadProgressListener();
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
});

it("reports one async download lifecycle while shared pending and cached reads stay quiet", async () => {
    const url = "https://example.com/progress-async.txt";
    const events: DownloadProgress[] = [];
    setDownloadProgressListener((event) => events.push(event));
    let finish!: (data: Buffer) => void;
    vi.mocked(fetchPublicFile).mockImplementation((_url, _validate, progress) => {
        progress?.(0, 5);
        progress?.(2, 5);
        return new Promise((resolve) => {
            finish = resolve;
        });
    });
    const first = readRemoteTextfileAsync(url, domains);
    const second = readRemoteTextfileAsync(url, domains);
    finish(Buffer.from("hello"));
    expect(await first).toEqual(Buffer.from("hello"));
    expect(await second).toEqual(Buffer.from("hello"));
    await readRemoteTextfileAsync(url, domains);
    expect(fetchPublicFile).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
        { url, state: "start", received: 0 },
        { url, state: "progress", received: 0, total: 5 },
        { url, state: "progress", received: 2, total: 5 },
        { url, state: "complete", received: 5, total: 5 },
    ]);
});

it.each([
    "NOT_FOUND",
    "BLOCKED",
])("reports async %s without changing the error", async (message) => {
    const url = `https://example.com/progress-error-${message}.txt`;
    const events: DownloadProgress[] = [];
    setDownloadProgressListener((event) => events.push(event));
    vi.mocked(fetchPublicFile).mockImplementation(async (_url, _validate, progress) => {
        progress?.(2);
        throw new Error(message);
    });
    await expect(readRemoteTextfileAsync(url, domains)).rejects.toThrow(
        message === "BLOCKED" ? "public network address" : "File not found",
    );
    expect(events).toEqual([
        { url, state: "start", received: 0 },
        { url, state: "progress", received: 2, total: undefined },
        { url, state: "error", received: 2, total: undefined },
    ]);
});

it("reports sync completion bytes and failures without invented streaming progress", () => {
    const url = "https://example.com/progress-sync.txt";
    const events: DownloadProgress[] = [];
    setDownloadProgressListener((event) => events.push(event));
    expect(readRemoteTextfile(url, domains)).toEqual(Buffer.from(rust));
    readRemoteTextfile(url, domains);
    vi.mocked(execFileSync).mockImplementation(() => {
        throw Object.assign(new Error("blocked"), { status: 45 });
    });
    expect(() => readRemoteTextfile(url, domains, true)).toThrow("public network address");
    expect(events).toEqual([
        { url, state: "start", received: 0 },
        { url, state: "complete", received: Buffer.byteLength(rust) },
        { url, state: "start", received: 0 },
        { url, state: "error", received: 0 },
    ]);
});

it("resolves GitHub file links without losing filenames", () => {
    expect(
        remoteTextfileSource("https://github.com/owner/repo/blob/main/src/hello.rs?raw=1#L2").url,
    ).toBe("https://raw.githubusercontent.com/owner/repo/main/src/hello.rs?raw=1");
    expect(textfileName("https://host/raw/hello%20world.rs?token=value#L2")).toBe("hello world.rs");
    for (const url of [
        "file:///etc/passwd",
        "ssh://host/repo.git#main:file",
        "https://user:password@host/file",
    ])
        expect(() => remoteTextfileSource(url)).toThrow();
});

it("checks permissions before consulting the shared cache, including after revocation", () => {
    const url = "https://example.com/revocable.rs";
    allow([]);
    expect(() => readTextfile(root, url, false, domains)).toThrow("Domain is not allowed");
    expect(execFileSync).not.toHaveBeenCalled();
    allow(["example.com"]);
    expect(readTextfile(root, url, false, domains)).toBe(rust);
    expect(readTextfile(root, url, false, domains)).toBe(rust);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    allow([]);
    expect(() => readTextfile(root, url, false, domains)).toThrow("Domain is not allowed");
    expect(execFileSync).toHaveBeenCalledTimes(1);
});

it("never lets document metadata or request data grant network access", async () => {
    const file = "https://example.com/self-authorized.rs";
    writeFileSync(
        join(root, "dooc.yaml"),
        "docs: [sample]\npreviews: { domains: [example.com] }\n",
    );
    writeFileSync(join(root, "content/sample.md"), `![](${file})\n`);
    expect(() => readTextfile(root, file)).toThrow("Domain is not allowed");
    expect(compileSite(root).errors.join()).toContain('unknown field "previews"');
    expect(
        (await textfileResponse(root, { action: "read", file, domains: ["example.com"] })).status,
    ).toBe(400);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(fetchPublicFile).not.toHaveBeenCalled();
});

it("validates both the user URL and the provider's resolved domain", () => {
    const url = "https://github.com/owner/repo/blob/main/file.rs";
    allow(["github.com"]);
    expect(() => readTextfile(root, url, false, domains)).toThrow("raw.githubusercontent.com");
    allow(["github.com", "raw.githubusercontent.com"]);
    expect(readTextfile(root, url, false, domains)).toBe(rust);
    expect(execFileSync).toHaveBeenCalledWith(
        process.execPath,
        expect.arrayContaining(["https://raw.githubusercontent.com/owner/repo/main/file.rs"]),
        expect.any(Object),
    );
});

it("rejects HTTP, credentials, ports and unregistered Git transport without invoking a process", () => {
    for (const url of [
        "http://example.com/a.rs",
        "https://user:secret@example.com/a.rs",
        "https://example.com:8443/a.rs",
        "https://example.com/repo.git#main:a.rs",
    ])
        expect(() => readTextfile(root, url, false, domains)).toThrow();
    expect(execFileSync).not.toHaveBeenCalled();
});

it("caches content, supports explicit refresh and never inherits credentials from the process", () => {
    const url = "https://example.com/version.txt";
    vi.mocked(execFileSync)
        .mockReturnValueOnce(Buffer.from("1"))
        .mockReturnValueOnce(Buffer.from("2"))
        .mockReturnValueOnce(Buffer.from("3"));
    expect(readTextfile(root, url, false, domains)).toBe("1");
    expect(readTextfile(root, url, false, domains)).toBe("1");
    expect(readTextfile(root, url, true, domains)).toBe("2");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60001);
    expect(readTextfile(root, url, false, domains)).toBe("3");
    expect(execFileSync).toHaveBeenCalledWith(
        process.execPath,
        expect.any(Array),
        expect.objectContaining({
            env: { PATH: process.env.PATH },
            timeout: 12000,
            maxBuffer: 2 * 1024 * 1024,
        }),
    );
});

it("keeps missing/unreachable results distinct and surfaces private-address failures", () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
        throw { status: 44 };
    });
    expect(() => readTextfile(root, "https://example.com/missing.rs", false, domains)).toThrow(
        "File not found",
    );
    vi.mocked(execFileSync).mockImplementationOnce(() => {
        throw { status: 1 };
    });
    expect(() => readTextfile(root, "https://example.com/offline.rs", false, domains)).toThrow(
        "File could not be loaded",
    );
    vi.mocked(execFileSync).mockImplementationOnce(() => {
        throw { status: 45 };
    });
    expect(() => readTextfile(root, "https://example.com/private.rs", false, domains)).toThrow(
        "public network address",
    );
    vi.mocked(execFileSync).mockReturnValueOnce(Buffer.from([0xff]));
    expect(() => readTextfile(root, "https://example.com/binary.rs", false, domains)).toThrow();
});

it("keeps external embeds as URLs without fetching or baking private service data into exports", () => {
    const url = "https://example.com/export.rs?x=1&y=2#L2";
    const body = `![](${url})\n`;
    writeFileSync(join(root, "content/sample.md"), body);
    expect(collectRefs(parseDoc(formatMarkdown(body)).root).textfiles).toEqual([]);
    const compiled = compileSite(root, { previews: { domains } });
    expect(compiled.errors).toEqual([]);
    expect(compiled.docs[0]?.blocks).toEqual([{ type: "external", url }]);
    const html = blocksHtml(compiled.docs[0]?.blocks ?? []);
    expect(html).toContain('data-embed-url="https://example.com/export.rs?x=1&amp;y=2#L2"');
    expect(html).toContain('href="https://example.com/export.rs?x=1&amp;y=2#L2"');
    expect(execFileSync).not.toHaveBeenCalled();
    expect(fetchPublicFile).not.toHaveBeenCalled();
    expect(exportEntries(root).map((entry) => entry.name)).toEqual([
        "dooc.yaml",
        "content/sample.md",
    ]);
});

it("enforces the same policy in the editor and keeps remote content read-only", async () => {
    const file = "https://example.com/editor.rs";
    expect((await textfileResponse(root, { action: "read", file }, domains)).body.content).toBe(
        rust,
    );
    allow([]);
    expect((await textfileResponse(root, { action: "read", file }, domains)).status).toBe(400);
    expect(
        await textfileResponse(
            root,
            { action: "save", file, content: "overwrite", base: rust },
            domains,
        ),
    ).toEqual({ status: 400, body: { error: "Remote files are read-only" } });
});

it("shares an asynchronous reload and lets the compiler reuse the completed download", async () => {
    const file = "https://example.com/slow-reload.rs";
    let finish!: (data: Buffer) => void;
    vi.mocked(fetchPublicFile).mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    const first = textfileResponse(root, { action: "read", file }, domains);
    const second = textfileResponse(root, { action: "read", file }, domains);
    expect(fetchPublicFile).toHaveBeenCalledTimes(1);
    expect(execFileSync).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    finish(Buffer.from(rust));
    expect((await first).body.content).toBe(rust);
    expect((await second).body.content).toBe(rust);
    expect(readTextfile(root, file, false, domains)).toBe(rust);
    expect(execFileSync).not.toHaveBeenCalled();
});

it("preserves missing-file and blocked-address handling during asynchronous reloads", async () => {
    vi.mocked(fetchPublicFile).mockRejectedValueOnce(new Error("NOT_FOUND"));
    expect(
        await textfileResponse(
            root,
            {
                action: "read",
                file: "https://example.com/async-missing.rs",
            },
            domains,
        ),
    ).toEqual({ status: 200, body: { content: null } });
    vi.mocked(fetchPublicFile).mockRejectedValueOnce(new Error("BLOCKED"));
    expect(
        (
            await textfileResponse(
                root,
                {
                    action: "read",
                    file: "https://example.com/async-blocked.rs",
                },
                domains,
            )
        ).body.error,
    ).toContain("public network address");
});
