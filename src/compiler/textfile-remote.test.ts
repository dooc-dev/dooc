import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { blocksHtml } from "../core/html.js";
import { textfileName } from "../core/textfile.js";
import { textfileResponse } from "../viewer/textfile.js";
import { compileSite, writeArtifact } from "./compile.js";
import { exportEntries } from "./export.js";
import { formatMarkdown } from "./format.js";
import { readTextfile } from "./textfile.js";
import { remoteTextfileSource } from "./textfile-remote.js";

let root: string;
let base: string;
let server: ChildProcess;
const rust = 'fn main() {\n    println!("hello");\n}\n';

beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "docs-textfile-http-"));
    const repo = join(root, "source");
    const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
    git("init", "-b", "main", repo);
    writeFileSync(join(repo, "hello.rs"), rust);
    git("-C", repo, "add", ".");
    git(
        "-C",
        repo,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@localhost",
        "commit",
        "-qm",
        "fixture",
    );
    git("clone", "--bare", repo, join(root, "repo.git"));
    // A separate process serves HTTP while the synchronous compiler is reading it.
    server = spawn(
        process.execPath,
        [
            "--input-type=module",
            "-e",
            `
        import { createServer } from 'node:http';
        import { spawn } from 'node:child_process';
        let reads = 0;
        const server = createServer((req, res) => {
            const url = new URL(req.url, 'http://localhost');
            if (url.pathname.startsWith('/repo.git/')) {
                const git = spawn('git', ['http-backend'], { env: { ...process.env,
                    GIT_PROJECT_ROOT: process.argv[1], GIT_HTTP_EXPORT_ALL: '1',
                    REQUEST_METHOD: req.method, PATH_INFO: url.pathname,
                    QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers['content-type'] || '',
                    CONTENT_LENGTH: req.headers['content-length'] || '',
                }});
                const chunks = [];
                git.stdout.on('data', chunk => chunks.push(chunk));
                git.on('close', () => {
                    const output = Buffer.concat(chunks);
                    const end = output.indexOf('\\r\\n\\r\\n');
                    for (const line of output.subarray(0, end).toString().split('\\r\\n')) {
                        const colon = line.indexOf(':');
                        if (colon < 0) continue;
                        const key = line.slice(0, colon), value = line.slice(colon + 1).trim();
                        if (key === 'Status') res.statusCode = parseInt(value);
                        else res.setHeader(key, value);
                    }
                    res.end(output.subarray(end + 4));
                });
                req.pipe(git.stdin);
            } else if (url.pathname === '/hello.rs') res.end(${JSON.stringify(rust)});
            else if (url.pathname === '/version.txt') res.end(String(++reads));
            else if (url.pathname === '/redirect') { res.writeHead(302, { location: '/hello.rs' }); res.end(); }
            else if (url.pathname === '/large') res.end('a'.repeat(2 * 1024 * 1024 + 1));
            else if (url.pathname === '/binary') res.end(Buffer.from([0xff]));
            else { res.statusCode = url.pathname === '/offline' ? 503 : 404; res.end(); }
        });
        server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port)));
    `,
            root,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
    );
    if (!server.stdout) throw new Error("HTTP fixture did not open stdout");
    const [port] = await once(server.stdout, "data");
    base = `http://127.0.0.1:${port}`;
    mkdirSync(join(root, "content"));
    writeFileSync(join(root, "manifest.yaml"), "- sample\n");
});

afterAll(() => {
    server?.kill();
    if (root) rmSync(root, { recursive: true, force: true });
});

