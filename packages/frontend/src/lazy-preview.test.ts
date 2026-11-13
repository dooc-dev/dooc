import { afterEach, expect, it, vi } from "vitest";
import { loadPreviewScript } from "./lazy-preview.js";

afterEach(() => vi.unstubAllGlobals());

const setup = (src: string, selector: string, type: string, initial = false) => {
    let changed = () => {};
    let intersect: (entries: { target: object; isIntersecting: boolean }[]) => void = () => {};
    const disconnect = vi.fn();
    const unobserve = vi.fn();
    const stopVisibility = vi.fn();
    const observe = vi.fn();
    const append = vi.fn();
    const diagram = {};
    let nodes = initial ? [diagram] : [];
    vi.stubGlobal(
        "MutationObserver",
        class {
            constructor(callback: typeof changed) {
                changed = callback;
            }
            observe() {}
            disconnect = disconnect;
        },
    );
    vi.stubGlobal(
        "IntersectionObserver",
        class {
            constructor(callback: typeof intersect) {
                intersect = callback;
            }
            observe = observe;
            unobserve = unobserve;
            disconnect = stopVisibility;
        },
    );
    vi.stubGlobal("document", {
        querySelector: () => ({
            querySelectorAll: () => nodes,
            contains: (node: object) => nodes.includes(node),
        }),
        createElement: () => ({ remove: vi.fn() }),
        head: { append },
    });
    loadPreviewScript(src, selector, type);
    return {
        append,
        disconnect,
        stopVisibility,
        observe,
        unobserve,
        change: (present: boolean) => {
            nodes = present ? [diagram] : [];
            changed();
        },
        visible: (visible = true) => intersect([{ target: diagram, isIntersecting: visible }]),
    };
};

it.each([
    ["/assets/graph.js", "svg[data-sg-layout], [data-mermaid]", "module"],
    ["/assets/code.js", ".codeblk", ""],
])("loads %s once near the viewport, including content inserted by a live preview", (src, selector, type) => {
    const { append, change, visible, disconnect, stopVisibility } = setup(src, selector, type);
    expect(append).not.toHaveBeenCalled();
    change(true);
    visible(false);
    expect(append).not.toHaveBeenCalled();
    visible();
    visible();
    expect(append).toHaveBeenCalledOnce();
    const script = append.mock.calls[0]?.[0];
    expect(script.src).toBe(src);
    expect(script.type).toBe(type);
    script.onload();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(stopVisibility).toHaveBeenCalledOnce();
});

it("retries on visibility change after failure and releases removed diagrams", () => {
    const { append, visible, change, unobserve } = setup(
        "/assets/graph.js",
        "[data-mermaid]",
        "module",
        true,
    );
    visible();
    const script = append.mock.calls[0]?.[0];
    script.onerror();
    expect(script.remove).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledOnce();
    visible(false);
    visible();
    expect(append).toHaveBeenCalledTimes(2);
    change(false);
    visible();
    expect(unobserve).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledTimes(2);
});
