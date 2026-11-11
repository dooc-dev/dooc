import { afterEach, expect, it, vi } from "vitest";
import { loadGraphScript } from "./lazy-graph.js";

afterEach(() => vi.unstubAllGlobals());

const setup = (initial = false) => {
    let changed: (records: { addedNodes: unknown[] }[]) => void = () => {};
    const disconnect = vi.fn();
    const append = vi.fn();
    class Element {
        constructor(
            readonly diagram = false,
            readonly nested = false,
        ) {}
        matches() {
            return this.diagram;
        }
        querySelector() {
            return this.nested;
        }
    }
    vi.stubGlobal("Element", Element);
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
    vi.stubGlobal("document", {
        querySelector: () => ({ querySelector: () => initial, contains: () => true }),
        createElement: () => ({ remove: vi.fn() }),
        head: { append },
    });
    loadGraphScript();
    return {
        append,
        disconnect,
        change: (diagram = false, nested = false) =>
            changed([{ addedNodes: [new Element(diagram, nested), {}] }]),
    };
};

it("leaves text pages unloaded and loads once when a live preview gains a diagram", () => {
    const { append, change, disconnect } = setup();
    change();
    expect(append).not.toHaveBeenCalled();
    change(false, true);
    change(true);
    expect(append).toHaveBeenCalledTimes(1);
    const script = append.mock.calls[0]?.[0];
    expect(script.src).toBe("/assets/graph.js");
    script.onload();
    expect(disconnect).toHaveBeenCalledOnce();
});

it("loads existing diagrams and permits a retry after a failed script request", () => {
    const { append, change, disconnect } = setup(true);
    expect(append).toHaveBeenCalledOnce();
    const script = append.mock.calls[0]?.[0];
    script.onerror();
    expect(script.remove).toHaveBeenCalledOnce();
    expect(disconnect).not.toHaveBeenCalled();
    change(true);
    expect(append).toHaveBeenCalledTimes(2);
});
