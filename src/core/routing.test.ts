import { describe, expect, it } from "vitest";
import { ancestorsOf, childrenOf, headingAnchor, parseDocLink, parseRoutePath } from "./routing.js";

const docs = [
    { id: "guide" },
    { id: "setup", parent: "guide" },
    { id: "deep", parent: "setup" },
    { id: "reference" },
];

describe("routing", () => {
    it("a route is the single segment `/<docId>` (hierarchy is not exposed in the URL)", () => {
        expect(parseRoutePath("/setup")).toBe("setup");
        expect(parseRoutePath("setup/")).toBe("setup");
        expect(parseRoutePath("/guide/setup")).toBeUndefined();
        expect(parseRoutePath("/Nope")).toBeUndefined();
        expect(parseRoutePath("/")).toBeUndefined();
    });

    it("resolves doc: links to a docId", () => {
        expect(parseDocLink("doc:setup")).toBe("setup");
        expect(parseDocLink("doc:guide/setup")).toBeUndefined();
        expect(parseDocLink("https://example.com")).toBeUndefined();
        expect(parseDocLink("doc:")).toBeUndefined();
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
