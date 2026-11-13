import { afterEach, expect, it, vi } from "vitest";
import { initializeThemes, mountThemePickers } from "./theme-picker.js";

afterEach(() => vi.unstubAllGlobals());

it.each([
    { themes: ["dark"], stored: "light", expected: "dark" },
    { themes: ["light"], stored: "auto", expected: "light" },
    { themes: ["light", "dark"], stored: "light", expected: "light" },
    { themes: ["light", "dark"], stored: null, expected: "auto" },
])("initializes declared themes despite an incompatible saved preference: %j", ({
    themes,
    stored,
    expected,
}) => {
    const pane = { dataset: { theme: "unsupported" } };
    const resource = { dataset: { theme: "unsupported" } };
    const root = { dataset: { theme: "light", editorTheme: "" } };
    let sync = () => {};
    vi.stubGlobal("document", {
        documentElement: root,
        body: { append: vi.fn() },
        createElement: () => ({ setAttribute: vi.fn(), addEventListener: vi.fn() }),
        addEventListener: vi.fn(),
        querySelectorAll: (selector: string) =>
            selector === ".resources-pane, #sidebar, #panel"
                ? [resource]
                : selector === ".preview-pane:not(.resources-pane)"
                  ? [pane]
                  : [],
    });
    vi.stubGlobal("localStorage", { getItem: () => stored });
    vi.stubGlobal(
        "MutationObserver",
        class {
            constructor(callback: () => void) {
                sync = callback;
            }
            observe() {}
        },
    );
    initializeThemes(themes);
    expect(root.dataset.theme).toBe(expected);
    mountThemePickers({}, themes);
    expect(root.dataset.theme).toBe(expected);
    expect(pane.dataset.theme).toBe(expected);
    expect(root.dataset.editorTheme).toBe(stored === "light" ? "light" : "auto");
    expect(resource.dataset.theme).toBe(root.dataset.editorTheme);
    for (const theme of ["dark", "light", "auto"]) {
        root.dataset.editorTheme = theme;
        sync();
        expect(resource.dataset.theme).toBe(theme);
        expect(pane.dataset.theme).toBe(expected);
    }
});
