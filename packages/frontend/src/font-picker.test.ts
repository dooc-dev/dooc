import { afterEach, expect, it, vi } from "vitest";
import { mountFontPickers } from "./font-picker.js";
import type { createFontSettings } from "./font-settings.js";

afterEach(() => vi.unstubAllGlobals());

class Node extends EventTarget {
    dataset: Record<string, string> = {};
    style = {};
    attributes = new Map<string, string>();
    children: Node[] = [];
    parent?: Node;
    textContent = "";
    title = "";
    disabled = false;
    open = false;
    setAttribute(key: string, value: string) {
        this.attributes.set(key, value);
    }
    append(node: Node) {
        this.children.push(node);
    }
    replaceChildren() {
        this.children = [];
    }
    matches() {
        return this.open;
    }
    showPopover() {
        this.open = true;
    }
    hidePopover() {
        this.open = false;
    }
    focus() {}
    closest(selector: string) {
        return selector === ".preview-pane" ? this.parent : this;
    }
    getBoundingClientRect() {
        return { left: 500, bottom: 40 };
    }
    querySelector(selector: string) {
        if (selector === "[data-picker-value]")
            return this.children.find((child) => Object.hasOwn(child.dataset, "pickerValue"));
        return this.children.find((child) => child.attributes.get("aria-checked") === "true");
    }
}

const setup = () => {
    const editor = new Node();
    editor.dataset.fontPicker = "editor";
    const editorValue = new Node();
    editorValue.dataset.pickerValue = "";
    editor.append(editorValue);
    const viewer = new Node();
    viewer.dataset.fontPicker = "viewer";
    viewer.parent = new Node();
    viewer.parent.dataset.theme = "light";
    const popup = new Node();
    const doc = Object.assign(new EventTarget(), {
        documentElement: { dataset: { theme: "auto", editorTheme: "dark" } },
        body: { append: vi.fn() },
        createElement: vi
            .fn()
            .mockReturnValueOnce(popup)
            .mockImplementation(() => new Node()),
        querySelectorAll: () => [editor, viewer],
    });
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", {});
    vi.stubGlobal("Element", Node);
    vi.stubGlobal("innerWidth", 1000);
    vi.stubGlobal("innerHeight", 700);
    vi.stubGlobal(
        "MutationObserver",
        class {
            observe() {}
        },
    );
    const settings = {
        fonts: new Map([["code", {} as FontFace]]),
        selected: { editor: "", viewer: "" },
        ready: Promise.resolve(),
        select: vi.fn((target: "editor" | "viewer", family: string) => {
            settings.selected[target] = family;
        }),
    };
    const click = (host: EventTarget, target: Node) => {
        const event = new Event("click");
        Object.defineProperty(event, "target", { value: target });
        host.dispatchEvent(event);
    };
    const mount = () =>
        mountFontPickers((() => settings) as typeof createFontSettings, [
            { family: "code", name: "Code.woff2", source: "" },
            { family: "code", name: "Code.woff2", source: "" },
            { family: "broken", name: "Broken.woff2", source: "" },
        ]);
    return { editor, editorValue, viewer, popup, doc, settings, click, mount };
};

it("uses each trigger's theme and changes only its font target", async () => {
    const { editor, editorValue, viewer, popup, doc, settings, click, mount } = setup();
    const ready = mount();
    expect(editor.disabled).toBe(true);
    await ready;
    expect(editor.disabled).toBe(false);
    expect(editorValue.textContent).toBe("Default font");
    click(doc, editor);
    expect(popup.dataset.theme).toBe("dark");
    expect(popup.children.map((node) => node.textContent)).toEqual(["Default font", "Code.woff2"]);
    click(popup, popup.children[1] as Node);
    expect(settings.selected).toEqual({ editor: "code", viewer: "" });
    expect(popup.open).toBe(false);
    expect(editor.title).toBe("Editor font: Code.woff2");
    expect(editorValue.textContent).toBe("Code.woff2");
    click(doc, viewer);
    expect(popup.dataset.theme).toBe("light");
    expect(popup.children[0]?.attributes.get("aria-checked")).toBe("true");
});

it("keeps loading and persistence errors visible while valid fonts remain usable", async () => {
    const { editor, popup, doc, settings, click, mount } = setup();
    settings.ready = Promise.reject(new Error("Some registered fonts could not be loaded"));
    await mount();
    click(doc, editor);
    expect(popup.children.at(-1)?.textContent).toBe("Some registered fonts could not be loaded");
    settings.select.mockImplementation(() => {
        throw new Error("Font choice applies only to this tab");
    });
    click(popup, popup.children[1] as Node);
    expect(popup.open).toBe(true);
    expect(popup.children.at(-1)?.textContent).toBe("Font choice applies only to this tab");
});
