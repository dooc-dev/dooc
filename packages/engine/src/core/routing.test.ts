import { describe, expect, it } from "vitest";
import {
    ancestorsOf,
    childrenOf,
    docPath,
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
