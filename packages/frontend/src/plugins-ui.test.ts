import { afterEach, expect, it, vi } from "vitest";
import { mountPlugins } from "./plugins-ui.js";

vi.mock("./i18n.js", () => ({ t: (value: string) => value }));
afterEach(() => vi.unstubAllGlobals());

it("preserves source content and explains unavailable plugins without opening an HTTP event stream", async () => {
    class Element extends EventTarget {
        dataset: Record<string, string> = {};
        children: Element[] = [];
        textContent = "";
        append(...nodes: Element[]) {
            this.children.push(...nodes);
        }
        closest() {
            return { dataset: { workspace: "a" } };
        }
        querySelector() {
            return this.children.find((child) => "pluginUnavailable" in child.dataset);
        }
    }
    const source = new Element();
    source.textContent = "https://example.com/source";
    const host = new Element();
    host.dataset.embedUrl = source.textContent;
    host.append(source);
    const request = vi.fn(async () => ({ ops: ["http", "files"] }));
    const fetch = vi.fn();
    vi.stubGlobal("__doocConnections", {
        active: "a",
        items: new Map([["a", { client: { request }, fetch }]]),
    });
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal(
        "document",
        Object.assign(new EventTarget(), {
            documentElement: {},
            body: {},
            querySelector: () => null,
            querySelectorAll: (selector: string) =>
                selector === "main [data-embed-url]" ? [host] : [],
            createElement: () => new Element(),
        }),
    );
    vi.stubGlobal(
        "MutationObserver",
        class {
            observe() {}
        },
    );
    vi.stubGlobal(
        "IntersectionObserver",
        class {
            observe() {}
            unobserve() {}
        },
    );
    vi.stubGlobal("matchMedia", () => new EventTarget());
    vi.stubGlobal("BroadcastChannel", undefined);
    const events = vi.fn();
    vi.stubGlobal("EventSource", events);
    mountPlugins();
    await vi.waitFor(() => expect(host.children).toHaveLength(2));
    expect(host.children[0]).toBe(source);
    expect(host.children[1]?.textContent).toBe(
        "Plugins are unavailable in this workspace. Open the source link.",
    );
    expect(events).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(request.mock.calls).toEqual([["hello"]]);
});
