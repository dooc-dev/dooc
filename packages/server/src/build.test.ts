import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginTransport } from "../../../plugins/src/transport.js";
import { embedBundleUrls } from "../../engine/src/compiler/bundle-urls.js";
import { compileSite } from "../../engine/src/compiler/compile.js";
import { exportEntries } from "../../engine/src/compiler/export.js";
import { projectRoot } from "../../engine/src/compiler/manifest.js";
import { fetchPublicFile } from "../../engine/src/compiler/public-file.js";
import { buildBundle } from "./build.js";
import { bundleClient } from "./serve.js";

vi.mock("../../engine/src/compiler/public-file.js", () => ({ fetchPublicFile: vi.fn() }));
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
    "static",
    "live",
] as const)("downloads complete resource files from %s HTML", async (mode) => {
    const files = new Map<string, string | Buffer>([
        ["files/code.ts", "// First line\r\nconst value = 42;\r\n// Last line\r\n"],
        ["files/data.csv", "name,value\nExample,42\n"],
        ["files/chart.mermaid", "graph LR\n A-->B\n"],
        ["files/note.callouth", "A resource note.\n"],
        [
            "files/image.svg",
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
        ],
        ["files/page.html", "<!--fig\ntitle: Page\n-->\n<p>Embedded page</p>"],
        ["files/report.pdf", "%PDF-1.4\n%%EOF\n"],
        ["files/movie.mp4", Buffer.from([0, 1, 2, 255])],
        [
            "files/pixel.png",
            Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aXcAAAAASUVORK5CYII=",
                "base64",
            ),
        ],
    ]);
    for (const [file, data] of files) write(file, data);
    write("themes/dark/files/code.ts", "// Dark theme\nconst theme = 'dark';\n");
    write("unrelated.txt", "Do not publish this file");
    write(
        "content/guide.md",
        `${[...files.keys()].map((file) => `![](${file}${file.endsWith(".ts") ? "#L2" : ""})`).join("\n\n")}\n`,
    );
    const { data } = await buildBundle(root, { format: "html", mode, easyDownload: true });
    const html = String(data);
    expect(html).toContain(" data-easy-download");
    const downloads = new Map(
        [
            ...html.matchAll(
                /class="resource-download" href="data:application\/octet-stream;base64,([^"]*)" download="([^"]*)"/g,
            ),
        ].map(([, encoded, name]) => [name, Buffer.from(encoded ?? "", "base64")]),
    );
    for (const [file, source] of files)
        if (!file.endsWith(".ts"))
            expect(downloads.get(file.split("/").at(-1) ?? "")).toEqual(Buffer.from(source));
    expect(html).toContain(
        `base64,${Buffer.from(files.get("files/code.ts") ?? "").toString("base64")}" download="code.ts"`,
    );
    expect(html).toContain(
        `base64,${Buffer.from("// Dark theme\nconst theme = 'dark';\n").toString("base64")}" download="code.ts"`,
    );
    expect(downloads.has("unrelated.txt")).toBe(false);
    for (const easyDownload of [undefined, false]) {
        const disabled = await buildBundle(root, { format: "html", mode, easyDownload });
        expect(disabled.data).not.toContain('class="resource-download"');
        expect(disabled.data).not.toContain(" data-easy-download");
    }
});

it("downloads snapshotted URLs offline and preserves remote downloads in network mode", async () => {
    write("content/guide.md", "![](https://example.com/file.txt#L2)\n");
    vi.mocked(fetchPublicFile).mockResolvedValue(Buffer.from("First\nSecond\nThird"));
    const snapshot = await buildBundle(root, { format: "html", easyDownload: true });
    expect(snapshot.data).toContain(
        `class="resource-download" href="data:application/octet-stream;base64,${Buffer.from("First\nSecond\nThird").toString("base64")}"`,
    );
    vi.mocked(fetchPublicFile).mockClear();
    const network = await buildBundle(root, {
        format: "html",
        urlPreview: "network",
        easyDownload: true,
    });
    expect(network.data).toContain(
        'class="resource-download" href="https://example.com/file.txt#L2" download="file.txt"',
    );
    expect(fetchPublicFile).not.toHaveBeenCalled();
});

it("rejects invalid easy download options before building", async () => {
    await expect(buildBundle(root, { format: "zip", easyDownload: true })).rejects.toThrow(
        "HTML builds only",
    );
    await expect(
        buildBundle(root, { format: "html", easyDownload: "true" as unknown as boolean }),
    ).rejects.toThrow("must be a boolean");
});

