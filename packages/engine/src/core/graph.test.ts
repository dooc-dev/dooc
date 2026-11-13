import { describe, expect, it } from "vitest";
import {
    GRAPH_FRAME_LABEL_H,
    GRAPH_FRAME_PAD,
    GRAPH_LAYOUT_MARGIN,
    GRAPH_LEGEND,
    type GraphLayout,
    type GraphLayoutRegion,
    graphUid,
    layoutGraph,
    parseGraphSource,
} from "./graph.js";
import { textW } from "./graph-common.js";

const SRC = [
    "# Output processing flow (this line is a note = not drawn)",
    "[input]: Input @Ingest",
    "[pre-process]: Preprocessor @Ingest",
    "[worker]: Worker @Processing",
    "[output]: Output @Delivery",
    "[validator]: Validator",
    "",
    "[input] -> [pre-process] -> [worker] -> [output]",
    "[worker] --> [validator]: input validation",
].join("\n");

const messages = (source: string): string[] =>
    parseGraphSource(source).errors.map((e) => e.message);

const overlaps = (
    a: Pick<GraphLayoutRegion, "x" | "y" | "w" | "h">,
    b: Pick<GraphLayoutRegion, "x" | "y" | "w" | "h">,
): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("parseGraphSource", () => {
    it("reads node declarations / regions / edges and drops notes (#) and blank lines", () => {
        const { model, errors } = parseGraphSource(SRC);
        expect(errors).toEqual([]);
        expect(model.nodes.map((n) => n.id)).toEqual([
            "input",
            "pre-process",
            "worker",
            "output",
            "validator",
        ]);
        expect(model.nodes[0]).toEqual({ id: "input", label: "Input", region: "Ingest" });
        // a node without a region has no region key
        expect(model.nodes[4]).toEqual({ id: "validator", label: "Validator" });
        // chains expand into individual edges, each with its label and kind
        expect(model.edges).toEqual([
            { from: "input", to: "pre-process", kind: "solid" },
            { from: "pre-process", to: "worker", kind: "solid" },
            { from: "worker", to: "output", kind: "solid" },
            { from: "worker", to: "validator", kind: "dashed", label: "input validation" },
        ]);
    });

    it("ids may use any characters inside `[...]` (hyphenated real names can be written as-is)", () => {
        const { model, errors } = parseGraphSource(
            ["[web-app-v2]: Web App @view", "[api-gateway]", "[web-app-v2] -> [api-gateway]"].join(
                "\n",
            ),
        );
        expect(errors).toEqual([]);
        expect(model.nodes.map((n) => n.id)).toEqual(["web-app-v2", "api-gateway"]);
        // label omitted = the id is used as the display name
        expect(model.nodes[1]?.label).toBe("api-gateway");
        expect(model.edges[0]).toEqual({
            from: "web-app-v2",
            to: "api-gateway",
            kind: "solid",
        });
    });

    it("regions form groups in first-appearance order; a node without a region becomes a frameless group of its own", () => {
        const { model } = parseGraphSource(SRC);
        expect(model.regions).toEqual([
            { label: "Ingest", nodes: ["input", "pre-process"] },
            { label: "Processing", nodes: ["worker"] },
            { label: "Delivery", nodes: ["output"] },
            { nodes: ["validator"] },
        ]);
        // groups partition all nodes (every node belongs to exactly one group)
        expect(model.regions.flatMap((r) => r.nodes).sort()).toEqual(
            model.nodes.map((n) => n.id).sort(),
        );
    });

    it("the 3 edge kinds can be written, and whitespace around arrows is optional", () => {
        const { model, errors } = parseGraphSource(
            ["[a] @g", "[b]", "[c]", "[a] -> [b]", "[b]-->[c]", "[a] -- [c]"].join("\n"),
        );
        expect(errors).toEqual([]);
        expect(model.nodes.map((n) => n.label)).toEqual(["a", "b", "c"]);
        expect(model.edges.map((e) => e.kind)).toEqual(["solid", "dashed", "undirected"]);
    });

    it("undeclared node / duplicate declaration / self loop / duplicate edge are errors (= not distributable)", () => {
        expect(messages("[a]\n[a] -> [b]")).toEqual(['edge node "b" is not declared']);
        // declarations may come after the edge (matched after all lines are read)
        expect(messages("[a] -> [b]\n[a]\n[b]")).toEqual([]);
        expect(messages("[a]\n[a]: Alias")).toEqual(['node "a" is declared twice']);
        expect(messages("[a]\n[a] -> [a]")).toEqual(['edge to itself ("a") cannot be drawn']);
        expect(messages("[a]\n[b]\n[a] -> [b]\n[a] -> [b]")).toEqual([
            'edge between "a" and "b" is declared twice',
        ]);
        // undirected edges have no direction, so [a] -- [b] and [b] -- [a] are the same edge
        expect(messages("[a]\n[b]\n[a] -- [b]\n[b] -- [a]")).toEqual([
            'edge between "b" and "a" is declared twice',
        ]);
    });

    it("missing brackets / empty label / empty id / fence / chain label are errors", () => {
        expect(messages("input: Input")[0]).toContain("node declaration");
        expect(messages("[a]\n[b]\na -> b")[0]).toContain("is neither");
        expect(messages("[a] junk")[0]).toContain("is neither");
        expect(messages("[a]\n[b]\n[a] -> b")[0]).toContain("is neither");
        expect(messages("[a]:")[0]).toContain("has an empty label");
        expect(messages("[]")[0]).toContain("node id is empty");
        expect(messages("[a]\n[b]\n[a] -> [b]:")[0]).toContain("edge label is empty");
        expect(messages("```\n[a]\n```")[0]).toContain("``` is not allowed");
        expect(messages("[a]\n[b]\n[c]\n[a] -> [b] -> [c]: label")[0]).toContain(
            "a chain (`[a] -> [b] -> [c]`) cannot have a label",
        );
        // the chain's edges themselves (without the label) can be drawn = a partial result is
        // returned even with errors
        expect(
            parseGraphSource("[a]\n[b]\n[c]\n[a] -> [b] -> [c]: label").model.edges,
        ).toHaveLength(2);
    });

    it("error line numbers are relative to the DSL (dialect maps them to doc line numbers)", () => {
        expect(parseGraphSource("[a]\n\n[b]\n[a] -> [zzz]").errors).toEqual([
            { line: 3, message: 'edge node "zzz" is not declared' },
        ]);
    });
});

