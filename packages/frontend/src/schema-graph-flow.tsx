// Interactive UI for the schema graph (`schemath`), built on React Flow. Handles zoom / pan /
// box drag & drop / expanded view / minimap. It starts from the same model and the same initial
// layout as the static SVG (html.ts), so the picture stays continuous; without JS / before
// mounting, the static SVG stays readable as-is (fallback).
//
// Positions and edge connections are decided by pure functions (layout / `schemaFlowEdges` in
// schema-graph.ts); this file only maps them onto React Flow (= the SoT for geometry and
// semantics isn't scattered into the UI lib side).
// Styling is self-contained via inline styles + `var(--doc-*)` (no extra CSS on the consumer
// side. React Flow's own stylesheet = the structure-only base.css is injected by the mount layer
// (`flow-css.ts`) — colors come from the `--doc-*` the consumer injects, so React Flow's default
// theme isn't loaded).
import {
    applyNodeChanges,
    Background,
    BackgroundVariant,
    BaseEdge,
    ControlButton,
    Controls,
    type EdgeProps,
    Handle,
    MarkerType,
    MiniMap,
    type Node,
    type NodeChange,
    type NodeProps,
    Position,
    ReactFlow,
    ReactFlowProvider,
    type Edge as RfEdge,
    useReactFlow,
} from "@xyflow/react";
import { type CSSProperties, type JSX, useCallback, useEffect, useMemo, useState } from "react";
import {
    routeSchemaEdges,
    type SchemaFlowNode,
    type SchemaGraphClientData,
    schemaFlowEdges,
} from "../../engine/src/core/schema-graph.js";

const STORE_PREFIX = "docs:sg:";
const FRAME_PAD = 14;

const FG = "var(--doc-fg, #000000)";
const FG2 = "var(--doc-fg-2, #2a3140)";
const FG3 = "var(--doc-fg-3, #5b6271)";
const FG4 = "var(--doc-fg-4, #9099a8)";
const BORDER = "var(--doc-border, #dde3eb)";
const PANEL = "var(--doc-panel, #ffffff)";
const ACCENT = "var(--doc-accent-2, #0277bd)";
const ACCENT2 = "var(--doc-accent, #1b4994)";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

/** Positions of dragged boxes (persisted per graph uid; key = table name → [x, y]). */
type Positions = Record<string, [number, number]>;

const readPositions = (uid: string): Positions => {
    try {
        const raw = window.localStorage.getItem(`${STORE_PREFIX}${uid}`);
        return raw == null ? {} : (JSON.parse(raw) as Positions);
    } catch {
        return {};
    }
};

const writePositions = (uid: string, positions: Positions): void => {
    try {
        if (Object.keys(positions).length === 0) {
            window.localStorage.removeItem(`${STORE_PREFIX}${uid}`);
            return;
        }
        window.localStorage.setItem(`${STORE_PREFIX}${uid}`, JSON.stringify(positions));
    } catch {
        // Keep interactions working even when storage can't be written (private mode etc.).
    }
};

/** Data of a table node (React Flow requires Record<string, unknown>). */
interface TableNodeData extends Record<string, unknown> {
    box: SchemaFlowNode;
    dim: boolean;
}

/** Data of a group frame node. */
interface FrameNodeData extends Record<string, unknown> {
    label: string;
}

type TableNode = Node<TableNodeData, "sgTable">;
type FrameNode = Node<FrameNodeData, "sgFrame">;
type FlowNodes = (TableNode | FrameNode)[];

interface PathEdgeData extends Record<string, unknown> {
    path: string;
}

type PathEdge = RfEdge<PathEdgeData, "sgPath">;

/** Draws the same obstacle-avoiding path as the static SVG in React Flow too. */
const PathEdgeView = ({
    id,
    data,
    style,
    markerEnd,
    interactionWidth,
}: EdgeProps<PathEdge>): JSX.Element => (
    <BaseEdge
        id={id}
        path={data?.path ?? ""}
        style={style}
        markerEnd={markerEnd}
        interactionWidth={interactionWidth}
    />
);

const rowType = (kind: SchemaFlowNode["rows"][number]["kind"]): CSSProperties => ({
    fontSize: 10.5,
    color: kind === "pk" ? ACCENT : kind === "scalar" ? FG3 : ACCENT2,
    whiteSpace: "nowrap",
});