it.each(["html", "zip"] as const)("builds %s from the selected named manifest", async (format) => {
    write(
        "team.dooc.yaml",
        "left_sidebar: {title: {eng: Team Bundle}}\ncenter_contents: [{file: guide.md}]\n",
    );
    write("guide.md", "Team document.\n");
    const { data } = await buildBundle(projectRoot(join(root, "team.dooc.yaml")), { format });
    if (format === "html") expect(data).toContain("Team Bundle");
    else {
        write("output.zip", data);
        const entries = execFileSync("unzip", ["-Z1", join(root, "output.zip")], {
            encoding: "utf8",
        })
            .trim()
            .split("\n");
        expect(entries).toContain("team.dooc.yaml");
        expect(entries).not.toContain("dooc.yaml");
    }
});

it.each([
    "static",
    "live",
] as const)("omits unused runtimes and grammars from %s HTML", async (mode) => {
    write("content/guide.md", "Only text.\n");
    const { data } = await buildBundle(root, { format: "html", mode });
    expect(bundleClient).not.toHaveBeenCalled();
    expect(data).toContain('id="code-grammars" type="application/json">[]</script>');
});

it("includes languages used by nested code and file embeds, along with their dependencies", async () => {
    write("content/guide.md", "> ```example\n> name: example\n> ```\n\n![](files/example.json)\n");
    write(
        ".dooc/code-languages/custom.json",
        JSON.stringify({
            name: "custom",
            aliases: ["example"],
            scopeName: "source.custom",
            patterns: [{ include: "source.yaml" }],
        }),
    );
    write("files/example.json", '{"name":"example"}');
    const { data } = await buildBundle(root, { format: "html" });
    expect(vi.mocked(bundleClient).mock.calls).toEqual([["code-highlight.ts"]]);
    const json =
        String(data).match(/id="code-grammars" type="application\/json">([^<]*)<\/script>/)?.[1] ??
        "[]";
    expect(
        JSON.parse(json)
            .map((grammar: { name: string }) => grammar.name)
            .sort(),
    ).toEqual(["custom", "json", "yaml"]);
});

it("retains the complete diagram runtime for Mermaid without bundling unrelated code languages", async () => {
    write("content/guide.md", "```mermaid\nmindmap\n  root((Example))\n    Child\n```\n");
    const { data } = await buildBundle(root, { format: "html" });
    expect(vi.mocked(bundleClient).mock.calls).toEqual([["schema-graph-global.tsx"]]);
    expect(data).toContain('data-mermaid="pending"');
    expect(data).toContain('id="code-grammars" type="application/json">[]</script>');
});

it.each([
    { format: "html", urlPreview: "embed" },
    { format: "html", urlPreview: "network" },
    { format: "zip", urlPreview: "embed" },
    { format: "zip", urlPreview: "network" },
] as const)("includes schemas and visible records with $format/$urlPreview", async (options) => {
    write(
        "dooc.yaml",
        "default_subformat_folder: private\ncenter_contents:\n  - subformat: issue\njson_subformats:\n  - ext: issue\n    format: json\n    schema: issue.schema.json\n",
    );
    write("issue.schema.json", '{"type":"object","properties":{"title":{"type":"string"}}}');
    write("records/one.issue", '{"title":"Visible record"}');
    write("private/secret.issue", '{"title":"PRIVATE-RECORD"}');
    write(".gitignore", "private/\n");
    const compiled = compileSite(root);
    expect(compiled.errors).toEqual([]);
    expect(compiled.docs[0]?.subformat?.records.map((record) => record.file)).toEqual([
        "records/one.issue",
    ]);
    const { data } = await buildBundle(root, options);
    if (options.format === "html") {
        expect(data).toContain("Visible record");
        expect(data).not.toContain("PRIVATE-RECORD");
    } else {
        write("output.zip", data);
        const unpacked = join(root, "unpacked");
        execFileSync("unzip", ["-q", join(root, "output.zip"), "-d", unpacked]);
        expect(compileSite(unpacked).errors).toEqual([]);
        expect(compileSite(unpacked).docs[0]?.subformat?.records).toHaveLength(1);
    }
});

it.each([
    "embed",
    "network",
] as const)("rejects ignored references for %s builds", async (urlPreview) => {
    write("content/guide.md", "![](private.txt)\n");
    write("private.txt", "PRIVATE-CONTENT");
    write(".gitignore", "private.txt\n");
    expect(JSON.stringify(compileSite(root))).not.toContain("PRIVATE-CONTENT");
    await expect(buildBundle(root, { format: "html", urlPreview })).rejects.toThrow(
        /ignored.*private\.txt/,
    );
});

