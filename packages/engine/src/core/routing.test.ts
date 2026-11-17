import { describe, expect, it } from "vitest";
import { fileDocumentId } from "./files.js";
import {
    ancestorsOf,
    childrenOf,
    docHref,
    docPath,
    documentPathErrors,
    headingAnchor,
    isReferenceUrl,
    parseDocLink,
    parseRoutePath,
    resolveDocPath,
} from "./routing.js";

const docs = [
    { id: "guide" },
    { id: "setup", parent: "guide" },
    { id: "deep", parent: "setup" },
    { id: "reference" },
];

it("keeps inline Web routes separate from jump targets through aliases and redirects", () => {
    const pages = [
        { id: "home", root: true, url: "redirect:first" },
        { id: "shortcut", parent: "home", url: "/site" },
        { id: "site", parent: "home", url: "https://example.com/?a=1&b=2" },
    ];
    for (const { id } of pages) {
        expect(docHref(pages, id)).toBe("https://example.com/?a=1&b=2");
        expect(docHref(pages, id, true)).toBe("/site");
    }
});

describe("routing", () => {
    it("allows reference URLs and rejects executable protocols after browser normalization", () => {
        for (const url of [
            "content/setup.md#details",
            "#section",
            "/guide",
            "//example.com/docs",
            "http://example.com",
            "https://example.com",
            "mailto:reader@example.com",
        ])
            expect(isReferenceUrl(url), url).toBe(true);
        for (const url of [
            "javascript:alert(1)",
            "JaVaScRiPt:alert(1)",
            "\u0000 javascript:alert(1)\n",
            "java\tscr\r\nipt:alert(1)",
            "data:text/html,test",
            "vbscript:msgbox(1)",
            "file:///etc/passwd",
            "blob:https://example.com/id",
            "https://[",
        ])
            expect(isReferenceUrl(url), url).toBe(false);
    });

    it("a route is the single segment `/<docId>` (hierarchy is not exposed in the URL)", () => {
        expect(parseRoutePath("/setup")).toBe("setup");
        expect(parseRoutePath("setup/")).toBe("setup");
        expect(parseRoutePath("/guide/setup")).toBeUndefined();
        expect(parseRoutePath("/Nope")).toBeUndefined();
        expect(parseRoutePath("/")).toBeUndefined();
    });

    it("parses document files and heading fragments, excluding other URLs", () => {
        expect(parseDocLink("./content/setup.md#details")).toEqual({
            file: "content/setup.md",
            fragment: "details",
        });
        expect(parseDocLink("files/md/%E6%97%A5%E6%9C%AC%E8%AA%9E.md")).toEqual({
            file: "files/md/日本語.md",
            fragment: "",
        });
        expect(parseDocLink("https://example.com/setup.md")).toBeUndefined();
        expect(parseDocLink("doc:setup")).toBeUndefined();
        expect(() => parseDocLink("../private.md")).toThrow("inside the docs root");
        expect(() => parseDocLink("content/setup.md?x=1")).toThrow("query");
    });

    it("walks the tree with childrenOf / ancestorsOf (keeping input order)", () => {
        expect(childrenOf(docs).map((d) => d.id)).toEqual(["guide", "reference"]);
        expect(childrenOf(docs, "guide").map((d) => d.id)).toEqual(["setup"]);
        expect(ancestorsOf(docs, "deep").map((d) => d.id)).toEqual(["guide", "setup"]);
        expect(ancestorsOf(docs, "guide")).toEqual([]);
    });

    it("heading anchors are namespaced by doc id", () => {
        expect(headingAnchor("api-overview", "cicd")).toBe("api-overview__cicd");
    });
});

it("keeps hierarchy paths separate from heading fragments and rejects old aliases", () => {
    expect(docPath(docs, "deep")).toBe("/guide/setup/deep");
    expect(resolveDocPath(docs, "/guide/setup/deep")).toBe("deep");
    expect(resolveDocPath(docs, "/deep")).toBeUndefined();
    expect(resolveDocPath(docs, "/guide")).toBe("guide");
    expect(resolveDocPath(docs, "/reference/deep")).toBeUndefined();
    expect(resolveDocPath(docs, "/guide/setup/deep#heading")).toBeUndefined();
    expect(resolveDocPath(docs, "/unknown")).toBeUndefined();
});

it("uses file stems in manifest order without exposing source directories or internal IDs", () => {
    const parent = { id: fileDocumentId("contents/md/guide.md"), file: "contents/md/guide.md" };
    const child = {
        id: fileDocumentId("other/start.md"),
        sourceFile: "other/start.md",
        file: "internal.md",
        parent: parent.id,
    };
    const pages = [parent, child];
    expect(docPath(pages, parent.id)).toBe("/guide");
    expect(docPath(pages, child.id)).toBe("/guide/start");
    expect(resolveDocPath(pages, "/guide/start")).toBe(child.id);
    expect(resolveDocPath(pages, "/start")).toBeUndefined();
    expect(resolveDocPath(pages, "/_docs/other/start.md")).toBeUndefined();
    expect(
        docPath(
            [{ ...parent, file: "moved/guide.md", id: fileDocumentId("moved/guide.md") }],
            fileDocumentId("moved/guide.md"),
        ),
    ).toBe("/guide");
});

it("uses declared Library and subformat names as hierarchy segments", () => {
    const pages = [
        { id: "reference" },
        { id: "library-internal", library: "termth", parent: "reference" },
        { id: "board-internal", subformat: { ext: "issue" }, parent: "reference" },
        { id: "notes", parent: "board-internal" },
    ];
    expect(docPath(pages, "library-internal")).toBe("/reference/termth");
    expect(docPath(pages, "board-internal")).toBe("/reference/issue");
    expect(docPath(pages, "notes")).toBe("/reference/issue/notes");
    expect(resolveDocPath(pages, "/reference/issue/notes")).toBe("notes");
});

it("encodes Unicode, spaces and literal percent signs exactly once", () => {
    const pages = ["日本語 %", "a b", "a%20b"].map((name) => ({
        id: fileDocumentId(`contents/${name}.md`),
        file: `contents/${name}.md`,
    }));
    for (const [index, name] of ["日本語 %", "a b", "a%20b"].entries()) {
        const id = pages[index]?.id ?? "";
        const path = `/${encodeURIComponent(name)}`;
        expect(docPath(pages, id)).toBe(path);
        expect(resolveDocPath(pages, new URL(path, "https://dooc.invalid").pathname)).toBe(id);
    }
});

it("detects sibling path collisions and reserved roots without choosing an arbitrary page", () => {
    const pages = ["one/start.md", "two/start.md"].map((file) => ({
        id: fileDocumentId(file),
        file,
    }));
    expect(documentPathErrors(pages)).toEqual(["Duplicate page path: /start"]);
    expect(resolveDocPath(pages, "/start")).toBeUndefined();
    expect(
        documentPathErrors(
            pages.map((page, index) => (index ? { ...page, parent: pages[0]?.id } : page)),
        ),
    ).toEqual([]);
    for (const name of ["_files", "_git", "api", "assets"]) {
        const page = { id: fileDocumentId(`${name}.md`), file: `${name}.md` };
        expect(documentPathErrors([page])[0]).toContain(`Reserved page path: /${name}`);
        expect(documentPathErrors([{ id: "guide" }, { ...page, parent: "guide" }])).toEqual([]);
    }
});
