import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountToc } from "./toc-ui.js";

let pending: FrameRequestCallback | undefined;
let changed: () => void;
let resized: () => void;
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
            constructor(callback: () => void) {
                resized = callback;
            }
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
const pane = (container = ".preview-pane") => {
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
            closest: () => null,
            dispatchEvent: vi.fn(),
        },
    }));
    const article = {
        isConnected: true,
        clientWidth: 860,
        parentElement: scroller,
        querySelector: (selector: string) =>
            links.find((link) => selector === `#${link.dataset.tocTarget}`)?.heading,
    };
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
        popover: "auto" as string | null,
        removeAttribute: vi.fn(),
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
        contains: (element: unknown) =>
            element === button || links.some((link) => link === element),
        classList: { toggle: vi.fn() },
        remove: vi.fn(),
        offsetHeight: 59,
        matches: (selector: string) => selector === ".in-toc",
        closest: (selector: string) =>
            selector === "article" ? article : selector === container ? scroller : null,
        querySelector: (selector: string) => (selector === ".toc-current" ? button : list),
        querySelectorAll: () => links,
    };
    const toolbar = {
        isConnected: true,
        childNodes: [nav] as { matches: (selector: string) => boolean }[],
        closest: nav.closest,
        append: vi.fn(),
    };
    return { nav, toolbar, scroller, links, article, list, header, button };
};
const documentFor = (panes: ReturnType<typeof pane>[]) =>
    Object.assign(new EventTarget(), {
        documentElement: {},
        querySelectorAll: () => panes.map((pane) => pane.toolbar),
        createElement: () => ({
            className: "",
            childNodes: [] as { matches: (selector: string) => boolean }[],
            append(...nodes: { matches: (selector: string) => boolean }[]) {
                this.childNodes.push(...nodes);
            },
            querySelector(selector: string) {
                return this.childNodes.find((node) => node.matches(selector));
            },
            remove: vi.fn(),
        }),
    }) as unknown as Document;

it("places the outline in the header and tracks each pane independently", () => {
    const first = pane();
    const second = pane();
    const doc = documentFor([first, second]);
    const dispose = mountToc(doc);
    flush();
    expect(first.header.prepend).toHaveBeenCalledWith(
        expect.objectContaining({ className: "page-controls", childNodes: [first.nav] }),
    );
    expect(second.header.prepend).toHaveBeenCalledOnce();
    expect(first.links[0]?.attrs.get("aria-current")).toBe("location");
    first.scroller.scrollTop = 398;
    doc.dispatchEvent(new Event("scroll"));
    flush();
    expect(first.links[0]?.attrs.has("aria-current")).toBe(false);
    expect(first.links[1]?.attrs.get("aria-current")).toBe("location");
    expect(first.button.textContent).toBe("Section 2");
    expect(first.button.title).toBe("Section 2");
    expect(second.links[0]?.attrs.get("aria-current")).toBe("location");
    dispose();
});

it.each([
    ".preview-pane",
    "main",
])("tracks both ends of %s even when the last heading cannot reach the top", (container) => {
    const current = pane(container);
    const doc = documentFor([current]);
    const dispose = mountToc(doc);
    flush();
    current.scroller.scrollTop = 800;
    doc.dispatchEvent(new Event("scroll"));
    flush();
    expect(current.scroller.scrollTop).toBe(800);
    expect(current.links[2]?.attrs.get("aria-current")).toBe("location");
    current.scroller.scrollTop = 0;
    doc.dispatchEvent(new Event("scroll"));
    flush();
    expect(current.scroller.scrollTop).toBe(0);
    expect(current.links[0]?.attrs.get("aria-current")).toBe("location");
    dispose();
    expect(disconnect).toHaveBeenCalledTimes(2);
});

it("handles replaced documents and keeps the first heading active when the page fits", () => {
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
    expect(previous.header.prepend.mock.calls[0]?.[0].remove).toHaveBeenCalled();
    expect(next.links[0]?.attrs.get("aria-current")).toBe("location");
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

it("keeps narrow panes compact and keyboard accessible on resize", () => {
    const current = pane();
    const wide = pane();
    const doc = documentFor([current, wide]);
    const dispose = mountToc(doc);
    flush();
    Object.defineProperty(doc, "activeElement", { configurable: true, value: current.button });
    current.article.clientWidth = 400;
    resized();
    flush();
    expect(current.list.popover).toBe("auto");
    expect(current.nav.classList.toggle).not.toHaveBeenCalled();
    expect(wide.list.popover).toBe("auto");

    const click = new Event("click", { cancelable: true });
    Object.defineProperty(click, "target", { value: { closest: () => current.links[1] } });
    Object.defineProperty(click, "button", { value: 0 });
    current.list.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(current.links[1]?.heading.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(current.button.focus).toHaveBeenCalledWith({ preventScroll: true });
    const key = Object.assign(new Event("keydown", { cancelable: true }), { key: "End" });
    current.list.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);

    Object.defineProperty(doc, "activeElement", { value: current.links[1] });
    current.article.clientWidth = 860;
    resized();
    flush();
    expect(current.list.popover).toBe("auto");
    expect(current.nav.classList.toggle).not.toHaveBeenCalled();
    expect(current.button.focus).toHaveBeenCalledWith({ preventScroll: true });
    current.button.dispatchEvent(new Event("click"));
    expect(current.list.matches()).toBe(true);
    dispose();
});

it("moves download-only controls and removes them when their live toolbar is replaced", () => {
    const current = pane();
    const download = { matches: () => false };
    current.toolbar.childNodes = [download];
    const panes = [current];
    const dispose = mountToc(documentFor(panes));
    expect(current.header.prepend).toHaveBeenCalledOnce();
    expect(current.header.prepend).toHaveBeenCalledWith(
        expect.objectContaining({ childNodes: [download] }),
    );
    current.toolbar.isConnected = false;
    panes.length = 0;
    changed();
    expect(current.header.prepend.mock.calls[0]?.[0].remove).toHaveBeenCalledOnce();
    dispose();
});

it("disposes the previous mount when the reader rewrites the document", () => {
    const current = pane();
    const doc = documentFor([current]);
    mountToc(doc);
    const dispose = mountToc(doc);
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(current.header.prepend.mock.calls[0]?.[0].remove).toHaveBeenCalledOnce();
    dispose();
});
