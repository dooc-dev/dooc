// SoT for the content dialect `:::graph` (node / edge DSL) — DSL parsing / graph model /
// deterministic layout. Browser-safe. html.ts owns the markup (SVG); this module returns only the
// semantics and the geometry computed with Dagre (= every consumer gets the same picture via
// docHtml).
//
// DSL (written directly between `:::graph` and `:::`; the content isn't parsed as markdown = no
// fence needed):
//     [<id>]: <label> @<region>   node declaration (label / region optional; one region per node)
//     [<id>] @<region>            label omitted = the id is displayed as-is
//     [a] -> [b]                  edge (solid, directed = dependency / flow)
//     [a] --> [b]                 edge (dashed, directed = optional / async)
//     [a] -- [b]                  edge (undirected = no arrow)
//     [a] -> [b] -> [c]           chain (expands to 2 edges; can't take a label)
//     [a] -> [b]: <label>         edge label (faint text beside the line)
//     # <text>                    comment (leading `#`; not rendered)
//
// **Ids are always wrapped in `[...]`**. The brackets are the delimiter, so an id may contain any
// character except `]` (hyphenated real names like `[web-app-v2]` can be written as-is).
// Whitespace around arrows is optional. A region is a single tag attached to a node and needs no
// declaration line (frames appear in order of first occurrence). The frame label is the region
// name itself (Japanese allowed, no whitespace). A node without a region becomes a standalone
// group with no frame (= `model.regions` partitions all nodes). References to undeclared nodes /
// duplicate declarations / self-loops / lines readable as neither node nor edge are all
// validation errors (= cannot be distributed) (picked up by dialect.ts).
//
// Placement (SoT for layoutGraph): regions go into Dagre's compound graph as parents and nodes as
// children. Directed edges flow left→right (`rankdir: LR`); region frames use the parent bounds
// computed by Dagre as-is. Undirected edges have no rank, so they are left out of the layout input
// and drawn between the placed nodes by our own router (routeGraphEdges).
import {
    type EdgeLabel as DagreEdgeLabel,
    type GraphLabel as DagreGraphLabel,
    type NodeLabel as DagreNodeLabel,
    default as dagre,
} from "@dagrejs/dagre";
import { hashId, orthPath, round1, textW } from "./graph-common.js";

/** Edge kind = line style. solid / dashed are directed (with arrow); undirected has no arrow. */
export const GRAPH_EDGE_KINDS = ["solid", "dashed", "undirected"] as const;
export type GraphEdgeKind = (typeof GRAPH_EDGE_KINDS)[number];

/** A single node. If label is omitted, the id is used as the label. No region = not in a frame. */
export interface GraphNode {
    id: string;
    label: string;
    region?: string;
}

export interface GraphEdge {
    from: string;
    to: string;
    kind: GraphEdgeKind;
    label?: string;
}

/**
 * Group = one frame. With label = a region (the nodes tagged with that name; drawn as a dashed
 * frame + heading); without label = a standalone group of one node that has no region (no frame
 * drawn). regions partitions all nodes, ordered by first occurrence in the source (= vertical
 * stacking order within a band).
 */
export interface GraphRegion {
    label?: string;
    nodes: string[];
}

export interface GraphModel {
    nodes: GraphNode[];
    edges: GraphEdge[];
    regions: GraphRegion[];
}

/** Error with a DSL line number (0-indexed, relative to the start of the DSL). */
export interface GraphParseError {
    line: number;
    message: string;
}

export interface GraphParseResult {
    model: GraphModel;
    errors: GraphParseError[];
}

// Node ids are always wrapped in `[...]` (= the brackets are the delimiter, so the content may be
// any character except `[` `]`; hyphenated real names like `[web-app-v2]` can be written as-is).
const NODE_ID = /^\[([^[\]\n]*)\]/;
// Arrow (placed right after an id). The brackets pin down the id, so surrounding whitespace is
// optional. `-->` is listed before `->`/`--` (longest match).
const ARROW = /^(-->|->|--)/;
// Trailing region (`... @<region>`). Whitespace is required before `@`, so `a@b` inside a label
// isn't matched.
const REGION = /\s+@(\S+)\s*$/;

/** Explains in one sentence why a line couldn't be read (always shows the full syntax). */
const UNREADABLE = (text: string): string =>
    `"${text}" is neither a node declaration ("[<id>]: <label> @<region>") nor an edge ("[a] -> [b]") (notes start with "#")`;

const EDGE_KIND: Record<string, GraphEdgeKind> = {
    "->": "solid",
    "-->": "dashed",
    "--": "undirected",
};

