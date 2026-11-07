import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bundleEntries } from "../compiler/bundle.js";
import { embedBundleUrls } from "../compiler/bundle-urls.js";
import { compileSite } from "../compiler/compile.js";
import { fetchPublicFile } from "../compiler/public-file.js";
import { buildBundle } from "./build.js";
import { bundleClient } from "./serve.js";

vi.mock("../compiler/public-file.js", () => ({ fetchPublicFile: vi.fn() }));
vi.mock("./serve.js", async (original) => ({
    ...(await original<typeof import("./serve.js")>()),
    bundleClient: vi.fn().mockResolvedValue("/* bundled runtime */"),
}));
let root: string;
const write = (path: string, data: string | Buffer) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), data);
};
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dooc-build-test-"));
    write("dooc.yaml", "title: Bundle\ndocs: [guide]\n");
    vi.mocked(fetchPublicFile).mockReset();
    vi.mocked(bundleClient).mockClear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it.each([
    { format: "html", urlPreview: "embed" },
    { format: "html", urlPreview: "network" },
    { format: "zip", urlPreview: "embed" },
    { format: "zip", urlPreview: "network" },
] as const)("builds only $format with url_preview=$urlPreview", async (options) => {
    const source =
        "---\ntitle: Guide\n---\n\n![Example](https://example.com/sample.txt#L2)\n\n[Ordinary link](https://other.example/ignored)\n";
    write("content/guide.md", source);
    vi.mocked(fetchPublicFile).mockResolvedValue(Buffer.from("first\nSnapshot text\nlast"));
    const { data } = await buildBundle(root, options);
    expect(fetchPublicFile).toHaveBeenCalledTimes(options.urlPreview === "embed" ? 1 : 0);
    expect(readFileSync(join(root, "content/guide.md"), "utf8")).toBe(source);
    if (options.format === "html") {
        expect(typeof data).toBe("string");
        expect(data).toContain('href="https://other.example/ignored"');
        if (options.urlPreview === "embed") {
            expect(data).toContain("Snapshot text");
            expect(data).toContain("connect-src 'none'");
            expect(data).not.toContain('data-embed-url="https://example.com');
        } else {
            expect(data).toContain('data-embed-url="https://example.com/sample.txt#L2"');
            expect(data).toContain('credentials: "omit"');
            expect(data).not.toContain("connect-src 'none'");
        }
    } else {
        expect(Buffer.isBuffer(data)).toBe(true);
        expect(bundleClient).not.toHaveBeenCalled();
        write("output.zip", data);
        const unpacked = join(root, "unpacked");
        execFileSync("unzip", ["-q", join(root, "output.zip"), "-d", unpacked]);
        const doc = readFileSync(join(unpacked, "content/guide.md"), "utf8");
        expect(readFileSync(join(unpacked, "dooc.yaml"), "utf8")).toContain("docs: [guide]");
        if (options.urlPreview === "embed") {
            expect(doc).toMatch(/!\[Example\]\(files\/bundle\/[a-f0-9]+\.txt#L2\)/);
            const compiled = compileSite(unpacked);
            expect(compiled.errors).toEqual([]);
            expect(compiled.docs[0]?.blocks).toContainEqual(
                expect.objectContaining({ type: "code", lines: ["Snapshot text"] }),
            );
        } else expect(doc).toBe(source);
    }
});

it("builds a source ZIP without executing HTML rendering configuration", async () => {
    write("content/guide.md", "---\ntitle: Guide\n---\nBody\n");
    write("docs.config.mjs", 'throw new Error("Do not execute for a source ZIP");');
    expect(Buffer.isBuffer((await buildBundle(root, { format: "zip" })).data)).toBe(true);
    expect(bundleClient).not.toHaveBeenCalled();
});

it("captures HTML, CSS imports, responsive images, fonts and local asset dependencies", async () => {
    write(
        "content/guide.md",
        "---\ntitle: Guide\n---\n\n![](https://example.com/page)\n\n![](files/html/local.html)\n",
    );
    write(
        "files/html/local.html",
        '<!--fig\ntitle: Local\n-->\n<img src="../../assets/local.png">',
    );
    write("assets/local.png", Buffer.from([1, 2, 3]));
    write("files/example.css", '@import "https://example.com/code-example-only.css";');
    const files: Record<string, [string, string]> = {
        "https://example.com/page": [
            "text/html",
            '<!doctype html><html><head><base href="https://assets.example/root/"><link rel="stylesheet" href="main.css"></head><body><h1>Captured page</h1><img src="picture.png" srcset="picture.png 1x, big.png 2x"><script src="app.js"></script><a href="details">Details</a></body></html>',
        ],
        "https://assets.example/root/main.css": [
            "text/css",
            '@import "theme.css"; h1{background-image:image-set("picture.png" 1x, url(big.png) 2x)}',
        ],
        "https://assets.example/root/theme.css": [
            "text/css",
            "@font-face{font-family:remote;src:url(font.woff2)}",
        ],
        "https://assets.example/root/picture.png": ["image/png", "image"],
        "https://assets.example/root/big.png": ["image/png", "large image"],
        "https://assets.example/root/font.woff2": ["font/woff2", "font"],
    };
    vi.mocked(fetchPublicFile).mockImplementation(async (url, contentType) => {
        const file = files[url];
        if (!file) throw new Error(`Unexpected request: ${url}`);
        contentType?.(file[0]);
        return Buffer.from(file[1]);
    });
    const entries = await embedBundleUrls(root, bundleEntries(root));
    expect(entries.find((entry) => entry.name === "files/example.css")?.data.toString()).toContain(
        "https://example.com/code-example-only.css",
    );
    expect(fetchPublicFile).toHaveBeenCalledTimes(6);
    const page = entries
        .find((entry) => entry.name.startsWith("files/bundle/") && entry.name.endsWith(".html"))
        ?.data.toString();
    expect(page).toContain("Captured page");
    expect(page).toContain("data:text/css;base64,");
    expect(page).toContain("data:image/png;base64,");
    expect(page).toContain('href="https://assets.example/root/details"');
    expect(page).not.toContain("<script");
    expect(
        entries.find((entry) => entry.name === "files/html/local.html")?.data.toString(),
    ).toContain("data:image/png;base64,AQID");
    for (const entry of entries) write(`rebuilt/${entry.name}`, entry.data);
    expect(compileSite(join(root, "rebuilt")).errors).toEqual([]);
});

it("fails on missing dependencies and never reads bundle files on behalf of a remote page", async () => {
    write("content/guide.md", "---\ntitle: Guide\n---\n\n![](https://example.com/page.html)\n");
    vi.mocked(fetchPublicFile).mockResolvedValue(Buffer.from('<img src="bundle:///dooc.yaml">'));
    await expect(buildBundle(root, { format: "html" })).rejects.toThrow("public HTTPS required");
    vi.mocked(fetchPublicFile).mockRejectedValue(new Error("NOT_FOUND"));
    await expect(buildBundle(root, { format: "html" })).rejects.toThrow(
        "https://example.com/page.html: NOT_FOUND",
    );
});

it("keeps embedded CSS code verbatim while snapshotting the same URL as a stylesheet", async () => {
    write(
        "content/guide.md",
        "---\ntitle: Guide\n---\n\n![](https://example.com/code.css)\n\n![](https://example.com/page.html)\n",
    );
    const css = "body{background:url(image.png)}";
    vi.mocked(fetchPublicFile).mockImplementation(async (url) =>
        Buffer.from(
            url.endsWith("css")
                ? css
                : url.endsWith("html")
                  ? '<link rel="stylesheet" href="code.css">'
                  : "image",
        ),
    );
    const entries = await embedBundleUrls(root, bundleEntries(root));
    expect(
        entries
            .find((entry) => entry.name.startsWith("files/bundle/") && entry.name.endsWith(".css"))
            ?.data.toString(),
    ).toBe(css);
    expect(fetchPublicFile).toHaveBeenCalledTimes(3);
});

it("fails on cyclic CSS dependencies instead of leaving network resources in a static bundle", async () => {
    write("content/guide.md", "---\ntitle: Guide\n---\n\n![](https://example.com/page.html)\n");
    vi.mocked(fetchPublicFile).mockImplementation(async (url) =>
        Buffer.from(
            url.endsWith("html")
                ? '<link rel="stylesheet" href="loop.css">'
                : '@import "loop.css";',
        ),
    );
    await expect(buildBundle(root, { format: "html" })).rejects.toThrow(
        "Circular embedded resource",
    );
});
