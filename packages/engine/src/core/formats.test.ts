import { expect, it } from "vitest";
import { parse, parseDocument } from "yaml";
import { parseManifest, serializeManifest } from "./content-metadata.js";
import { fenceFormat, migrateCollections, parseCollections } from "./formats.js";

it("parses reference views and format paths with explicit codeblock selection", () => {
    const input = {
        library: ["urls"],
        format: { ts: { codeblock: false, folders: ["src/"], files: ["demo.ts"] }, svg: {} },
    };
    expect(parseCollections(input)).toEqual({
        libraries: ["urls"],
        formats: { ts: { codeblock: false, folders: ["src"], files: ["demo.ts"] }, svg: {} },
    });
    const manifest = parseManifest({
        system: input,
        document: {
            children: [
                { document: { format: "ts", title: "Code" } },
                { document: { library: "urls" } },
            ],
        },
    });
    expect(manifest.errors).toEqual([]);
    const next = parseManifest(parse(serializeManifest(manifest.tree, manifest)));
    expect(next.formats).toEqual(manifest.formats);
    expect(next.libraries).toEqual(["urls"]);
    expect(next.tree).toEqual(manifest.tree);
    expect(fenceFormat("typescript")).toBe("ts");
    expect(fenceFormat("ts")).toBe("ts");
    expect(fenceFormat("")).toBe("text");
});

it.each([
    { library: ["svg"] },
    { library: ["urls", "urls"] },
    { format: { ".svg": {} } },
    { format: { svg: { unknown: true } } },
    { format: { svg: { codeblock: "false" } } },
    { format: { svg: { files: ["image.png"] } } },
    { format: { ts: { folders: ["../src"] } } },
    { format: { ts: { folders: ["/src"] } } },
    { format: { ts: { folders: ["src", "src/"] } } },
    { format: { ts: { folders: ["src/*"] } } },
    { format: { ts: { files: ["a.ts", "a.ts"] } } },
    { library: { files: ["a.ts"] }, format: { ts: {} } },
])("rejects ambiguous or invalid collection settings: %j", (system) => {
    expect(() => parseCollections(system)).toThrow();
});

it("migrates existing source lists and pages without changing IDs or discarding comments", () => {
    const raw =
        "# Project\nsystem:\n  library:\n    files: # Sources\n      - data.csv # Price list\n      - code.ts\ndocument:\n  children:\n    - document:\n        library: csv # Tables\n        title: Tables\n    - document: {library: urls, title: Links}\n";
    const before = parseManifest(parse(raw));
    expect(before.errors).toEqual([]);
    const yaml = parseDocument(raw);
    expect(migrateCollections(yaml)).toBe(true);
    const next = yaml.toString();
    expect(next).toContain("# Project");
    expect(next).toContain("# Sources");
    expect(next).toContain("# Price list");
    expect(next).toContain("format: csv # Tables");
    expect(parse(next).system).toEqual({
        format: { csv: { files: ["data.csv"] }, ts: { files: ["code.ts"] } },
    });
    expect(parseManifest(parse(next)).tree).toEqual(before.tree);
    expect(migrateCollections(yaml)).toBe(false);
});

it("rejects conflicting page kinds", () => {
    expect(parseManifest({ document: { library: "urls", format: "svg" } }).errors).not.toEqual([]);
    expect(() =>
        migrateCollections(parseDocument("document: {library: svg, format: png}")),
    ).toThrow();
});

it("handles format keys that shadow object properties without mutating prototypes", () => {
    expect(
        parseCollections({ library: { files: ["entry.constructor", "entry.custom_type"] } })
            .formats,
    ).toEqual({
        constructor: { files: ["entry.constructor"] },
        custom_type: { files: ["entry.custom_type"] },
    });
    expect(() => parseCollections({ library: { files: ["entry.__proto__"] } })).toThrow(
        "Unsupported format extension",
    );
    expect(Object.hasOwn(Object, "files")).toBe(false);
    expect(Object.hasOwn(Object.prototype, "files")).toBe(false);
});
