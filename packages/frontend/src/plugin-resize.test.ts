import { afterEach, expect, it, vi } from "vitest";
import { createPluginResize } from "./plugin-resize.js";

afterEach(() => vi.unstubAllGlobals());

const setup = () => {
    const content = {
        id: "plugin-result-1",
        dataset: {} as Record<string, string>,
        style: { height: "" },
        isConnected: true,
        scrollTop: 0,
        children: [],
        scrollHeight: 640,
        offsetHeight: 180,
        clientHeight: 180,
        querySelector: () => null,
        hasAttribute: (name: string) =>
            name === "data-resized" && content.dataset.resized !== undefined,
        addEventListener: vi.fn(),
        getBoundingClientRect: () => ({ height: Number.parseFloat(content.style.height) || 180 }),
    };
    const attributes = new Map<string, string>();
    const classes = new Set<string>();
    const handle = Object.assign(new EventTarget(), {
        dataset: {} as Record<string, string>,
        setAttribute: (name: string, value: string) => attributes.set(name, value),
        classList: {
            add: (name: string) => classes.add(name),
            remove: (name: string) => classes.delete(name),
        },
        setPointerCapture: vi.fn(),
        focus: () => handle.dispatchEvent(new Event("focus")),
    });
    vi.stubGlobal("document", { createElement: () => handle });
    const observers: (() => void)[] = [];
    class Observer {
        constructor(callback: () => void) {
            observers.push(callback);
        }
        observe() {}
        disconnect() {}
    }
    vi.stubGlobal("MutationObserver", Observer);
    vi.stubGlobal("ResizeObserver", Observer);
    createPluginResize(content as unknown as HTMLElement);
    const pointer = (type: string, y: number, id = 1, button = 0) => {
        const event = Object.assign(new Event(type, { cancelable: true }), {
            clientY: y,
            pointerId: id,
            button,
        });
        handle.dispatchEvent(event);
        return event;
    };
    const key = (key: string) => {
        const event = Object.assign(new Event("keydown", { cancelable: true }), { key });
        handle.dispatchEvent(event);
        return event;
    };
    return { content, handle, attributes, classes, pointer, key, observers };
};

it("resizes only the grabbed card and clamps its height", () => {
    const first = setup();
    const second = setup();
    expect(first.pointer("pointerdown", 200, 1, 2).defaultPrevented).toBe(false);
    expect(first.pointer("pointerdown", 200).defaultPrevented).toBe(true);
    expect(first.handle.setPointerCapture).toHaveBeenCalledWith(1);
    first.pointer("pointermove", 300, 2);
    expect(first.content.style.height).toBe("");
    first.pointer("pointermove", 300);
    expect(first.content.style.height).toBe("280px");
    expect(first.content.dataset.resized).toBe("");
    expect(first.attributes.get("aria-valuenow")).toBe("280");
    expect(second.content.style.height).toBe("");
    first.pointer("pointermove", 5000);
    expect(first.content.style.height).toBe("640px");
    first.pointer("pointermove", -5000);
    expect(first.content.style.height).toBe("32px");
});

it.each(["pointerup", "pointercancel", "lostpointercapture"])("stops resizing on %s", (type) => {
    const { content, classes, pointer } = setup();
    pointer("pointerdown", 200);
    expect(classes.has("drag")).toBe(true);
    pointer(type, 250, 2);
    expect(classes.has("drag")).toBe(true);
    pointer("pointermove", 250);
    pointer(type, 250);
    expect(classes.has("drag")).toBe(false);
    pointer("pointermove", 350);
    expect(content.style.height).toBe("230px");
});

it("exposes the current height and supports keyboard resizing without consuming other keys", () => {
    const { content, handle, attributes, key } = setup();
    handle.focus();
    expect(attributes.get("role")).toBe("separator");
    expect(attributes.get("aria-controls")).toBe(content.id);
    expect(attributes.get("aria-valuenow")).toBe("180");
    expect(key("ArrowDown").defaultPrevented).toBe(true);
    expect(content.style.height).toBe("212px");
    key("ArrowUp");
    expect(content.style.height).toBe("180px");
    key("End");
    expect(content.style.height).toBe("640px");
    key("Home");
    expect(content.style.height).toBe("32px");
    expect(key("Enter").defaultPrevented).toBe(false);
    expect(content.style.height).toBe("32px");
});

it("shrinks an oversized card when its content contracts and preserves scroll position", () => {
    const { content, attributes, key, observers } = setup();
    key("End");
    content.scrollHeight = 210;
    content.scrollTop = 45;
    for (const notify of observers) notify();
    expect(content.style.height).toBe("210px");
    expect(attributes.get("aria-valuemax")).toBe("210");
    expect(content.scrollTop).toBe(45);
});
