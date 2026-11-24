import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { compressMedia } from "./build-media.js";
import { writeBuildOutput } from "./build-output.js";
import { buildSize, checkBuildSize, splitBuild } from "./build-split.js";

vi.mock("./build-media.js", () => ({ compressMedia: vi.fn() }));
const roots: string[] = [];
afterEach(() => {
    vi.resetAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("separates pages and ordered scripts, deduplicates resources, and rebases CSS and project fonts", async () => {
    const png = `data:image/png;base64,${Buffer.from("original pixels").toString("base64")}`;
    const download = png.replace("image/png", "application/octet-stream");
    const font = "url(data:font/woff2;base64,Zm9udA==)";
    const result = await splitBuild(
        ({ asset }) => {
            const css = asset(`a{background:url(${png})}`, "css");
            const first = asset("window.order=[1]", "js");
            const second = asset(`window.font=${JSON.stringify(font)};window.order.push(2)`, "js");
            const one = asset(
                `<article><img src="${png}"><a href="${download}" download="source.png">Download</a><pre>${png}</pre></article>`,
                "html",
            );
            const two = asset(`<article><img src="${png}"><span>日本語</span></article>`, "html");
            return `<!doctype html><html><head><link rel="stylesheet" href="${css}"><script src="${first}"></script></head><body>
<script src="${second}"></script><script type="application/json" id="data">{"keep":true}</script>
<template data-route="one" data-title="One" data-src="${one}"></template>
<template data-route="two" data-src="${two}"></template></body></html>`;
        },
        {},
        [font],
    );
    const byExt = (ext: string) => [...result.files].filter(([name]) => name.endsWith(ext));
    expect(byExt(".png")).toHaveLength(1);
    expect(byExt(".woff2")).toHaveLength(1);
    expect(byExt(".html")).toHaveLength(2);
    expect(byExt(".js")).toHaveLength(2);
    expect(result.data).toContain('data-route="one" data-title="One" data-src="./dooc-assets/');
    expect(result.data).not.toContain("<article>");
    expect(result.data).toContain('{"keep":true}');
    expect(byExt(".css")[0]?.[1].toString()).toContain(
        byExt(".png")[0]?.[0].slice("dooc-assets/".length),
    );
    expect(byExt(".css")[0]?.[1].toString()).not.toContain("./dooc-assets/");
    expect(byExt(".html")[0]?.[1].toString()).toContain(`<pre>${png}</pre>`);
    expect(byExt(".html")[0]?.[1].toString()).toContain(`href="./${byExt(".png")[0]?.[0]}"`);
    expect(byExt(".js")[1]?.[1].toString()).toContain(`url(\\"./${byExt(".woff2")[0]?.[0]}\\")`);
    expect(compressMedia).not.toHaveBeenCalled();
});

it("compresses previews once, keeps original download bytes and reports unsupported compression", async () => {
    vi.mocked(compressMedia).mockResolvedValue({
        data: Buffer.from("webp"),
        mime: "image/webp",
        warning: "Example warning",
    });
    const png = "data:image/png;base64,b3JpZ2luYWw=";
    const result = await splitBuild(
        () =>
            `<img src="${png}"><img src="${png}"><a href="${png.replace("image/png", "application/octet-stream")}" download="source.png">Source</a>`,
        { compress: true },
    );
    expect(compressMedia).toHaveBeenCalledOnce();
    expect([...result.files.values()].map((data) => data.toString()).sort()).toEqual([
        "original",
        "webp",
    ]);
    expect(result.data).toContain(".webp");
    expect(result.data).toContain(".png");
    expect(result.warnings[0]).toContain("Example warning");
});

it("keeps active data URLs isolated instead of serving them from the publication origin", async () => {
    const html =
        '<iframe src="data:text/html,%3Cscript%3Ealert(1)%3C/script%3E"></iframe><img src="data:image/svg+xml,%3Csvg/%3E">';
    const result = await splitBuild(() => html, {});
    expect(result.data).toBe(html);
    expect(result.files.size).toBe(0);
});

it("preserves unknown embedded MIME types and gives text and CSS resources their correct extensions", async () => {
    const unknown = "data:application/x-example;base64,aGVsbG8=";
    const result = await splitBuild(
        () =>
            `<object data="${unknown}"></object><iframe src="data:text/plain;base64,SGVsbG8="></iframe><link rel="stylesheet" href="data:text/css;base64,Ym9keXtjb2xvcjpyZWR9"><iframe src="data:text/plain,100%"></iframe>`,
        { compress: true },
    );
    expect(result.data).toContain(unknown);
    expect(result.warnings.some((warning) => warning.includes("application/x-example"))).toBe(true);
    expect([...result.files.keys()].some((file) => file.endsWith(".txt"))).toBe(true);
    expect([...result.files.keys()].some((file) => file.endsWith(".css"))).toBe(true);
    expect(result.data).toContain('src="data:text/plain,100%"');
    expect(compressMedia).not.toHaveBeenCalled();
});

it.each([
    ["25MiB", 25 * 1024 ** 2],
    ["25MB", 25_000_000],
    ["1.5 KiB", 1536],
    ["100", 100],
    [1, 1],
] as const)("parses byte budget %s", (input, expected) => {
    expect(buildSize(input, "budget")).toBe(expected);
});

it.each([
    "",
    "0",
    "-1",
    "1mb trailing",
    "1.1B",
    "Infinity",
    "1e6",
    0,
    -1,
    Number.NaN,
    Number.MAX_SAFE_INTEGER + 1,
])("rejects invalid budget %s", (input) => {
    expect(() => buildSize(input, "--max-file-size")).toThrow("--max-file-size must be a positive");
});

it("checks exact UTF-8 output bytes and inclusive per-file and total budgets", () => {
    const files = new Map([
        ["index.html", Buffer.from("日本語")],
        ["resource", Buffer.from("123")],
    ]);
    expect(checkBuildSize(files, 9, 12)).toBe(12);
    expect(() => checkBuildSize(files, 8, 11)).toThrow(/index.html: 9 bytes[\s\S]*Build: 12 bytes/);
    expect(checkBuildSize(files)).toBe(12);
});

it("publishes assets before switching the entry, preserves unrelated files, and rejects conflicts and symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-split-output-"));
    roots.push(root);
    const path = join(root, "index.html");
    writeFileSync(path, "previous");
    writeFileSync(join(root, "source.md"), "keep");
    const files = new Map([["dooc-assets/a.js", Buffer.from("first")]]);
    writeBuildOutput(path, { data: "current", files });
    expect(readFileSync(path, "utf8")).toBe("current");
    expect(readFileSync(join(root, "source.md"), "utf8")).toBe("keep");
    writeBuildOutput(path, { data: "reused", files });
    files.set("dooc-assets/a.js", Buffer.from("conflict"));
    expect(() => writeBuildOutput(path, { data: "bad", files })).toThrow("conflicts");
    symlinkSync(join(root, "source.md"), join(root, "dooc-assets/link.js"));
    expect(() =>
        writeBuildOutput(path, {
            data: "bad",
            files: new Map([["dooc-assets/link.js", Buffer.from("overwrite")]]),
        }),
    ).toThrow("conflicts");
    symlinkSync(root, join(root, "dooc-assets/linked"));
    expect(() =>
        writeBuildOutput(path, {
            data: "bad",
            files: new Map([["dooc-assets/linked/source.md", Buffer.from("overwrite")]]),
        }),
    ).toThrow("regular directory");
    expect(() =>
        writeBuildOutput(path, {
            data: "bad",
            files: new Map([["dooc-assets/../source.md", Buffer.from("overwrite")]]),
        }),
    ).toThrow("Invalid build asset path");
    expect(readFileSync(path, "utf8")).toBe("reused");
    expect(readFileSync(join(root, "source.md"), "utf8")).toBe("keep");
    expect(readdirSync(root).some((name) => name.startsWith(".dooc-build-"))).toBe(false);
    mkdirSync(join(root, "dooc-assets/dir.js"));
    expect(() =>
        writeBuildOutput(path, {
            data: "bad",
            files: new Map([["dooc-assets/dir.js", Buffer.from("overwrite")]]),
        }),
    ).toThrow("conflicts");
});
