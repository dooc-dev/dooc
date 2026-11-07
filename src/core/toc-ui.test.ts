import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountToc } from "./toc-ui.js";

let pending: FrameRequestCallback | undefined;
let changed: () => void;
const unobserve = vi.fn();
const disconnect = vi.fn();
beforeEach(() => {
    pending = undefined;
    vi.clearAllMocks();
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("innerWidth", 1000);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        pending = callback;
        return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
        pending = undefined;
    });
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve = unobserve;
            disconnect = disconnect;
        },
    );
    vi.stubGlobal(
        "MutationObserver",
        class {
            constructor(callback: () => void) {
                changed = callback;
            }
            observe() {}
            disconnect = disconnect;
        },
    );
});
afterEach(() => vi.unstubAllGlobals());

const flush = () => {
    const callback = pending;
    pending = undefined;
    callback?.(0);
};
const pane = () => {
    const header = {
        prepend: vi.fn(),
        getBoundingClientRect: () => ({ bottom: 36 }),
    };
    const scroller = {
        scrollTop: 0,
        scrollHeight: 1200,
        clientHeight: 400,
        clientTop: 2,
        getBoundingClientRect: () => ({ top: 0 }),
        querySelector: () => header,
        scrollTo: ({ top }: { top: number }) => {
            scroller.scrollTop = top;
        },
    };
    const links = [100, 450, 950].map((top, index) => ({
        dataset: { tocTarget: `section-${index}` },
        textContent: `Section ${index + 1}`,
        offsetLeft: index * 120,
        offsetWidth: 100,
        offsetTop: index * 36,
        focus: vi.fn(),
        attrs: new Map<string, string>(),
        setAttribute(key: string, value: string) {
            this.attrs.set(key, value);
        },
        removeAttribute(key: string) {
            this.attrs.delete(key);
        },
        heading: {
            getBoundingClientRect: () => ({ top: top - scroller.scrollTop }),
            scrollIntoView: vi.fn(),
        },
    }));
    const article = {
        isConnected: true,
        querySelector: (selector: string) =>
            links.find((link) => selector === `#${link.dataset.tocTarget}`)?.heading,
    };
    const seek = Object.assign(new EventTarget(), {
        disabled: true,
        value: "0",
        style: { setProperty: vi.fn() },
        setAttribute: vi.fn(),
    });
    const button = Object.assign(new EventTarget(), {
        textContent: "",
        title: "",
        setAttribute: vi.fn(),
        focus: vi.fn(),
        getBoundingClientRect: () => ({ left: 900, bottom: 36 }),
    });
    let open = false;
    const list = Object.assign(new EventTarget(), {
        clientHeight: 80,
        style: { width: "", left: "", top: "" },
        scrollTop: 0,
        matches: () => open,
        showPopover: () => {
            open = true;
        },
        hidePopover: () => {
            open = false;
        },
    });
    const nav = {
        isConnected: true,
        remove: vi.fn(),
        offsetHeight: 59,
        closest: (selector: string) => (selector === "article" ? article : scroller),
        querySelector: (selector: string) =>
            selector === ".toc-seek" ? seek : selector === ".toc-current" ? button : list,
        querySelectorAll: () => links,
    };
    return { nav, scroller, links, seek, article, list, header, button };
};
const documentFor = (panes: ReturnType<typeof pane>[]) =>
    Object.assign(new EventTarget(), {
        documentElement: {},
        querySelectorAll: () => panes.map((pane) => pane.nav),
    }) as unknown as Document;

it("tracks each pane independently and displays its current heading", () => {
    const first = pane();
    const second = pane();
    const doc = documentFor([first, second]);
    const dispose = mountToc(doc);
    flush();
    expect(first.header.prepend).toHaveBeenCalledWith(first.nav);
    expect(second.header.prepend).toHaveBeenCalledWith(second.nav);
    expect(first.links[0]?.attrs.get("aria-current")).toBe("location");
    first.scroller.scrollTop = 398;
    doc.dispatchEvent(new Event("scroll"));
    flush();
    expect(first.seek.value).toBe("498");
    expect(first.links[0]?.attrs.has("aria-current")).toBe(false);
    expect(first.links[1]?.attrs.get("aria-current")).toBe("location");
    expect(first.button.textContent).toBe("Section 2");
    expect(first.button.title).toBe("Section 2");
    expect(second.seek.value).toBe("0");
    expect(second.links[0]?.attrs.get("aria-current")).toBe("location");
    dispose();
});

it("seeks to both ends, including a final heading that cannot reach the top of the viewport", () => {
    const current = pane();
    const dispose = mountToc(documentFor([current]));
    flush();
    current.seek.value = "1000";
    current.seek.dispatchEvent(new Event("input"));
    flush();
    expect(current.scroller.scrollTop).toBe(800);
    expect(current.links[2]?.attrs.get("aria-current")).toBe("location");
    current.seek.value = "0";
    current.seek.dispatchEvent(new Event("input"));
    flush();
    expect(current.scroller.scrollTop).toBe(0);
    expect(current.links[0]?.attrs.get("aria-current")).toBe("location");
    dispose();
    expect(disconnect).toHaveBeenCalledTimes(2);
});

it("handles replaced documents and disables seeking when a document fits on screen", () => {
    const previous = pane();
    const panes = [previous];
    const dispose = mountToc(documentFor(panes));
    flush();
    previous.article.isConnected = false;
    const next = pane();
    next.scroller.scrollHeight = next.scroller.clientHeight;
    panes.splice(0, 1, next);
    changed();
    flush();
    expect(unobserve).toHaveBeenCalledWith(previous.article);
    expect(previous.nav.remove).toHaveBeenCalled();
    expect(next.seek.disabled).toBe(true);
    expect(next.seek.value).toBe("0");
    dispose();
});

it("jumps within the clicked pane even before that pane becomes active", () => {
    const current = pane();
    const doc = documentFor([current, pane()]);
    const dispose = mountToc(doc);
    const click = new Event("click", { cancelable: true });
    Object.defineProperty(click, "target", { value: { closest: () => current.links[1] } });
    Object.defineProperty(click, "button", { value: 0 });
    current.list.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(current.links[1]?.heading.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    dispose();
});

it("opens the outline within the viewport and supports keyboard navigation", () => {
    const current = pane();
    const doc = documentFor([current]);
    const dispose = mountToc(doc);
    flush();
    current.button.dispatchEvent(new Event("click"));
    expect(current.list.matches()).toBe(true);
    expect(current.list.style.width).toBe("240px");
    expect(current.list.style.left).toBe("752px");
    expect(current.links[0]?.focus).toHaveBeenCalledWith({ preventScroll: true });
    const key = Object.assign(new Event("keydown", { cancelable: true }), { key: "End" });
    current.list.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    expect(current.links[2]?.focus).toHaveBeenCalled();
    dispose();
});