/** Edge dedup key. Undirected edges have no direction, so the ids are sorted to equate them. */
const edgeKey = (e: GraphEdge): string =>
    e.kind === "undirected" ? `${[e.from, e.to].sort().join("|")}|u` : `${e.from}|${e.to}`;

/**
 * Node / edge DSL → graph model + errors. The model is returned as a partial result even when
 * there are errors (so the preview can show "validation errors + as much as can be drawn" at once).
 */
export const parseGraphSource = (source: string): GraphParseResult => {
    const errors: GraphParseError[] = [];
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const regions: GraphRegion[] = [];
    const regionIndex = new Map<string, number>();
    const declared = new Set<string>();
    // Edges may reference nodes before they are declared, so existence is checked after all lines
    // have been read.
    const edgeLine: number[] = [];
    const seenEdge = new Map<string, number>();

    const err = (line: number, message: string): void => {
        errors.push({ line, message });
    };

    const declare = (line: number, id: string, label: string, region?: string): void => {
        if (declared.has(id)) {
            err(line, `node "${id}" is declared twice`);
            return;
        }
        declared.add(id);
        nodes.push({ id, label, ...(region == null ? {} : { region }) });
        if (region == null) {
            regions.push({ nodes: [id] });
            return;
        }
        let ri = regionIndex.get(region);
        if (ri == null) {
            ri = regions.length;
            regions.push({ label: region, nodes: [] });
            regionIndex.set(region, ri);
        }
        regions[ri]?.nodes.push(id);
    };

    source.split("\n").forEach((raw, line) => {
        const text = raw.trim();
        if (text === "" || text.startsWith("#")) {
            return;
        }
        if (text.startsWith("```")) {
            err(line, "``` is not allowed (write nodes / edges directly inside :::graph)");
            return;
        }

        // Every line starts with `[<id>]`. If an arrow follows immediately it's an edge; anything
        // else (end of line / ":" / "@") is a node declaration — the brackets already pin down the
        // id, so this one character decides the branch.
        const head = NODE_ID.exec(text);
        if (head == null) {
            err(line, UNREADABLE(text));
            return;
        }
        const headId = (head[1] ?? "").trim();
        const tail = text.slice(head[0].length);

        // ---- edge line ----
        if (ARROW.test(tail.trimStart())) {
            const ids = [headId];
            const arrows: string[] = [];
            let label: string | undefined;
            let cursor = tail.trimStart();
            while (cursor !== "") {
                const arrow = ARROW.exec(cursor);
                if (arrow != null) {
                    arrows.push(arrow[1] ?? "");
                    cursor = cursor.slice(arrow[0].length).trimStart();
                    const next = NODE_ID.exec(cursor);
                    if (next == null) {
                        err(line, UNREADABLE(text));
                        return;
                    }
                    ids.push((next[1] ?? "").trim());
                    cursor = cursor.slice(next[0].length).trimStart();
                    continue;
                }
                if (cursor.startsWith(":")) {
                    label = cursor.slice(1).trim();
                    break;
                }
                err(line, UNREADABLE(text));
                return;
            }
            if (label === "") {
                err(line, "edge label is empty (`[a] -> [b]: <label>`)");
            }
            if (label != null && label !== "" && arrows.length > 1) {
                err(
                    line,
                    "a chain (`[a] -> [b] -> [c]`) cannot have a label (write each edge separately)",
                );
            }
            if (ids.some((id) => id === "")) {
                err(line, "node id is empty (`[]` is not allowed)");
                return;
            }
            arrows.forEach((arrow, k) => {
                const from = ids[k];
                const to = ids[k + 1];
                const kind = EDGE_KIND[arrow];
                if (from == null || to == null || kind == null) {
                    return;
                }
                if (from === to) {
                    err(line, `edge to itself ("${from}") cannot be drawn`);
                    return;
                }
                const edge: GraphEdge = {
                    from,
                    to,
                    kind,
                    ...(label == null || label === "" || arrows.length > 1 ? {} : { label }),
                };
                const key = edgeKey(edge);
                if (seenEdge.has(key)) {
                    err(line, `edge between "${from}" and "${to}" is declared twice`);
                    return;
                }
                seenEdge.set(key, edges.length);
                edges.push(edge);
                edgeLine.push(line);
            });
            return;
        }

        // ---- node declaration line ----
        const region = REGION.exec(tail)?.[1];
        const rest = (region == null ? tail : tail.replace(REGION, "")).trim();
        if (rest !== "" && !rest.startsWith(":")) {
            err(line, UNREADABLE(text));
            return;
        }
        if (headId === "") {
            err(line, "node id is empty (`[]` is not allowed)");
            return;
        }
        const label = rest === "" ? headId : rest.slice(1).trim();
        if (label === "") {
            err(line, `node "${headId}" has an empty label (omit the ":" too for no label)`);
            return;
        }
        declare(line, headId, label, region);
    });

    edges.forEach((e, i) => {
        const line = edgeLine[i] ?? 0;
        for (const id of [e.from, e.to]) {
            if (!declared.has(id)) {
                err(line, `edge node "${id}" is not declared`);
            }
        }
    });

    return { model: { nodes, edges, regions }, errors };
};

