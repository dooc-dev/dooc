import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { flattenTree } from "../core/content-metadata.js";
import { createCompiler } from "./compile.js";
import { readFileSync } from "./host.js";
import { readManifest } from "./manifest.js";

vi.mock("./host.js", async (original) => {
    const host = await original<typeof import("./host.js")>();
    return { ...host, readFileSync: vi.fn(host.readFileSync) };
});
const roots: string[] = [];
afterEach(() => {
    vi.clearAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-compile-page-"));
    roots.push(root);
    writeFileSync(
        join(root, "dooc.yaml"),
        "document:\n  title: Guide\n  url: home.md\n  children:\n    - document: { title: Other, url: other.md }\n",
    );
    writeFileSync(
        join(root, "home.md"),
        "# Home\n\n![Selected](selected.svg)\n\n[Other](other.md)\n",
    );
    writeFileSync(join(root, "other.md"), "# Other heading\n\n![Unrelated](unrelated.svg)\n");
    writeFileSync(
        join(root, "selected.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
    );
    writeFileSync(join(root, "unrelated.svg"), "Invalid SVG");
    const pages = flattenTree(readManifest(root).tree);
    const [home, other] = pages;
    if (!home || !other) throw new Error("Expected two fixture pages");
    return { root, pages, home, other, compiler: createCompiler(root) };
};

it("reads selected content and assets while retaining the complete navigation tree", () => {
    const { root, pages, home, other, compiler } = fixture();
    const selected = new Set([home.id]);
    vi.mocked(readFileSync).mockClear();
    const result = compiler.compile(selected);
    const reads = vi.mocked(readFileSync).mock.calls.map(([path]) => String(path));
    expect(reads).toContain(join(root, "home.md"));
    expect(reads).toContain(join(root, "selected.svg"));
    expect(reads).not.toContain(join(root, "other.md"));
    expect(reads).not.toContain(join(root, "unrelated.svg"));
    expect(result.docs.map(({ id }) => id)).toEqual(pages.map(({ id }) => id));
    expect(result.figures.map(({ file }) => file)).toEqual(["selected.svg"]);
    expect(result.errors).toEqual([]);

    const next = compiler.compile(new Set([other.id]));
    expect(next.sources.get("other.md")?.raw).toContain("Other heading");
    expect(next.figures.map(({ file }) => file)).toEqual(["unrelated.svg"]);
    const full = compiler.compile();
    expect(full.sources.get("home.md")?.raw).toContain("# Home");
    expect(full.sources.get("other.md")?.raw).toContain("Other heading");
    expect(full.figures).toHaveLength(2);
    expect(full.errors.some((error) => error.includes("unrelated.svg"))).toBe(true);
});

it("loads linked headings for validation without loading their unrelated assets", () => {
    const { root, home, compiler } = fixture();
    writeFileSync(
        join(root, "home.md"),
        "[Valid](other.md#other-heading)\n\n[Invalid](other.md#missing)\n",
    );
    vi.mocked(readFileSync).mockClear();
    const result = compiler.compile(new Set([home.id]));
    expect(result.sources.get("home.md")?.errors).toEqual([
        'Document link "other.md#missing" refers to a missing heading',
    ]);
    const reads = vi.mocked(readFileSync).mock.calls.map(([path]) => String(path));
    expect(reads).toContain(join(root, "other.md"));
    expect(reads).not.toContain(join(root, "unrelated.svg"));
});
