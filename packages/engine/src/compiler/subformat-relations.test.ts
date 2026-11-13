import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { flattenTree, libraryPageId } from "../core/content-metadata.js";
import { blocksHtml } from "../core/html.js";
import { readManifest } from "./manifest.js";
import { createDocOps } from "./ops.js";
import { loadSubformat, subformatRelations, subformatResponse } from "./subformats.js";

test("derives subformat relations from schema references", () => {
    const root = resolve(import.meta.dirname, "../../../../dooc-docs");
    const model = subformatRelations(root, readManifest(root).subformats ?? []);
    const edges = model.edges.map(({ from, field, to, list }) =>
        [from, field, to, list ? "[]" : ""].join(" "),
    );
    // Direct cross-file ref, ref through a shared definition, and a self reference by pattern.
    expect(edges).toContain("container network vpc ");
    expect(edges).toContain("container depends_on datastore []");
    expect(edges).toContain("container depends_on container []");
    expect(edges).toContain("vpc peers vpc []");
    expect(edges).toContain("loadbalancer listeners container []");
    expect(edges).not.toContain("container image container ");
    expect(blocksHtml([{ type: "schemaGraph", graph: model }])).toContain("<svg");
});

test("offers record files for reference fields and saves the chosen one", () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-ref-"));
    cpSync(resolve(import.meta.dirname, "../../../../dooc-docs"), root, { recursive: true });
    const config = readManifest(root).subformats?.find((item) => item.ext === "container");
    if (!config) throw new Error("container subformat missing");
    const network = loadSubformat(root, config).fields.find((field) => field.name === "network");
    expect(network?.options).toContain("contents/vpc/staging-cloud.vpc");
    const file = "contents/container/api.container";
    const base = readFileSync(join(root, file), "utf8");
    const save = (value: string) =>
        subformatResponse(root, { file, base, field: "network", value });
    expect(save("contents/vpc/missing.vpc").status).toBe(400);
    const saved = save("contents/vpc/staging-cloud.vpc");
    expect(saved.status).toBe(200);
    expect(saved.body.data?.network).toBe("contents/vpc/staging-cloud.vpc");
});

test("keeps library pages through a manifest round trip", () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-lib-"));
    cpSync(resolve(import.meta.dirname, "../../../../dooc-docs"), root, { recursive: true });
    const ops = createDocOps(root);
    expect(ops.addLibrary("schemath", "Schemas")).toEqual({ id: libraryPageId("schemath") });
    expect(ops.addLibrary("Not A View", "x")).toMatchObject({ status: 400 });
    const manifest = readManifest(root);
    expect(manifest.errors).toEqual([]);
    expect(flattenTree(manifest.tree).find((node) => node.library === "schemath")).toMatchObject({
        library: "schemath",
        title: "Schemas",
    });
    expect(readFileSync(join(root, "dooc.yaml"), "utf8")).toContain("- library: schemath");
});