// Table box (same structure as the static SVG box: header / field rows / note rows). Each fk row
// gets a left/right pair of source handles; the edge picks one based on the target's position.
const TableNodeView = ({ data, selected }: NodeProps<TableNode>): JSX.Element => {
    const { box, dim } = data;
    return (
        <div
            style={{
                width: box.w,
                minHeight: box.h,
                fontFamily: MONO,
                background: PANEL,
                border: `1px solid ${selected ? ACCENT : BORDER}`,
                borderRadius: 10,
                boxShadow: selected ? `0 0 0 1px ${ACCENT}` : "none",
                opacity: dim ? 0.45 : 1,
                overflow: "hidden",
                cursor: "grab",
            }}
        >
            <div
                style={{
                    height: box.headerH,
                    lineHeight: `${box.headerH}px`,
                    padding: "0 11px",
                    fontSize: 12.5,
                    color: FG,
                    background: `color-mix(in srgb, ${ACCENT} 10%, transparent)`,
                    borderBottom: `1px solid ${BORDER}`,
                }}
            >
                {box.name}
            </div>
            {box.rows.map((row) =>
                row.kind === "note" ? (
                    <div
                        key={`n:${row.label}`}
                        style={{
                            padding: "0 11px",
                            fontSize: 10.5,
                            lineHeight: "19px",
                            color: FG4,
                        }}
                    >
                        {row.label}
                    </div>
                ) : (
                    <div
                        key={`f:${row.label}`}
                        style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 14,
                            padding: "0 11px",
                            lineHeight: "19px",
                        }}
                    >
                        <span style={{ fontSize: 11.5, color: FG2, whiteSpace: "nowrap" }}>
                            {row.label}
                        </span>
                        <span style={rowType(row.kind)}>{row.type}</span>
                    </div>
                ),
            )}
            {/* Source handles sit at the fk row's height (a left/right pair).
                Target handles are on the box's left/right sides. */}
            {box.rows
                .filter((r) => r.fieldIndex != null && (r.kind === "fk" || r.kind === "fkList"))
                .flatMap((r) => [
                    <Handle
                        key={`sr${r.fieldIndex}`}
                        id={`f${r.fieldIndex}r`}
                        type="source"
                        position={Position.Right}
                        style={{ top: r.dy, opacity: 0, width: 1, height: 1, minWidth: 1 }}
                        isConnectable={false}
                    />,
                    <Handle
                        key={`sl${r.fieldIndex}`}
                        id={`f${r.fieldIndex}l`}
                        type="source"
                        position={Position.Left}
                        style={{ top: r.dy, opacity: 0, width: 1, height: 1, minWidth: 1 }}
                        isConnectable={false}
                    />,
                ])}
            <Handle
                id="tl"
                type="target"
                position={Position.Left}
                style={{ top: box.headerH / 2, opacity: 0, width: 1, height: 1, minWidth: 1 }}
                isConnectable={false}
            />
            <Handle
                id="tr"
                type="target"
                position={Position.Right}
                style={{ top: box.headerH / 2, opacity: 0, width: 1, height: 1, minWidth: 1 }}
                isConnectable={false}
            />
        </div>
    );
};

// Group frame (a labeled `###`). A background node that isn't interactive.
const FrameNodeView = ({ data, width, height }: NodeProps<FrameNode>): JSX.Element => (
    <div style={{ width, height, position: "relative", pointerEvents: "none" }}>
        <div
            style={{
                position: "absolute",
                inset: 0,
                border: `1px dashed ${BORDER}`,
                borderRadius: 14,
                background: `color-mix(in srgb, ${FG} 3%, transparent)`,
            }}
        />
        <div
            style={{
                position: "absolute",
                top: -18,
                left: 4,
                fontFamily: MONO,
                fontSize: 11.5,
                color: FG3,
            }}
        >
            {data.label}
        </div>
    </div>
);

const nodeTypes = { sgTable: TableNodeView, sgFrame: FrameNodeView };
const edgeTypes = { sgPath: PathEdgeView };

