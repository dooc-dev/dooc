import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { checkSite } from "../../engine/src/compiler/check.js";
import { fetchPublicFile } from "../../engine/src/compiler/public-file.js";
import { buildBundle, writeBuildOutput } from "./build.js";

vi.mock("../../engine/src/compiler/public-file.js", () => ({ fetchPublicFile: vi.fn() }));
let root: string;
const put = (file: string, content: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
};
const source = "const source = 42;\n";
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dooc-github-output-"));
    put("dooc.yaml", "defaultLang: eng\nlanguages: [eng]\ndocs: [guide, other]\n");
    put(
        "content/guide.md",
        "## Intro\n\n[Next](content/other.md#next)\n\n![Picture](figures/plain.svg)\n\n![Code](files/example.ts#L1)\n\n![](files/flow.graphth)\n\n- First\n- Second\n\n> Quoted text\n",
    );
    put("content/other.md", "## Next\n\n[Back](content/guide.md#intro)\n");
    put("files/example.ts", source);
    put("files/flow.graphth", "[a]: First\n[b]: Second\n[a] -> [b]\n");
    put(
        "figures/plain.svg",
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20"/></svg>',
    );
    vi.mocked(fetchPublicFile).mockReset();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it.each([
    { format: "html", resources: "copy" },
    { format: "html", resources: "reference" },
    { format: "zip", resources: "copy" },
] as const)("builds and checks GitHub $format with $resources resources", async ({
    format,
    resources,
}) => {
    const bundle = await buildBundle(root, {
        format,
        target: "github",
        resources,
        urlPreview: format === "zip" ? "embed" : "network",
    });
    const file = `dist/bundle.github.${format}`;
    writeBuildOutput(join(root, file), bundle);
    expect(checkSite(root, { only: ["github"], githubOutput: file })).toMatchObject({
        checks: ["github"],
        exitCode: 0,
        diagnostics: [],
    });
    const entries =
        format === "zip"
            ? unzipSync(Buffer.from(bundle.data))
            : Object.fromEntries((bundle.files ?? []).map((entry) => [entry.name, entry.data]));
    const body =
        format === "html"
            ? String(bundle.data)
            : Buffer.from(entries["README.md"] ?? []).toString();
    if (resources === "reference") {
        expect(body).toContain('src="../figures/plain.svg"');
        expect(body).toContain('href="../files/example.ts#L1"');
        expect(Object.keys(entries).some((name) => name.endsWith("files/example.ts"))).toBe(false);
    } else
        expect(
            Object.keys(entries).some((name) => name.endsWith("resources/files/example.ts")),
        ).toBe(true);
    expect(Object.keys(entries).some((name) => name.endsWith(".svg"))).toBe(true);
    if (format === "html") {
        expect(body).toContain("<pre><code>const source = 42;</code></pre>");
        expect(body).toContain("<ul><li>");
        expect(body).toContain("<blockquote>");
        expect(body).toContain('href="#dooc-');
        expect(body).not.toMatch(/```|<iframe|<script|href="pages\//);
        const anchors = new Set([...body.matchAll(/name="([^"]+)"/g)].map((match) => match[1]));
        for (const match of body.matchAll(/href="#([^"]+)"/g)) expect(anchors).toContain(match[1]);
    }
    put("files/example.ts", "const source = 99;\n");
    expect(checkSite(root, { only: ["github"], githubOutput: file }).diagnostics).toContainEqual(
        expect.objectContaining({ code: "GITHUB_SOURCE_CHANGED", sourceFile: "files/example.ts" }),
    );
    expect(fetchPublicFile).not.toHaveBeenCalled();
});

it.each([
    { format: "zip", target: "github" },
    { format: "github" },
] as const)("rejects source references in $format ZIP output", async (options) => {
    await expect(buildBundle(root, { ...options, resources: "reference" })).rejects.toThrow(
        "ZIP builds include local files",
    );
    expect(fetchPublicFile).not.toHaveBeenCalled();
});

it("detects missing sources, changed companions, new dependencies and a wrong reference base", async () => {
    const bundle = await buildBundle(root, {
        format: "html",
        target: "github",
        resources: "reference",
        urlPreview: "network",
    });
    const file = "dist/bundle.github.html";
    writeBuildOutput(join(root, file), bundle);
    const svg = bundle.files?.find((entry) => entry.name.endsWith(".svg"));
    expect(svg).toBeDefined();
    put(`dist/${svg?.name}`, "Changed output");
    expect(checkSite(root, { only: ["github"], githubOutput: file }).diagnostics).toContainEqual(
        expect.objectContaining({ code: "GITHUB_OUTPUT_CHANGED" }),
    );
    rmSync(join(root, `dist/${svg?.name}`));
    rmSync(join(root, "files/example.ts"));
    const missing = checkSite(root, { only: ["github"], githubOutput: file });
    expect(missing.exitCode).toBe(1);
    expect(
        missing.diagnostics.filter((entry) => entry.code === "GITHUB_FILE_MISSING"),
    ).toHaveLength(2);
    put("files/example.ts", source);
    writeBuildOutput(join(root, file), bundle);
    put("files/new.ts", "const added = true;\n");
    put(
        "content/guide.md",
        `${readFileSync(join(root, "content/guide.md"), "utf8")}\n![](files/new.ts)\n`,
    );
    expect(checkSite(root, { only: ["github"], githubOutput: file }).diagnostics).toContainEqual(
        expect.objectContaining({ code: "GITHUB_SOURCE_CHANGED", sourceFile: "files/new.ts" }),
    );
    writeBuildOutput(join(root, "elsewhere/deeper/bundle.github.html"), bundle);
    expect(
        checkSite(root, { only: ["github"], githubOutput: "elsewhere/deeper/bundle.github.html" })
            .diagnostics,
    ).toContainEqual(expect.objectContaining({ code: "GITHUB_REFERENCE_INVALID" }));
});

it("rejects invalid manifests without following paths outside the artifact", async () => {
    const bundle = await buildBundle(root, {
        format: "html",
        target: "github",
        urlPreview: "network",
    });
    writeBuildOutput(join(root, "dist/bundle.github.html"), bundle);
    const path = "dist/bundle.github/dooc-github.json";
    const manifest = JSON.parse(readFileSync(join(root, path), "utf8"));
    manifest.files[0].file = "../outside.txt";
    put(path, JSON.stringify(manifest));
    expect(
        checkSite(root, { only: ["github"], githubOutput: "dist/bundle.github.html" }).diagnostics,
    ).toContainEqual(expect.objectContaining({ code: "GITHUB_OUTPUT_INVALID" }));
    expect(checkSite(root, { only: ["github"] }).exitCode).toBe(2);
});

it("keeps unrelated directories and rolls back companions if installing the HTML fails", async () => {
    const bundle = await buildBundle(root, {
        format: "html",
        target: "github",
        urlPreview: "network",
    });
    put("dist/bundle.github/keep.txt", "Unrelated content");
    expect(() => writeBuildOutput(join(root, "dist/bundle.github.html"), bundle)).toThrow(
        "not a dooc GitHub build",
    );
    expect(readFileSync(join(root, "dist/bundle.github/keep.txt"), "utf8")).toBe(
        "Unrelated content",
    );
    rmSync(join(root, "dist/bundle.github"), { recursive: true });
    writeBuildOutput(join(root, "dist/bundle.github.html"), bundle);
    const before = readFileSync(join(root, "dist/bundle.github/dooc-github.json"));
    mkdirSync(join(root, "dist/occupied.html"));
    expect(() =>
        writeBuildOutput(join(root, "dist/occupied.html"), {
            ...bundle,
            files: [
                ...(bundle.files ?? []),
                { name: "bundle.github/new.txt", data: Buffer.from("New") },
            ],
        }),
    ).toThrow();
    expect(readFileSync(join(root, "dist/bundle.github/dooc-github.json"))).toEqual(before);
    expect(
        checkSite(root, { only: ["github"], githubOutput: "dist/bundle.github.html" }).exitCode,
    ).toBe(0);
});