/** model → deterministic short id (namespace for SVG classes / marker ids). */
export const graphUid = (model: GraphModel): string => hashId(JSON.stringify(model));

/* ---------------------------------------------------------------- layout ---- */

export interface GraphLayoutNode {
    id: string;
    /** Index into model.nodes (key for linked hover highlighting). */
    index: number;
    label: string;
    x: number;
    y: number;
    w: number;
    h: number;
    /** Label baseline y / center x (the renderer places it with text-anchor=middle). */
    baseline: number;
    textX: number;
    /** Corner radius of the box. */
    radius: number;
}

export interface GraphLayoutRegion {
    label: string;
    x: number;
    y: number;
    w: number;
    h: number;
    /** Member node ids (declaration order). */
    members: string[];
}

export interface GraphLayoutEdge {
    /** Node index (an index into model.nodes, not into GraphLayout.nodes). */
    from: number;
    to: number;
    kind: GraphEdgeKind;
    /** SVG path d (3 orthogonal segments, rounded corners). */
    d: string;
    label?: string;
    labelX?: number;
    labelY?: number;
    /** Label alignment — centered above a straight line; right of the vertical leg if bent. */
    labelAnchor?: "middle" | "start";
}

export interface GraphLayout {
    width: number;
    height: number;
    regions: GraphLayoutRegion[];
    nodes: GraphLayoutNode[];
    edges: GraphLayoutEdge[];
    /** Baseline y of the legend (only when there are dashed / undirected edges). */
    legendY?: number;
}

/**
 * Legend text (shown only when there are dashed / undirected edges). html.ts places the
 * markup, but layout also needs the text length to keep the canvas at least this wide (= so the
 * text isn't cut off on a narrow graph), so the text is declared here, in one place.
 */
export const GRAPH_LEGEND =
    "Solid = dependency / dashed = optional or async / no arrow = undirected / hover to highlight related edges";

// Geometry constants (px). Font metrics can't be measured, so widths are textW estimates
// (= deterministic).
const M = {
    nodeH: 40,
    minW: 128,
    padX: 14,
    /** Gap between nodes stacked in the same column. */
    gapY: 20,
    /** Gap between Dagre ranks (along the arrow direction). */
    gapBandX: 60,
    /** Minimum gap between nodes / regions that Dagre places in the same rank. */
    gapRegionY: 40,
    framePad: 13,
    frameLabelH: 22,
    margin: 16,
    corner: 7,
    radius: 10,
    legendH: 24,
    /** How far the text baseline sits below the box center (assumes a font of about 12.5px). */
    baselineDrop: 4.5,
    /** Max center-x difference for vertically stacked boxes to be joined directly. */
    verticalEps: 8,
} as const;

/** Left edge of the legend / group labels (used by the renderer). */
export const GRAPH_LAYOUT_MARGIN = M.margin;
/** Minimum gap between groups stacked in the same band (tests use it to check non-overlap). */
export const GRAPH_GAP_REGION_Y = M.gapRegionY;
/** Height / padding of a group frame's label area (tests use it to derive the "label top"). */
export const GRAPH_FRAME_LABEL_H = M.frameLabelH;
export const GRAPH_FRAME_PAD = M.framePad;

interface Routing {
    edge: GraphEdge;
    from: number;
    to: number;
    /** Exit / entry side (l = left, r = right, v = direct vertical connection). */
    side: "l" | "r" | "v";
}

/**
 * Bundle of edges meeting at one side of one box (the side's height is divided evenly to stagger
 * the entry / exit points).
 */
interface Slot {
    box: GraphLayoutNode;
    /** Whether this is the box's outgoing side (true) or incoming side (false). */
    isSource: boolean;
    /** Sort key = the other box's center y (an order that makes crossings less likely). */
    items: { route: Routing; key: number }[];
}

/**
 * Graph model → deterministic layout. Dagre's compound graph computes node / region positions and
 * sizes. Edges are then routed between the placed boxes by routeGraphEdges, which keeps the
 * per-kind SVG representation and the hover indices. The Dagre graph is built in model
 * declaration order, so the same input always yields the same coordinates.
 */
