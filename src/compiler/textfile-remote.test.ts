import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { blocksHtml } from "../core/html.js";
import { textfileName } from "../core/textfile.js";
import { textfileResponse } from "../viewer/textfile.js";
import { compileSite } from "./compile.js";
import { collectRefs, parseDoc } from "./dialect.js";
import { exportEntries } from "./export.js";
import { formatMarkdown } from "./format.js";
import { fetchPublicFile } from "./public-file.js";
import { readTextfile } from "./textfile.js";
import { remoteTextfileSource } from "./textfile-remote.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("./public-file.js", () => ({ fetchPublicFile: vi.fn() }));
let root: string;
const rust = 'fn main() {\n    println!("hello");\n}\n';
const manifest = (domains: string[]) =>
    writeFileSync(
        join(root, "dooc.yaml"),
        `docs: [sample]\npreviews:\n  domains: ${JSON.stringify(domains)}\n`,
    );

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "docs-textfile-https-"));
    mkdirSync(join(root, "content"));
    manifest(["example.com"]);
    vi.mocked(execFileSync).mockReset().mockReturnValue(Buffer.from(rust));
    vi.mocked(fetchPublicFile).mockReset().mockResolvedValue(Buffer.from(rust));
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
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
    manifest([]);
    expect(() => readTextfile(root, url)).toThrow("Domain is not allowed");
    expect(execFileSync).not.toHaveBeenCalled();
    manifest(["example.com"]);
    expect(readTextfile(root, url)).toBe(rust);
    expect(readTextfile(root, url)).toBe(rust);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    manifest([]);
    expect(() => readTextfile(root, url)).toThrow("Domain is not allowed");
    expect(execFileSync).toHaveBeenCalledTimes(1);
});

it("validates both the user URL and the provider's resolved domain", () => {
    const url = "https://github.com/owner/repo/blob/main/file.rs";
    manifest(["github.com"]);
    expect(() => readTextfile(root, url)).toThrow("raw.githubusercontent.com");
    manifest(["github.com", "raw.githubusercontent.com"]);
    expect(readTextfile(root, url)).toBe(rust);
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
        expect(() => readTextfile(root, url)).toThrow();
    expect(execFileSync).not.toHaveBeenCalled();
});

it("caches content, supports explicit refresh and never inherits credentials from the process", () => {
    const url = "https://example.com/version.txt";
    vi.mocked(execFileSync)
        .mockReturnValueOnce(Buffer.from("1"))
        .mockReturnValueOnce(Buffer.from("2"))
        .mockReturnValueOnce(Buffer.from("3"));
    expect(readTextfile(root, url)).toBe("1");
    expect(readTextfile(root, url)).toBe("1");
    expect(readTextfile(root, url, true)).toBe("2");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60001);
    expect(readTextfile(root, url)).toBe("3");
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
    expect(() => readTextfile(root, "https://example.com/missing.rs")).toThrow("File not found");
    vi.mocked(execFileSync).mockImplementationOnce(() => {
        throw { status: 1 };
    });
    expect(() => readTextfile(root, "https://example.com/offline.rs")).toThrow(
        "File could not be loaded",
    );
    vi.mocked(execFileSync).mockImplementationOnce(() => {
        throw { status: 45 };
    });
    expect(() => readTextfile(root, "https://example.com/private.rs")).toThrow(
        "public network address",
    );
    vi.mocked(execFileSync).mockReturnValueOnce(Buffer.from([0xff]));
    expect(() => readTextfile(root, "https://example.com/binary.rs")).toThrow();
});

it("bakes permitted remote excerpts into exports while preserving source URLs", () => {
    const url = "https://example.com/export.rs?x=1&y=2";
    const body = `---\ntitle: Sample\n---\n\n![](${url}#L2)\n`;
    writeFileSync(join(root, "content/sample.md"), body);
    expect(collectRefs(parseDoc(formatMarkdown(body)).root).textfiles).toEqual([url]);
    const compiled = compileSite(root);
    expect(compiled.errors).toEqual([]);
    expect(compiled.docs[0]?.blocks).toMatchObject([
        {
            type: "code",
            filename: url,
            lang: "rs",
            range: "#L2",
            lines: ['    println!("hello");'],
        },
    ]);
    expect(blocksHtml(compiled.docs[0]?.blocks ?? [])).toContain(
        'class="codeblk-filename">export.rs</span>',
    );
    expect(exportEntries(root).map((entry) => entry.name)).toEqual([
        "dooc.yaml",
        "content/sample.md",
    ]);
    manifest([]);
    expect(compileSite(root).errors.join()).toContain("Domain is not allowed");
});

it("enforces the same policy in the editor and keeps remote content read-only", async () => {
    const file = "https://example.com/editor.rs";
    expect((await textfileResponse(root, { action: "read", file })).body.content).toBe(rust);
    manifest([]);
    expect((await textfileResponse(root, { action: "read", file })).status).toBe(400);
    expect(
        await textfileResponse(root, { action: "save", file, content: "overwrite", base: rust }),
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
    const first = textfileResponse(root, { action: "read", file });
    const second = textfileResponse(root, { action: "read", file });
    expect(fetchPublicFile).toHaveBeenCalledTimes(1);
    expect(execFileSync).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    finish(Buffer.from(rust));
    expect((await first).body.content).toBe(rust);
    expect((await second).body.content).toBe(rust);
    expect(readTextfile(root, file)).toBe(rust);
    expect(execFileSync).not.toHaveBeenCalled();
});

it("preserves missing-file and blocked-address handling during asynchronous reloads", async () => {
    vi.mocked(fetchPublicFile).mockRejectedValueOnce(new Error("NOT_FOUND"));
    expect(
        await textfileResponse(root, {
            action: "read",
            file: "https://example.com/async-missing.rs",
        }),
    ).toEqual({ status: 200, body: { content: null } });
    vi.mocked(fetchPublicFile).mockRejectedValueOnce(new Error("BLOCKED"));
    expect(
        (
            await textfileResponse(root, {
                action: "read",
                file: "https://example.com/async-blocked.rs",
            })
        ).body.error,
    ).toContain("public network address");
});
