import { describe, expect, it } from "vitest";
import { parseManifestText } from "../compiler/manifest.js";
import {
    type DocNode,
    docIdOfFile,
    flattenTree,
    insertDoc,
    moveDoc,
    parseManifest,
    removeDoc,
    renameDoc,
    serializeManifest,
} from "./content-metadata.js";

const n = (id: string, ...children: DocNode[]): DocNode => ({ id, children });
const tree = [n("a", n("b", n("c"))), n("d")];

describe("manifest", () => {
    it("builds a tree from `id` / `{ id: [children] }` / `{ id: null }` and validates id shape and duplicates", () => {
        expect(parseManifest(["a", { b: ["c"] }, { d: null }]).tree).toEqual([
            n("a"),
            n("b", n("c")),
            n("d"),
        ]);
        expect(parseManifest(["Bad", "x", { x: [] }, { p: 1, q: 2 }]).errors).toHaveLength(3);
    });

    it("serializeManifest → parse round-trips (same shape as hand-written)", () => {
        const text = serializeManifest(tree);
        expect(text).toContain("- a:\n    - b:\n        - c\n- d\n");
        expect(parseManifestText(text)).toEqual({ tree, errors: [] });
    });

    it("round-trips a site title with nested or empty docs", () => {
        const title = '資料: "API" & <Guide>';
        for (const docs of [tree, []]) {
            expect(parseManifestText(serializeManifest(docs, { title }))).toEqual({
                tree: docs,
                title,
                errors: [],
            });
        }
        expect(parseManifest({ title: " Guide ", docs: ["a"] })).toEqual({
            tree: [n("a")],
            title: "Guide",
            errors: [],
        });
        expect(parseManifest({ docs: ["a"] })).toEqual({ tree: [n("a")], errors: [] });
    });

    it.each([
        { icon: "../logo.svg", docs: [] },
        { icon: "/logo.svg", docs: [] },
        { icon: "https://example.com/logo.svg", docs: [] },
        { icon: "logo.png", docs: [] },
        { icon: 42, docs: [] },
        { defaultLang: "日本語", docs: [] },
        { defaultLang: "", docs: [] },
        { defaultLang: 42, docs: [] },
        { defaultLang: null, docs: [] },
        { title: " ", docs: [] },
        { title: 42, docs: [] },
        { title: null, docs: [] },
        { title: "Guide" },
        { title: "Guide", docs: "a" },
        { title: "Guide", docs: [], extra: true },
    ])("rejects malformed site metadata: %j", (value) => {
        expect(parseManifest(value).errors.length).toBeGreaterThan(0);
    });

    it("round-trips a file-based site icon with or without a title", () => {
        for (const title of [undefined, "Guide"]) {
            expect(
                parseManifestText(serializeManifest(tree, { title, icon: "icons/logo.svg" })),
            ).toEqual({
                tree,
                ...(title ? { title } : {}),
                icon: "icons/logo.svg",
                errors: [],
            });
        }
    });

    it.each([
        "logo.svg",
        "files/svg/logo.svg",
    ])("accepts icons in any project folder: %s", (icon) => {
        expect(parseManifest({ icon, docs: [] }).errors).toEqual([]);
    });

    it("round-trips defaultLang without other site metadata", () => {
        for (const defaultLang of ["jpn", "en", "pt-BR"]) {
            expect(parseManifestText(serializeManifest(tree, { defaultLang }))).toEqual({
                tree,
                defaultLang,
                errors: [],
            });
        }
    });

    it("flattenTree yields pre-order + parent + depth", () => {
        expect(flattenTree(tree)).toEqual([
            { id: "a", depth: 0 },
            { id: "b", parent: "a", depth: 1 },
            { id: "c", parent: "b", depth: 2 },
            { id: "d", depth: 0 },
        ]);
    });

    it("docIdOfFile accepts only <id>.md directly under content/", () => {
        expect(docIdOfFile("setup.md")).toBe("setup");
        expect(docIdOfFile("../x.md")).toBeUndefined();
        expect(docIdOfFile("Setup.md")).toBeUndefined();
        expect(docIdOfFile("x.txt")).toBeUndefined();
    });
});

describe("tree operations (input is not mutated)", () => {
    it("insertDoc: appends to parent's children / top level; duplicate or missing parent gives undefined", () => {
        expect(insertDoc(tree, "e", "b")?.[0]?.children[0]?.children.map((c) => c.id)).toEqual([
            "c",
            "e",
        ]);
        expect(insertDoc(tree, "e")?.map((c) => c.id)).toEqual(["a", "d", "e"]);
        expect(insertDoc(tree, "c")).toBeUndefined();
        expect(insertDoc(tree, "e", "zzz")).toBeUndefined();
        expect(tree[0]?.children[0]?.children).toHaveLength(1);
    });

    it("moveDoc: moves with children to another parent; cannot move under itself / a descendant", () => {
        expect(moveDoc(tree, "b", undefined, 1)).toEqual([n("a"), n("b", n("c")), n("d")]);
        expect(moveDoc(tree, "d", "c", 0)).toEqual([n("a", n("b", n("c", n("d"))))]);
        expect(moveDoc(tree, "a", "c", 0)).toBeUndefined();
        expect(moveDoc(tree, "a", "a", 0)).toBeUndefined();
        expect(moveDoc(tree, "d", undefined, 5)).toBeUndefined();
    });

    it("removeDoc only removes childless docs / renameDoc keeps position and children", () => {
        expect(removeDoc(tree, "c")).toEqual([n("a", n("b")), n("d")]);
        expect(removeDoc(tree, "a")).toBeUndefined();
        expect(renameDoc(tree, "b", "x")).toEqual([n("a", n("x", n("c"))), n("d")]);
        expect(renameDoc(tree, "b", "d")).toBeUndefined();
    });
});