// Icons for the extra Controls buttons (drawn as SVG, since font-dependent symbols render as
// tofu in some environments).
const IconExpand = (): JSX.Element => (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
        <path
            fill="currentColor"
            d="M4 4h7v2H6v5H4V4zm9 0h7v7h-2V6h-5V4zM4 13h2v5h5v2H4v-7zm14 0h2v7h-7v-2h5v-5z"
        />
    </svg>
);
const IconShrink = (): JSX.Element => (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
        <path
            fill="currentColor"
            d="M6 10h5V5H9v3H6v2zm7-5v5h5V8h-3V5h-2zM6 14v2h3v3h2v-5H6zm7 0v5h2v-3h3v-2h-5z"
        />
    </svg>
);
const IconReset = (): JSX.Element => (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
        <path fill="currentColor" d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z" />
    </svg>
);
const IconSource = (): JSX.Element => (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
        <path
            fill="currentColor"
            d="M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6zm5.2 0 4.6-4.6-4.6-4.6L16 6l6 6-6 6z"
        />
    </svg>
);

const srcBtnStyle: CSSProperties = {
    font: "inherit",
    fontSize: 11,
    fontFamily: MONO,
    color: FG3,
    background: "transparent",
    border: `1px solid ${BORDER}`,
    borderRadius: 6,
    padding: "2px 8px",
    cursor: "pointer",
};

/**
 * Viewer that shows the raw table DSL as-is (CodeBlock equivalent). Overlaid on the graph, it is
 * only for reading / copying the source text (no editing = the graph never rewrites the DSL).
 */
const SourceView = ({ source, onClose }: { source: string; onClose: () => void }): JSX.Element => {
    const [copied, setCopied] = useState(false);
    const copy = useCallback((): void => {
        navigator.clipboard
            ?.writeText(source)
            .then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
            })
            .catch(() => {
                /* Ignore clipboard rejection (permission / non-secure context). */
            });
    }, [source]);
    return (
        <div
            style={{
                position: "absolute",
                inset: 0,
                zIndex: 6,
                background: PANEL,
                display: "flex",
                flexDirection: "column",
            }}
        >
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "6px 10px",
                    borderBottom: `1px solid ${BORDER}`,
                }}
            >
                <span style={{ fontFamily: MONO, fontSize: 11, color: FG3 }}>table DSL</span>
                <span style={{ flex: 1 }} />
                <button type="button" onClick={copy} style={srcBtnStyle} title="copy">
                    {copied ? "copied" : "copy"}
                </button>
                <button
                    type="button"
                    onClick={onClose}
                    style={srcBtnStyle}
                    title="Back to graph (Esc)"
                >
                    graph
                </button>
            </div>
            <pre
                style={{
                    margin: 0,
                    flex: 1,
                    overflow: "auto",
                    padding: "12px 14px",
                    fontFamily: MONO,
                    fontSize: 12,
                    lineHeight: 1.65,
                    color: FG2,
                    whiteSpace: "pre",
                }}
            >
                {source}
            </pre>
        </div>
    );
};

export interface SchemaGraphFlowProps {
    data: SchemaGraphClientData;
    /** Height in normal view (default = sized to content, max 62vh). */
    height?: number | string;
}

/** Refits each group frame to its members' bounding box (frames stay meaningful after drags). */
const withFrames = (nodes: FlowNodes, data: SchemaGraphClientData): FlowNodes => {
    const tables = nodes.filter((n): n is TableNode => n.type === "sgTable");
    const byName = new Map(tables.map((n) => [n.id, n]));
    return nodes.map((node) => {
        if (node.type !== "sgFrame") {
            return node;
        }
        const group = data.groups[Number(node.id.slice("frame:".length))];
        const members = (group?.members ?? [])
            .map((name) => byName.get(name))
            .filter((n): n is TableNode => n != null);
        if (group == null || members.length === 0) {
            return node;
        }
        const b = members.reduce(
            (acc, n) => ({
                x1: Math.min(acc.x1, n.position.x),
                y1: Math.min(acc.y1, n.position.y),
                x2: Math.max(acc.x2, n.position.x + n.data.box.w),
                y2: Math.max(acc.y2, n.position.y + n.data.box.h),
            }),
            {
                x1: Number.POSITIVE_INFINITY,
                y1: Number.POSITIVE_INFINITY,
                x2: Number.NEGATIVE_INFINITY,
                y2: Number.NEGATIVE_INFINITY,
            },
        );
        return {
            ...node,
            position: { x: b.x1 - FRAME_PAD, y: b.y1 - FRAME_PAD },
            width: b.x2 - b.x1 + FRAME_PAD * 2,
            height: b.y2 - b.y1 + FRAME_PAD * 2,
        };
    });
};