it("snapshots authenticated plugin views without serializing credentials or invoking actions", async () => {
    write("content/guide.md", "![](https://service.example/issue/1)\n");
    const request = vi.fn<PluginTransport>().mockImplementation(async (input) => {
        if (input.action === "resolve") return { plugin: "service" };
        if (input.action === "read")
            return { view: { blocks: [{ type: "text", text: "Authenticated snapshot" }] } };
        throw new Error("Unexpected operation");
    });
    const { data } = await buildBundle(root, {
        format: "html",
        mode: "static",
        pluginTransport: request,
    });
    expect(data).toContain("Authenticated snapshot");
    expect(data).toContain("connect-src 'none'");
    expect(request.mock.calls.map(([input]) => input.action)).toEqual(["resolve", "read"]);
    expect(fetchPublicFile).not.toHaveBeenCalled();
    expect(readFileSync(join(root, "content/guide.md"), "utf8")).toContain(
        "https://service.example/issue/1",
    );
    request.mockRejectedValue(Object.assign(new Error("Authentication required"), { status: 401 }));
    await expect(
        buildBundle(root, { format: "html", mode: "static", pluginTransport: request }),
    ).rejects.toThrow("Authentication required");
});

it("builds live HTML with a transport API and no build-time authenticated fetch", async () => {
    write("content/guide.md", "![](https://service.example/issue/1)\n");
    const request = vi.fn<PluginTransport>();
    vi.mocked(bundleClient).mockImplementation(async (entry) =>
        entry === "published-plugins.ts"
            ? "window.dooc={setPluginTransport(){}};"
            : "/* bundled runtime */",
    );
    const { data } = await buildBundle(root, {
        format: "html",
        mode: "live",
        auth: "external",
        pluginTransport: request,
    });
    expect(data).toContain("setPluginTransport");
    expect(data).not.toContain("connect-src 'none'");
    expect(data).not.toContain('credentials: "omit"');
    expect(request).not.toHaveBeenCalled();
    expect(fetchPublicFile).not.toHaveBeenCalled();
    await expect(
        buildBundle(root, { format: "html", mode: "live", urlPreview: "embed" }),
    ).rejects.toThrow("Live HTML requires network resources");
});

it.each([
    { format: "html", urlPreview: "embed" },
    { format: "html", urlPreview: "network" },
    { format: "zip", urlPreview: "embed" },
    { format: "zip", urlPreview: "network" },
] as const)("builds only $format with url_preview=$urlPreview", async (options) => {
    const source =
        "![Example](https://example.com/sample.txt#L2)\n\n[Ordinary link](https://other.example/ignored)\n";
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
    write("content/guide.md", "Body\n");
    write("docs.config.mjs", 'throw new Error("Do not execute for a source ZIP");');
    expect(Buffer.isBuffer((await buildBundle(root, { format: "zip" })).data)).toBe(true);
    expect(bundleClient).not.toHaveBeenCalled();
});

it("captures HTML, CSS imports, responsive images, fonts and local asset dependencies", async () => {
    write(
        "content/guide.md",
        "![](https://example.com/page)\n\n![](files/html/local.html)\n\n![](files/example.css)\n",
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
    const entries = await embedBundleUrls(root, exportEntries(root));
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
    write("content/guide.md", "![](https://example.com/page.html)\n");
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
        "![](https://example.com/code.css)\n\n![](https://example.com/page.html)\n",
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
    const entries = await embedBundleUrls(root, exportEntries(root));
    expect(
        entries
            .find((entry) => entry.name.startsWith("files/bundle/") && entry.name.endsWith(".css"))
            ?.data.toString(),
    ).toBe(css);
    expect(fetchPublicFile).toHaveBeenCalledTimes(3);
});

it("fails on cyclic CSS dependencies instead of leaving network resources in a static bundle", async () => {
    write("content/guide.md", "![](https://example.com/page.html)\n");
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

it("embeds a source URL in static HTML before the temporary build directory is removed", async () => {
    write("content/guide.md", "Body\n");
    const { data } = await buildBundle(root, {
        format: "html",
        sourceUrl: "https://example.com/deployed/source",
    });
    expect(data).toContain('data-source-base="https://example.com/deployed/source/"');
    expect(data).not.toContain('data-source-base="dooc-bundle-');
    const fallback = await buildBundle(root, { format: "html" });
    expect(fallback.data).toContain(`data-source-base="${root.split("/").at(-1)}/"`);
    await expect(
        buildBundle(root, { format: "zip", sourceUrl: "https://example.com/" }),
    ).rejects.toThrow("HTML builds only");
    await expect(
        buildBundle(root, { format: "html", sourceUrl: "javascript:alert(1)" }),
    ).rejects.toThrow("HTTP(S)");
});
