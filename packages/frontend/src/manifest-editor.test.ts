import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { afterEach, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
    manifestErrors,
    manifestPathCompletion,
    updateManifestSetting,
} from "./manifest-editor.js";

const request = vi.fn();
const pageWorkspace = vi.fn((_id: string) => ({ request }));
vi.mock("../../workspace/src/client.js", () => ({
    pageWorkspace: (id: string) => pageWorkspace(id),
}));
afterEach(() => vi.clearAllMocks());

it("changes a setting without dropping comments, the document tree, or other settings", () => {
    const original =
        "# Project settings\nversion: {major: 2}\nsystem:\n  default_lang: eng # Source language\ndocument:\n  title: Handbook\n  children: [{document: {url: guide.md}}]\n";
    const raw = updateManifestSetting(
        original,
        ["system", "format", "ts", "files"],
        ["examples/main.ts"],
    );
    expect(raw).toContain("# Project settings");
    expect(raw).toContain("# Source language");
    expect(parse(raw)).toEqual({
        ...parse(original),
        system: { default_lang: "eng", format: { ts: { files: ["examples/main.ts"] } } },
    });
    expect(manifestErrors(raw)).toEqual([]);
    const cleared = updateManifestSetting(raw, ["system", "format", "ts", "files"], undefined);
    expect(parse(cleared).system.format.ts).toEqual({});
});

it("keeps syntax, unknown-key, and duplicate-route errors visible", () => {
    expect(manifestErrors("document: [")).not.toEqual([]);
    expect(() => updateManifestSetting("document: [", ["system", "themes"], ["dark"])).toThrow();
    expect(manifestErrors("document: {}\nsystem: {unknown: true}")[0]).toContain("unknown");
    expect(
        manifestErrors(
            "document:\n  children:\n    - document: {url: a/start.md}\n    - document: {url: b/start.md}\n",
        ),
    ).not.toEqual([]);
});

it("allows settings to be added under an empty optional YAML section", () => {
    const raw = updateManifestSetting(
        "system:\ndocument: {icon: null}\n",
        ["system", "format", "csv", "files"],
        ["data.csv"],
    );
    const next = updateManifestSetting(raw, ["document", "icon", "light"], "icon.svg");
    expect(parse(next)).toEqual({
        system: { format: { csv: { files: ["data.csv"] } } },
        document: { icon: { light: "icon.svg" } },
    });
});

it("moves the old sidebar icon into the document while preserving both themes and comments", () => {
    const raw =
        "document:\n  sidebar:\n    title: {eng: Guide}\n    icon: # Shared identity\n      light: light.svg # Keep this\n      dark: dark.svg\n";
    const next = updateManifestSetting(raw, ["document", "icon", "dark"], "new-dark.svg");
    expect(parse(next).document).toEqual({
        sidebar: { title: { eng: "Guide" } },
        icon: { light: "light.svg", dark: "new-dark.svg" },
    });
    expect(next).toContain("# Shared identity");
    expect(next).toContain("# Keep this");
    expect(manifestErrors(next)).toEqual([]);
    expect(() =>
        updateManifestSetting(`${raw}  icon: root.svg\n`, ["document", "title"], "Guide"),
    ).toThrow("remove document.sidebar.icon");
});

it("retains the other theme when editing or clearing one path of a shared icon", () => {
    const raw = "document:\n  icon: shared.svg # Shared icon\n";
    const next = updateManifestSetting(raw, ["document", "icon", "dark"], "dark.svg");
    expect(parse(next).document.icon).toEqual({ light: "shared.svg", dark: "dark.svg" });
    expect(next).toContain("# Shared icon");
    const cleared = updateManifestSetting(raw, ["document", "icon", "light"], undefined);
    expect(parse(cleared).document.icon).toEqual({ dark: "shared.svg" });
    expect(manifestErrors(cleared)).toEqual([]);
});

it.each([
    "system:\n  library:\n    files:\n      - contents/",
    "document:\n  url: contents/",
    "document:\n  icon:\n    light: contents/",
    "json_subformats:\n  - ext: issue\n    schema: contents/",
])("completes YAML paths in the owning workspace: %s", async (raw) => {
    request.mockResolvedValue(["contents/a file.csv", "contents/nested/"]);
    const context = new CompletionContext(EditorState.create({ doc: raw }), raw.length, true);
    const result = await manifestPathCompletion(context, "pane-two");
    expect(pageWorkspace).toHaveBeenCalledWith("pane-two");
    expect(request).toHaveBeenCalledWith("files", { action: "complete", prefix: "contents/" });
    const option = result?.options[0];
    expect(raw.slice(0, result?.from) + option?.apply).toContain('"contents/a file.csv"');
    expect(result?.options[1]?.type).toBe("namespace");
});

it("replaces existing quotes and avoids path suggestions in language lists and remote URLs", async () => {
    request.mockResolvedValue(["data/with'quote.csv"]);
    const raw = "document:\n  url: 'data/'";
    const context = new CompletionContext(EditorState.create({ doc: raw }), raw.length - 1, true);
    const result = await manifestPathCompletion(context, "local");
    expect(result?.to).toBe(raw.length);
    const completed = raw.slice(0, result?.from) + result?.options[0]?.apply;
    expect(parse(completed).document.url).toBe("data/with'quote.csv");
    for (const text of [
        "system:\n  languages:\n    - en",
        "document:\n  url: https://example.com/",
    ])
        expect(
            await manifestPathCompletion(
                new CompletionContext(EditorState.create({ doc: text }), text.length, true),
                "local",
            ),
        ).toBeNull();
});

it("allows a partially typed format path to be corrected before save", () => {
    const raw = "document: {}\nsystem: {format: {ts: {files: [partial], codeblock: true}}}\n";
    expect(manifestErrors(raw)).not.toEqual([]);
    const next = updateManifestSetting(raw, ["system", "format", "ts", "files"], ["example.ts"]);
    expect(manifestErrors(next)).toEqual([]);
    expect(
        parse(updateManifestSetting(next, ["system", "format", "ts", "codeblock"], false)).system
            .format.ts.codeblock,
    ).toBe(false);
});
