import { describe, expect, it } from "vitest";
import { searchIndex, searchSections } from "./search.js";
import type { Entry, Site } from "./serve.js";

const entry = (id: string, title: string, blocks: Entry["blocks"], parent?: string): Entry => ({
    id,
    parent,
    file: `${id}.md`,
    frontmatter: { title },
    lang: "jpn",
    body: "",
    raw: "",
    blocks,
    blockLines: [],
    toc: [],
    errors: [],
});
const site: Site = {
    entries: [
        entry("guide", "Guide", [{ type: "p", text: "API usage" }]),
        entry(
            "api",
            "API",
            [
                { type: "h", level: 2, text: "認証", slug: "auth" },
                { type: "p", text: "ＡＰＩ の [接続設定](https://example.com) と `token` を使う" },
                { type: "h", level: 2, text: "Examples", slug: "examples" },
                { type: "code", filename: "example.ts", lines: ["const secretToken = 'example';"] },
                { type: "term", entry: { id: "key", name: "鍵", definition: "識別するための値" } },
            ],
            "guide",
        ),
    ],
    ctx: { figures: new Map(), terms: [] },
    errors: [],
    languages: [],
    defaultLang: "jpn",
};

describe("document search", () => {
    const index = searchIndex(site);
    it("searches rendered text across pages and links to the matching heading", () => {
        expect(searchSections(index, "接続設定 TOKEN")).toMatchObject([
            { path: "/guide/api", title: "API", heading: "認証", anchor: "auth" },
        ]);
        expect(searchSections(index, "接続設定")[0]?.snippet).toBe(
            "API の 接続設定 と token を使う",
        );
        expect(searchSections(index, "https://example.com")).toEqual([]);
        expect(searchSections(index, "secretToken")[0]?.anchor).toBe("examples");
        expect(searchSections(index, "識別")[0]?.path).toBe("/guide/api");
    });
    it("ranks the current page first, then the best match per other document", () => {
        expect(searchSections(index, "ａｐｉ")[0]).toMatchObject({ title: "API", anchor: "" });
        expect(searchSections(index, "api", "/guide").map((hit) => hit.path)).toEqual([
            "/guide",
            "/guide/api",
        ]);
        expect(searchSections(index, "接続設定", "/guide")[0]?.path).toBe("/guide/api");
        expect(
            searchSections(index, "api", "/guide/api")
                .slice(0, 2)
                .map((hit) => hit.path),
        ).toEqual(["/guide/api", "/guide/api"]);
        expect(searchSections(index, " \t ")).toEqual([]);
        expect(searchSections(index, "missing word")).toEqual([]);
    });
    it("finds filenames and parent folders even when their displayed titles differ", () => {
        expect(searchSections(index, "api.md")[0]).toMatchObject({
            path: "/guide/api",
            file: "api.md",
            folder: false,
        });
        expect(searchSections(index, "/guide")[0]).toMatchObject({ path: "/guide", folder: true });
        const first = index[0];
        if (!first) throw new Error("Missing search fixture");
        const mention = { ...first, text: "See api.md for details" };
        expect(searchSections([mention, ...index.slice(1)], "api.md")[0]?.file).toBe("api.md");
    });
    it("puts a distant match in the excerpt and treats punctuation as literal text", () => {
        const first = index[0];
        if (!first) throw new Error("Missing search fixture");
        const section = { ...first, text: `${"前文 ".repeat(100)}a+b [value] 本文` };
        expect(searchSections([section], "a+b [value]")[0]?.snippet).toContain("a+b [value]");
        expect(searchSections([section], "a+b")[0]?.snippet.startsWith("…")).toBe(true);
    });
});
