import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { siteTitleResponse } from "./site-title.js";

const roots: string[] = [];
const fixture = (raw = "# Keep this\ntitle: Original\ndefaultLang: eng\ndocs: []\n") => {
    const root = mkdtempSync(join(tmpdir(), "dooc-title-"));
    roots.push(root);
    writeFileSync(join(root, "dooc.yaml"), raw);
    return root;
};
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("updates only the manifest title and rejects stale edits", () => {
    const root = fixture();
    expect(siteTitleResponse(root, { title: "  資料 <Title>  ", baseTitle: "Original" })).toEqual({
        status: 200,
        body: { title: "資料 <Title>" },
    });
    const raw = readFileSync(join(root, "dooc.yaml"), "utf8");
    expect(raw).toContain("# Keep this");
    expect(parse(raw)).toEqual({ title: "資料 <Title>", defaultLang: "eng", docs: [] });
    expect(siteTitleResponse(root, { title: "Stale", baseTitle: "Original" }).status).toBe(409);
    expect(readFileSync(join(root, "dooc.yaml"), "utf8")).toBe(raw);
});

it("supports a list manifest and preserves its documents", () => {
    const root = fixture("- guide\n");
    expect(siteTitleResponse(root, { title: "Guide", baseTitle: null }).status).toBe(200);
    expect(parse(readFileSync(join(root, "dooc.yaml"), "utf8"))).toEqual({
        docs: ["guide"],
        title: "Guide",
    });
});

it("rejects invalid titles, malformed manifests and paths outside the project", () => {
    const root = fixture();
    const raw = readFileSync(join(root, "dooc.yaml"), "utf8");
    for (const title of ["", "  ", "x".repeat(257), "two\nlines", 7, null])
        expect(siteTitleResponse(root, { title, baseTitle: "Original" }).status).toBe(400);
    expect(siteTitleResponse(root, { title: "No base" }).status).toBe(400);
    expect(readFileSync(join(root, "dooc.yaml"), "utf8")).toBe(raw);
    writeFileSync(join(root, "dooc.yaml"), "title: []\ndocs: []\n");
    expect(siteTitleResponse(root, { title: "New", baseTitle: null }).status).toBe(409);
    const outside = fixture();
    rmSync(join(root, "dooc.yaml"));
    symlinkSync(join(outside, "dooc.yaml"), join(root, "dooc.yaml"));
    expect(siteTitleResponse(root, { title: "Outside", baseTitle: "Original" }).status).toBe(400);
    expect(readFileSync(join(outside, "dooc.yaml"), "utf8")).toBe(raw);
});