export const layoutGraph = (model: GraphModel): GraphLayout => {
    const indexOf = new Map(model.nodes.map((n, i) => [n.id, i]));
    const measured = model.nodes.map((n) => ({
        w: Math.max(M.minW, Math.ceil(textW(n.label, 12.5 / 12) + M.padX * 2)),
        h: M.nodeH,
    }));
    const graph = new dagre.graphlib.Graph<DagreGraphLabel, DagreNodeLabel, DagreEdgeLabel>({
        compound: true,
        multigraph: true,
    })
        .setGraph({
            rankdir: "LR",
            nodesep: M.gapRegionY,
            edgesep: M.gapY,
            ranksep: M.gapBandX,
            marginx: M.margin,
            marginy: M.margin,
            acyclicer: "greedy",
            ranker: "network-simplex",
        })
        .setDefaultEdgeLabel(() => ({}));

    // Internal parent id that can't collide with DSL node ids: the source can't contain NUL, so the
    // prefix acts as a namespace.
    const parentId = (regionIndex: number): string => `\0region:${regionIndex}`;
    model.regions.forEach((region, ri) => {
        if (region.label == null || region.label === "") {
            return;
        }
        graph.setNode(parentId(ri), {
            width: Math.max(1, Math.ceil(textW(region.label, 11.5 / 12) + 8)),
            height: M.frameLabelH,
            label: region.label,
        });
    });

    model.nodes.forEach((node, i) => {
        const size = measured[i] ?? { w: M.minW, h: M.nodeH };
        graph.setNode(node.id, { width: size.w, height: size.h, label: node.label });
    });
    model.regions.forEach((region, ri) => {
        if (region.label == null || region.label === "") {
            return;
        }
        for (const id of region.nodes) {
            if (indexOf.has(id)) {
                graph.setParent(id, parentId(ri));
            }
        }
    });
    model.edges.forEach((edge, i) => {
        // Don't give undirected edges a one-sided rank. At draw time they are connected between the
        // placed nodes like any other edge.
        if (edge.kind === "undirected" || !indexOf.has(edge.from) || !indexOf.has(edge.to)) {
            return;
        }
        graph.setEdge(
            edge.from,
            edge.to,
            {
                minlen: 1,
                weight: edge.kind === "solid" ? 2 : 1,
                ...(edge.label == null
                    ? {}
                    : {
                          width: Math.ceil(textW(edge.label, 10.5 / 12) + 8),
                          height: 16,
                      }),
            },
            `edge:${i}`,
        );
    });
    dagre.layout(graph);

    const nodes: GraphLayoutNode[] = model.nodes.flatMap((node, i) => {
        const size = measured[i];
        const placed = graph.node(node.id);
        if (size == null || placed?.x == null || placed.y == null) {
            return [];
        }
        const x = round1(placed.x - size.w / 2);
        const y = round1(placed.y - size.h / 2);
        return [
            {
                id: node.id,
                index: i,
                label: node.label,
                x,
                y,
                w: size.w,
                h: size.h,
                baseline: round1(y + size.h / 2 + M.baselineDrop),
                textX: round1(x + size.w / 2),
                radius: M.radius,
            },
        ];
    });
    const regions: GraphLayoutRegion[] = model.regions.flatMap((region, ri) => {
        if (region.label == null || region.label === "") {
            return [];
        }
        const placed = graph.node(parentId(ri));
        if (
            placed?.x == null ||
            placed.y == null ||
            placed.width == null ||
            placed.height == null
        ) {
            return [];
        }
        return [
            {
                label: region.label,
                x: round1(placed.x - placed.width / 2),
                y: round1(placed.y - placed.height / 2),
                w: round1(placed.width),
                h: round1(placed.height),
                members: region.nodes,
            },
        ];
    });

    const edges = routeGraphEdges(nodes, model.edges);

    const hasLegend = model.edges.some((e) => e.kind !== "solid");
    const graphWidth = graph.graph().width ?? 0;
    const graphHeight = graph.graph().height ?? 0;
    const width = Math.max(
        M.minW + M.margin * 2,
        // With a legend, always reserve enough width for its text (so it isn't clipped on graphs
        // with few nodes).
        hasLegend ? Math.ceil(M.margin * 2 + textW(GRAPH_LEGEND, 10.5 / 12)) : 0,
        Math.ceil(graphWidth),
        Math.ceil(nodes.reduce((w, n) => Math.max(w, n.x + n.w), 0) + M.margin),
    );
    const legendY = hasLegend ? graphHeight + M.legendH - 8 : undefined;
    const height = Math.ceil(graphHeight + (hasLegend ? M.legendH : 0));

    return {
        width,
        height,
        regions,
        nodes,
        edges,
        ...(legendY == null ? {} : { legendY }),
    };
};

