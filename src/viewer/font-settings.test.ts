import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFontSettings } from "./font-settings.js";

let preferences: Map<string, string>;
let properties: Map<string, string>;
let loaded: Set<FontFace>;
const editor = { name: "Code.woff2", family: "dooc-font-code", source: "url(code)" };
const viewer = { name: "Body.otf", family: "dooc-font-body", source: "url(body)" };

beforeEach(() => {
    preferences = new Map();
    properties = new Map();
    loaded = new Set();
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => preferences.get(key) ?? null,
        setItem: (key: string, value: string) => preferences.set(key, value),
    });
    vi.stubGlobal("document", {
        fonts: loaded,
        documentElement: {
            style: {
                setProperty: (key: string, value: string) => properties.set(key, value),
                removeProperty: (key: string) => properties.delete(key),
            },
        },
        dispatchEvent: vi.fn(),
    });
    vi.stubGlobal(
        "FontFace",
        class {
            constructor(
                readonly family: string,
                private source: string,
            ) {}
            async load() {
                if (this.source === "broken") throw new Error("Bad font data");
                return this;
            }
        },
    );
});
afterEach(() => vi.unstubAllGlobals());

it("loads only project fonts and restores independent editor/viewer choices", async () => {
    const settings = createFontSettings([editor, viewer]);
    await settings.ready;
    settings.select("editor", editor.family);
    expect(properties.get("--editor-font")).toContain(editor.family);
    expect(properties.has("--viewer-font")).toBe(false);
    settings.select("viewer", viewer.family);
    expect(properties.get("--viewer-font")).toContain(viewer.family);
    const restored = createFontSettings([editor, viewer]);
    await restored.ready;
    expect(restored.selected).toEqual({ editor: editor.family, viewer: viewer.family });
    restored.select("editor", "");
    expect(properties.has("--editor-font")).toBe(false);
    expect(properties.has("--viewer-font")).toBe(true);
    expect(document.dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "docs:font-change" }),
    );
    expect(() => settings.select("viewer", "unregistered")).toThrow("Invalid font file");
    expect(settings).not.toHaveProperty("add");
    expect(settings).not.toHaveProperty("remove");
});

it("falls back when changing projects or when a registered font fails to load", async () => {
    preferences.set("docs-editor:font", "another-project-font");
    preferences.set("docs-preview:font", editor.family);
    const settings = createFontSettings([{ ...editor, source: "broken" }, viewer]);
    await expect(settings.ready).rejects.toThrow("Some registered fonts");
    expect(settings.selected).toEqual({ editor: "", viewer: "" });
    expect(properties.size).toBe(0);
    expect([...settings.fonts.keys()]).toEqual([viewer.family]);
});

it("applies the selection even when saving browser preferences is blocked", async () => {
    const settings = createFontSettings([editor]);
    await settings.ready;
    vi.stubGlobal("localStorage", {
        setItem: () => {
            throw new Error("Denied");
        },
    });
    expect(() => settings.select("editor", editor.family)).toThrow(
        "Font choice applies only to this tab",
    );
    expect(properties.get("--editor-font")).toContain(editor.family);
});