it("resolves direct URLs, GitHub file links and Git ref/path URLs without losing filenames", () => {
    expect(
        remoteTextfileSource("https://github.com/owner/repo/blob/main/src/hello.rs?raw=1#L2").url,
    ).toBe("https://raw.githubusercontent.com/owner/repo/main/src/hello.rs?raw=1");
    expect(
        remoteTextfileSource("https://host/repo.git#feature/example:src/hello%20world.rs"),
    ).toEqual({ url: "https://host/repo.git", ref: "feature/example", path: "src/hello world.rs" });
    expect(textfileName("https://host/raw/hello%20world.rs?token=value#L2")).toBe("hello world.rs");
    expect(textfileName("https://host/repo.git#main:src/hello.rs")).toBe("hello.rs");
    for (const url of [
        "file:///etc/passwd",
        "ssh://host/repo.git#main:file",
        "https://user:password@host/file",
        "https://host/repo.git#main",
        "https://host/repo.git#-flag:file",
        "https://host/repo.git#main:../file",
        "https://host/repo.git#main:/file",
        "https://host/repo.git#main:file%00name",
    ])
        expect(() => remoteTextfileSource(url), url).toThrow();
});

it("fetches UTF-8 over HTTP, follows redirects, bounds downloads and rejects binary data", () => {
    expect(readTextfile(root, `${base}/hello.rs?x=1&y=2`)).toBe(rust);
    expect(readTextfile(root, `${base}/redirect`)).toBe(rust);
    expect(() => readTextfile(root, `${base}/missing`)).toThrow("File not found");
    expect(() => readTextfile(root, `${base}/offline`)).toThrow("File could not be loaded");
    expect(() => readTextfile(root, `${base}/large`)).toThrow("File could not be loaded");
    expect(() => readTextfile(root, `${base}/binary`)).toThrow();
});

it("caches repeated reads and refreshes on explicit reload or after one minute", () => {
    const url = `${base}/version.txt`;
    expect(readTextfile(root, url)).toBe("1");
    expect(readTextfile(root, url)).toBe("1");
    expect(readTextfile(root, url, true)).toBe("2");
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60001);
    try {
        expect(readTextfile(root, url)).toBe("3");
    } finally {
        now.mockRestore();
    }
});

it("reads Git blobs at the requested ref without checking out the repository", () => {
    expect(readTextfile(root, `${base}/repo.git#main:hello.rs`)).toBe(rust);
    expect(() => readTextfile(root, `${base}/repo.git#main:absent.rs`)).toThrow("File not found");
    expect(() => readTextfile(root, `${base}/repo.git#absent:hello.rs`)).toThrow(
        "File could not be loaded",
    );
});

it("bakes remote excerpts and graceful failures into exports while preserving source URLs", () => {
    const url = `${base}/hello.rs?x=1&y=2`;
    const body = `---\ntitle: Sample\n---\n\n:::textfile(${url})[2,2]\n\n:::textfile(${base}/missing.rs)\n\n:::textfile(${base}/offline)\n`;
    writeFileSync(join(root, "content/sample.md"), body);
    expect(formatMarkdown(body)).toContain(`:::textfile(${url})[2,2]`);
    const compiled = compileSite(root);
    expect(compiled.errors).toEqual([]);
    expect(compiled.artifact.docs[0]?.blocks).toMatchObject([
        {
            type: "code",
            filename: url,
            lang: "rs",
            range: "[2,2]",
            lines: ['    println!("hello");'],
        },
        { type: "code", unavailable: "missing" },
        { type: "code", unavailable: "unreachable" },
    ]);
    expect(blocksHtml(compiled.artifact.docs[0]?.blocks ?? [])).toContain(
        'class="codeblk-filename">hello.rs</span>',
    );
    expect(writeArtifact(compiled, join(root, "artifact"))).toBe(true);
    expect(exportEntries(root).map((entry) => entry.name)).toEqual([
        "manifest.yaml",
        "content/sample.md",
    ]);
});

it("lets the editor reload remote content but never save it or create a local URL path", () => {
    const file = `${base}/hello.rs`;
    expect(textfileResponse(root, { action: "read", file }).body.content).toBe(rust);
    expect(
        textfileResponse(root, { action: "read", file: `${base}/missing.rs` }).body.content,
    ).toBeNull();
    expect(
        textfileResponse(root, { action: "save", file, content: "overwrite", base: rust }),
    ).toEqual({ status: 400, body: { error: "Remote files are read-only" } });
});
