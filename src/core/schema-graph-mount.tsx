// Mount layer that replaces the static SVG (output of `docHtml`) with an interactive React Flow
// graph. The diagram is readable without JS, so this is progressive enhancement (only graphs
// that mount successfully become interactive).
// Two kinds of consumer: script tag (viewer etc. = the global bundle calls watch) and
// React embed (the consumer's component calls mount). On either path, this layer injects the
// React Flow stylesheet (`flow-css.ts`) — consumers aren't required to ship the CSS.
import { createRoot, type Root } from "react-dom/client";
import { injectSchemaGraphCss } from "./flow-css.js";
import type { SchemaGraphClientData } from "./schema-graph.js";
import { SchemaGraphFlow } from "./schema-graph-flow.js";

const MOUNTED = "sgMounted";

/** Undoes a mount (unmount + restore the static SVG). */
export type SchemaGraphDispose = () => void;

const mountOne = (svg: SVGSVGElement): SchemaGraphDispose | undefined => {
    const payload = svg.dataset.sgLayout;
    if (payload == null || svg.dataset[MOUNTED] === "1") {
        return undefined;
    }
    let data: SchemaGraphClientData;
    try {
        data = JSON.parse(payload) as SchemaGraphClientData;
    } catch {
        return undefined;
    }
    if (data.nodes.length === 0) {
        return undefined;
    }
    svg.dataset[MOUNTED] = "1";
    // Without its CSS, React Flow loses absolute positioning (boxes fly out of the frame and
    // Controls / MiniMap stack at the top), so ensure the stylesheet before hiding the static SVG.
    injectSchemaGraphCss(svg.ownerDocument);
    const host = svg.ownerDocument.createElement("div");
    host.className = "doc-sg-flow";
    svg.parentElement?.insertBefore(host, svg);
    // Keep the static SVG in the DOM as a fallback (print / JS disabled); only hide it.
    svg.style.display = "none";
    let root: Root | undefined = createRoot(host);
    root.render(<SchemaGraphFlow data={data} />);
    return () => {
        root?.unmount();
        root = undefined;
        host.remove();
        svg.style.removeProperty("display");
        delete svg.dataset[MOUNTED];
    };
};

/** Replaces schema graphs under root with interactive graphs (already-mounted ones are skipped). */
export const mountSchemaGraphs = (root: ParentNode = document): SchemaGraphDispose => {
    const disposers: SchemaGraphDispose[] = [];
    for (const svg of root.querySelectorAll<SVGSVGElement>("svg[data-sg-layout]")) {
        const dispose = mountOne(svg);
        if (dispose != null) {
            disposers.push(dispose);
        }
    }
    return () => {
        for (const dispose of disposers) {
            dispose();
        }
    };
};

/**
 * Watches root and also makes graphs inserted later (HMR body replacement / edit's live render)
 * interactive. The returned function stops watching.
 */
export const watchSchemaGraphs = (
    root: (ParentNode & Node) | Document = document,
): SchemaGraphDispose => {
    const mounted = new Map<SVGSVGElement, SchemaGraphDispose>();
    const pending = new Set<SVGSVGElement>();
    const visibility = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const svg = entry.target as SVGSVGElement;
                visibility.unobserve(svg);
                pending.delete(svg);
                if (!root.contains(svg)) continue;
                const dispose = mountOne(svg);
                if (dispose) mounted.set(svg, dispose);
            }
        },
        { rootMargin: "200px" },
    );
    const mount = (node: ParentNode): void => {
        const svgs = [...node.querySelectorAll<SVGSVGElement>("svg[data-sg-layout]")];
        if (node instanceof SVGSVGElement && node.matches("svg[data-sg-layout]")) {
            svgs.unshift(node);
        }
        for (const svg of svgs) {
            if (mounted.has(svg) || pending.has(svg)) continue;
            pending.add(svg);
            visibility.observe(svg);
        }
    };
    mount(root);
    const observer = new MutationObserver((records) => {
        for (const svg of pending)
            if (!root.contains(svg)) {
                pending.delete(svg);
                visibility.unobserve(svg);
            }
        // Look only at added subtrees instead of scanning the whole document on every keystroke.
        for (const [svg, dispose] of mounted) {
            if (!root.contains(svg)) {
                dispose();
                mounted.delete(svg);
            }
        }
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node instanceof Element && root.contains(node)) mount(node);
            }
        }
    });
    observer.observe(root instanceof Document ? (root.body ?? root) : root, {
        childList: true,
        subtree: true,
    });
    return () => {
        observer.disconnect();
        visibility.disconnect();
        pending.clear();
        for (const dispose of mounted.values()) {
            dispose();
        }
        mounted.clear();
    };
};