/**
 * Boxes + edges → routes. A pure function so that layout (at build time) and a future interactive
 * UI that moves boxes share the same rules (= a single SoT for how edges are drawn).
 */
export const routeGraphEdges = (
    boxes: readonly GraphLayoutNode[],
    edges: readonly GraphEdge[],
): GraphLayoutEdge[] => {
    const byId = new Map(boxes.map((b) => [b.id, b]));
    const cx = (b: GraphLayoutNode): number => b.x + b.w / 2;
    const cy = (b: GraphLayoutNode): number => b.y + b.h / 2;

    // Pass 1 = pick the exit / entry side of each edge (pass 2 spreads the coordinates evenly).
    const routes: (Routing | undefined)[] = edges.map((edge) => {
        const s = byId.get(edge.from);
        const t = byId.get(edge.to);
        if (s == null || t == null) {
            return undefined;
        }
        const side: Routing["side"] =
            Math.abs(cx(s) - cx(t)) < M.verticalEps ? "v" : cx(t) >= cx(s) ? "r" : "l";
        return { edge, from: s.index, to: t.index, side };
    });

    // Pass 2 = split a side's height evenly among the edges meeting at the same side of the same
    // box (ordered by the other box's center y).
    const slots = new Map<string, Slot>();
    const slotOf = (key: string, box: GraphLayoutNode, isSource: boolean): Slot => {
        const found = slots.get(key);
        if (found != null) {
            return found;
        }
        const slot: Slot = { box, isSource, items: [] };
        slots.set(key, slot);
        return slot;
    };
    for (const r of routes) {
        if (r == null || r.side === "v") {
            continue;
        }
        const s = byId.get(r.edge.from);
        const t = byId.get(r.edge.to);
        if (s == null || t == null) {
            continue;
        }
        slotOf(`s${r.from}:${r.side}`, s, true).items.push({ route: r, key: cy(t) });
        slotOf(`t${r.to}:${r.side}`, t, false).items.push({ route: r, key: cy(s) });
    }
    const exitY = new Map<Routing, number>();
    const entryY = new Map<Routing, number>();
    for (const slot of slots.values()) {
        const sorted = [...slot.items].sort((a, b) => a.key - b.key);
        sorted.forEach((item, k) => {
            const y = slot.box.y + (slot.box.h * (k + 1)) / (sorted.length + 1);
            (slot.isSource ? exitY : entryY).set(item.route, y);
        });
    }

    const out: GraphLayoutEdge[] = [];
    for (const r of routes) {
        if (r == null) {
            continue;
        }
        const s = byId.get(r.edge.from);
        const t = byId.get(r.edge.to);
        if (s == null || t == null) {
            continue;
        }
        let d: string;
        let labelX: number;
        let labelY: number;
        let labelAnchor: "middle" | "start";
        if (r.side === "v") {
            // Vertically stacked boxes are joined directly, bottom edge → top edge (mirrored if
            // reversed).
            const down = cy(t) >= cy(s);
            const x = round1(Math.min(cx(s), cx(t)));
            const y0 = down ? s.y + s.h : s.y;
            const y1 = down ? t.y : t.y + t.h;
            d = `M${x},${round1(y0)} L${x},${round1(y1)}`;
            labelX = x + 6;
            labelY = (y0 + y1) / 2;
            labelAnchor = "start";
        } else {
            const rightward = r.side === "r";
            const sx = rightward ? s.x + s.w : s.x;
            const tx = rightward ? t.x : t.x + t.w;
            const y0 = exitY.get(r) ?? cy(s);
            const y1 = entryY.get(r) ?? cy(t);
            const corridor = (sx + tx) / 2;
            d = orthPath(sx, y0, corridor, y1, tx, M.corner);
            const straight = Math.abs(y0 - y1) < 0.6;
            labelX = straight ? (sx + tx) / 2 : corridor + 6;
            labelY = straight ? y0 - 7 : (y0 + y1) / 2;
            labelAnchor = straight ? "middle" : "start";
        }
        out.push({
            from: r.from,
            to: r.to,
            kind: r.edge.kind,
            d,
            ...(r.edge.label == null
                ? {}
                : {
                      label: r.edge.label,
                      labelX: round1(labelX),
                      labelY: round1(labelY),
                      labelAnchor,
                  }),
        });
    }
    return out;
};