describe("layoutGraph", () => {
    const { model } = parseGraphSource(SRC);
    const layout: GraphLayout = layoutGraph(model);
    const nodeOf = (id: string): GraphLayout["nodes"][number] => {
        const n = layout.nodes.find((x) => x.id === id);
        if (n == null) {
            throw new Error(`node ${id} is not in the layout`);
        }
        return n;
    };
    const regionOf = (label: string): GraphLayoutRegion => {
        const r = layout.regions.find((x) => x.label === label);
        if (r == null) {
            throw new Error(`region ${label} is not in the layout`);
        }
        return r;
    };

    it("Dagre lays out directed edges left → right", () => {
        expect(regionOf("Ingest").x).toBeLessThan(regionOf("Processing").x);
        expect(regionOf("Processing").x).toBeLessThan(regionOf("Delivery").x);
        // the same rankdir applies inside compound regions
        expect(nodeOf("input").x).toBeLessThan(nodeOf("pre-process").x);
    });

    it("nodes placed by Dagre don't overlap each other", () => {
        for (const a of layout.nodes) {
            for (const b of layout.nodes) {
                if (a !== b) {
                    expect(overlaps(a, b)).toBe(false);
                }
            }
        }
    });

    it("frames appear only for labeled regions and don't overlap each other", () => {
        expect(layout.regions.map((r) => r.label)).toEqual(["Ingest", "Processing", "Delivery"]);
        for (const a of layout.regions) {
            for (const b of layout.regions) {
                if (a !== b) {
                    expect(overlaps(a, b)).toBe(false);
                }
            }
        }
    });

    it("frames contain their member nodes, and the label area doesn't collide with the group above", () => {
        for (const region of layout.regions) {
            for (const id of region.members) {
                const n = nodeOf(id);
                expect(n.x).toBeGreaterThanOrEqual(region.x);
                expect(n.y).toBeGreaterThanOrEqual(region.y);
                expect(n.x + n.w).toBeLessThanOrEqual(region.x + region.w);
                expect(n.y + n.h).toBeLessThanOrEqual(region.y + region.h);
            }
            expect(region.y - GRAPH_FRAME_LABEL_H + GRAPH_FRAME_PAD).toBeGreaterThan(0);
        }
    });

    it("every edge has a path, and the canvas contains all nodes", () => {
        expect(layout.edges).toHaveLength(4);
        for (const e of layout.edges) {
            expect(e.d).toMatch(/^M/);
            expect(layout.nodes.some((n) => n.index === e.from)).toBe(true);
            expect(layout.nodes.some((n) => n.index === e.to)).toBe(true);
        }
        // labeled edges also have label coordinates
        const labeled = layout.edges.find((e) => e.label != null);
        expect(labeled?.labelX).toBeGreaterThan(0);
        expect(labeled?.labelY).toBeGreaterThan(0);
        for (const n of layout.nodes) {
            expect(n.x + n.w).toBeLessThanOrEqual(layout.width);
            expect(n.y + n.h).toBeLessThanOrEqual(layout.height);
        }
        // dashed / undirected edges are present, so the legend is shown
        expect(layout.legendY).toBeGreaterThan(0);
    });

    it("a solid-only graph shows no legend", () => {
        const only = layoutGraph(parseGraphSource("[a]\n[b]\n[a] -> [b]").model);
        expect(only.legendY).toBeUndefined();
    });

    it("a graph with a legend always gets enough width not to cut off the text (even with few nodes)", () => {
        const narrow = layoutGraph(parseGraphSource("[a]\n[b]\n[a] --> [b]").model);
        expect(narrow.legendY).toBeGreaterThan(0);
        // never narrower than the estimated width at 10.5px + left/right margins
        expect(narrow.width).toBeGreaterThanOrEqual(
            Math.ceil(GRAPH_LAYOUT_MARGIN * 2 + textW(GRAPH_LEGEND, 10.5 / 12)),
        );
    });

    it("the same model always yields the same coordinates / uid (build reproducibility)", () => {
        expect(layoutGraph(model)).toEqual(layout);
        expect(graphUid(model)).toBe(graphUid(parseGraphSource(SRC).model));
        expect(graphUid(model)).not.toBe(graphUid(parseGraphSource("[a]\n[b]\n[a] -> [b]").model));
    });

    it("cycles are cut off deterministically (bands don't diverge)", () => {
        const cyclic = parseGraphSource(
            ["[a]: A @x", "[b]: B @y", "[a] -> [b]", "[b] -> [a]"].join("\n"),
        ).model;
        const out = layoutGraph(cyclic);
        expect(out.regions).toHaveLength(2);
        expect(out.edges).toHaveLength(2);
        expect(Number.isFinite(out.width)).toBe(true);
    });
});