/** Initial nodes (frames → tables, so frames sit behind). Uses saved positions when present. */
const initialNodes = (data: SchemaGraphClientData, positions: Positions): FlowNodes => {
    const frames: FrameNode[] = data.groups.map((g, i) => ({
        id: `frame:${i}`,
        type: "sgFrame",
        position: { x: g.x, y: g.y },
        width: g.w,
        height: g.h,
        data: { label: g.label },
        draggable: false,
        selectable: false,
        focusable: false,
        zIndex: -1,
    }));
    const tables: TableNode[] = data.nodes.map((box) => {
        const p = positions[box.name];
        return {
            id: box.name,
            type: "sgTable",
            position: p == null ? { x: box.x, y: box.y } : { x: p[0], y: p[1] },
            data: { box, dim: false },
        };
    });
    return withFrames([...frames, ...tables], data);
};

const FlowInner = ({ data, height }: SchemaGraphFlowProps): JSX.Element => {
    const { fitView } = useReactFlow();
    // Fold changes in with applyNodeChanges to keep the dimensions React Flow measured
    // (`measured`) (recreating nodes on every render leaves drag uninitialized = RF error #015).
    const [nodes, setNodes] = useState<FlowNodes>(() =>
        initialNodes(data, readPositions(data.uid)),
    );
    const [hover, setHover] = useState<string | null>(null);
    const [expanded, setExpanded] = useState(false);
    const [showSource, setShowSource] = useState(false);

    const onNodesChange = useCallback(
        (changes: NodeChange<TableNode | FrameNode>[]): void => {
            setNodes((prev) => withFrames(applyNodeChanges(changes, prev), data));
        },
        [data],
    );

    // Hover linkage (dimming unrelated boxes) swaps only `data` (keeps `measured` intact).
    useEffect(() => {
        setNodes((prev) => {
            const related = new Set<string>();
            if (hover != null) {
                related.add(hover);
                for (const e of data.edges) {
                    if (e.from === hover) {
                        related.add(e.to);
                    }
                    if (e.to === hover) {
                        related.add(e.from);
                    }
                }
            }
            return prev.map((node) => {
                if (node.type !== "sgTable") {
                    return node;
                }
                const dim = hover != null && !related.has(node.id);
                return dim === node.data.dim ? node : { ...node, data: { ...node.data, dim } };
            });
        });
    }, [hover, data.edges]);

    const edges = useMemo<PathEdge[]>(() => {
        const tableNodes = nodes.filter((n): n is TableNode => n.type === "sgTable");
        const placed = tableNodes.map((n) => ({
            name: n.id,
            index: n.data.box.index,
            x: n.position.x,
            y: n.position.y,
            w: n.data.box.w,
            h: n.data.box.h,
            headerH: n.data.box.headerH,
            rows: n.data.box.rows.map((row) => ({
                y: n.position.y + row.dy,
                fieldIndex: row.fieldIndex,
            })),
        }));
        const paths = routeSchemaEdges(placed, data.edges);
        return schemaFlowEdges(placed, data.edges).map((e, i) => {
            const active = hover != null && (e.from === hover || e.to === hover);
            return {
                id: e.id,
                source: e.from,
                target: e.to,
                sourceHandle: `f${e.fieldIndex}${e.sourceSide}`,
                targetHandle: e.targetSide === "l" ? "tl" : "tr",
                type: "sgPath",
                data: { path: paths[i]?.d ?? "" },
                markerEnd: {
                    type: MarkerType.ArrowClosed,
                    width: 14,
                    height: 14,
                    color: active ? ACCENT : FG3,
                },
                style: {
                    stroke: active ? ACCENT : `color-mix(in srgb, ${FG} 30%, transparent)`,
                    strokeWidth: active ? 1.8 : 1.2,
                    strokeDasharray: e.list ? "5 4" : undefined,
                    opacity: hover == null || active ? 1 : 0.12,
                },
                zIndex: active ? 1 : 0,
            };
        });
    }, [nodes, data.edges, hover]);

    // Save the rearrangement when a drag ends (localStorage, per graph uid).
    const onNodeDragStop = useCallback((): void => {
        setNodes((prev) => {
            const positions: Positions = {};
            for (const node of prev) {
                if (node.type === "sgTable") {
                    positions[node.id] = [Math.round(node.position.x), Math.round(node.position.y)];
                }
            }
            writePositions(data.uid, positions);
            return prev;
        });
    }, [data.uid]);

    // Clamp the fit-view zoom (fitting a wide graph as-is squashes the text, so don't shrink too
    // far: aim for a size that is readable while fitting, and let the user pan / zoom the rest).
    const fitOptions = useMemo(
        () =>
            expanded
                ? { padding: 0.04, minZoom: 0.3, maxZoom: 1.4, duration: 150 }
                : { padding: 0.06, minZoom: 0.55, maxZoom: 1, duration: 150 },
        [expanded],
    );

    const reset = useCallback((): void => {
        writePositions(data.uid, {});
        setNodes(initialNodes(data, {}));
        window.setTimeout(() => fitView(fitOptions), 0);
    }, [data, fitView, fitOptions]);

    // Expanded view = full screen (Esc exits). If the source table is open, Esc closes it first.
    useEffect(() => {
        if (!expanded && !showSource) {
            return;
        }
        const onKey = (ev: KeyboardEvent): void => {
            if (ev.key !== "Escape") {
                return;
            }
            if (showSource) {
                setShowSource(false);
                return;
            }
            setExpanded(false);
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [expanded, showSource]);
    useEffect(() => {
        // Re-fit the whole graph right after the viewport frame changes (expanded view waits a
        // little for the layout to settle).
        const t = window.setTimeout(() => fitView(fitOptions), expanded ? 60 : 20);
        return () => window.clearTimeout(t);
    }, [expanded, fitView, fitOptions]);

    const wrapStyle: CSSProperties = expanded
        ? {
              position: "fixed",
              inset: 0,
              zIndex: 9998,
              background: "var(--doc-bg, #ffffff)",
          }
        : {
              position: "relative",
              width: "100%",
              height: height ?? "min(62vh, 520px)",
              border: `1px solid ${BORDER}`,
              borderRadius: 10,
              overflow: "hidden",
          };

    return (
        <div style={wrapStyle}>
            {showSource && data.source != null ? (
                <SourceView source={data.source} onClose={() => setShowSource(false)} />
            ) : null}
            <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onNodesChange={onNodesChange}
                onNodeDragStop={onNodeDragStop}
                onNodeMouseEnter={(_, node) => setHover(node.type === "sgTable" ? node.id : null)}
                onNodeMouseLeave={() => setHover(null)}
                fitView
                fitViewOptions={fitOptions}
                minZoom={0.1}
                maxZoom={4}
                nodesConnectable={false}
                edgesFocusable={false}
                proOptions={{ hideAttribution: true }}
                style={{ background: "transparent" }}
            >
                <Background variant={BackgroundVariant.Dots} gap={22} size={1} color={FG4} />
                <Controls showInteractive={false}>
                    <ControlButton
                        onClick={() => setExpanded((v) => !v)}
                        title={expanded ? "Close expanded view (Esc)" : "Expand view"}
                    >
                        {expanded ? <IconShrink /> : <IconExpand />}
                    </ControlButton>
                    <ControlButton onClick={reset} title="Reset layout">
                        <IconReset />
                    </ControlButton>
                    {data.source == null ? null : (
                        <ControlButton
                            onClick={() => setShowSource(true)}
                            title="Show raw tables (DSL)"
                        >
                            <IconSource />
                        </ControlButton>
                    )}
                </Controls>
                {/* Colors are passed as props (React Flow maps them to inline CSS variables,
                    so they stay `var(--doc-*)` and follow the caller's palette). */}
                <MiniMap
                    pannable
                    zoomable
                    nodeStrokeWidth={2}
                    bgColor={PANEL}
                    maskColor={`color-mix(in srgb, ${FG} 8%, transparent)`}
                    nodeColor={`color-mix(in srgb, ${FG} 22%, transparent)`}
                    nodeStrokeColor={BORDER}
                    style={{
                        width: 150,
                        height: 96,
                        border: `1px solid ${BORDER}`,
                        borderRadius: 6,
                    }}
                />
            </ReactFlow>
        </div>
    );
};

/** Interactive UI for the schema graph (React Flow). Pass the static SVG's payload as-is. */
export const SchemaGraphFlow = (props: SchemaGraphFlowProps): JSX.Element => (
    <ReactFlowProvider>
        <FlowInner {...props} />
    </ReactFlowProvider>
);
