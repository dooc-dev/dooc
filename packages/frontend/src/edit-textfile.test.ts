import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import { chooseConflict } from "./edit-conflict.js";
import { createTextfileEditors, fileValidationState, textfileLines } from "./edit-textfile.js";
import { fileReferences } from "./file-references.js";

vi.mock("./edit-conflict.js", () => ({ chooseConflict: vi.fn() }));

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

it("saves the edits shown in a manual conflict and adopts normalized file content", async () => {
    let reads = 0;
    let saves = 0;
    let release!: () => void;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        const input = JSON.parse(String(init?.body));
        if (input.action === "read") {
            if (++reads === 1) return Response.json({ content: "original", language: "txt" });
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            return Response.json({ content: "external" });
        }
        if (++saves === 1) return Response.json({ error: "Conflict" }, { status: 409 });
        expect(input).toMatchObject({ base: "external", content: "latest edit" });
        return Response.json({ content: "latest edit\n" });
    });
    vi.stubGlobal("__doocConnections", {
        active: "owned",
        items: new Map([["owned", { fetch }]]),
    });
    vi.mocked(chooseConflict).mockResolvedValue("local");
    const files = createTextfileEditors(
        [],
        () => {},
        () => {},
        "owned",
        () => false,
    );
    const unsubscribe = files.subscribe("notes.txt", () => {});
    await vi.waitFor(() => expect(files.content("notes.txt")).toBe("original"));
    files.update("notes.txt", "first edit");
    const saving = files.save("notes.txt");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    files.update("notes.txt", "latest edit");
    release();
    await saving;
    expect(chooseConflict).toHaveBeenCalledWith("notes.txt", "latest edit", "external");
    expect(files.snapshot("notes.txt")).toEqual({
        content: "latest edit\n",
        dirty: false,
        error: "",
    });
    unsubscribe();
});

it("shares native drafts, respects auto-save changes and preserves edits during a save", async () => {
    vi.useFakeTimers();
    let automatic = false;
    let disk = "original";
    let finish: (() => void) | undefined;
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
        const input = JSON.parse(String(init?.body));
        if (input.action === "save") {
            expect(input.base).toBe(disk);
            if (input.content === "first")
                await new Promise<void>((resolve) => {
                    finish = resolve;
                });
            disk = input.content;
        }
        return Response.json({ content: disk, language: "txt" });
    });
    vi.stubGlobal("__doocConnections", {
        active: "owned",
        items: new Map([["owned", { fetch: request }]]),
    });
    const files = createTextfileEditors(
        [],
        () => {},
        () => {},
        "owned",
        () => automatic,
    );
    const listener = vi.fn();
    const unsubscribe = files.subscribe("notes.txt", listener);
    await vi.waitFor(() => expect(files.content("notes.txt")).toBe("original"));
    files.update("notes.txt", "first");
    await vi.advanceTimersByTimeAsync(1000);
    await files.reloadChanged(["notes.txt"]);
    expect(request).toHaveBeenCalledOnce();
    const saving = files.save("notes.txt");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    files.update("notes.txt", "second");
    finish?.();
    await saving;
    expect(files.snapshot("notes.txt")).toMatchObject({ content: "second", dirty: true });
    expect(disk).toBe("first");
    automatic = true;
    await files.flush();
    expect(disk).toBe("second");
    files.update("notes.txt", "third");
    automatic = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(disk).toBe("second");
    await files.save("notes.txt");
    expect(disk).toBe("third");
    expect(files.hasUnsavedChanges()).toBe(false);
    unsubscribe();
});

it("resolves embedded files from their owning manifest and ignores external embeds", () => {
    const body = "![](data/example.txt)\n\n![](image.svg)\n\n![](https://example.com/code.txt)";
    expect(fileReferences(body, undefined, "child/dooc.yaml").map(({ file }) => file)).toEqual([
        "child/data/example.txt",
        "child/image.svg",
    ]);
    expect(textfileLines(body, undefined, "child/dooc.yaml")[0]?.file).toBe(
        "child/data/example.txt",
    );
    expect(textfileLines(body)[0]?.file).toBe("data/example.txt");
});

it("only reports validation success when preview generation has also succeeded", () => {
    expect(fileValidationState("valid", { state: "error", message: "Invalid range" })).toBe(
        "error",
    );
    expect(fileValidationState("valid", { state: "loading" })).toBe("checking");
    expect(fileValidationState("valid", { state: "pending" })).toBe("pending");
    expect(fileValidationState("error", { state: "valid" })).toBe("error");
    expect(fileValidationState("pending", { state: "valid" })).toBe("pending");
    expect(fileValidationState("valid", { state: "valid" })).toBe("valid");
    expect(fileValidationState("valid")).toBe("valid");
});

it("adds editors only to actual single-line references, preserving spaces and ignoring code/DSL examples", () => {
    const source = [
        "![](./examples/hello.rs#L1-L7)",
        "![](<examples/日本語 & example.rs#L2>)",
        "```md",
        "![](hidden.rs)",
        "```",
        "~~~schemath",
        "![](hidden.rs)",
        "~~~",
        "![]()",
        "Prose ![](hidden.rs)",
        "    ![](hidden.rs)",
    ].join("\n");
    expect(textfileLines(source)).toEqual([
        { line: 1, file: "examples/hello.rs" },
        { line: 2, file: "examples/日本語 & example.rs" },
    ]);
    const editors = createTextfileEditors(
        [],
        () => {},
        () => {},
    );
    const state = EditorState.create({ doc: source, extensions: editors.extension });
    expect(state.field(editors.extension).size).toBe(4);
    const updated = state.update({ changes: { from: 0, to: state.doc.line(1).to + 1 } }).state;
    expect(updated.field(editors.extension).size).toBe(2);
    expect(editors.hasUnsavedChanges()).toBe(false);
});

it("keeps delayed textfile autosaves on the workspace that owns the draft", async () => {
    vi.useFakeTimers();
    class Element extends EventTarget {
        dataset: Record<string, string> = {};
        children: Element[] = [];
        attributes = new Map<string, string>();
        className = "";
        append(...children: Element[]) {
            this.children.push(...children);
        }
        setAttribute(name: string, value: string) {
            this.attributes.set(name, value);
        }
        getAttribute(name: string) {
            return this.attributes.get(name) ?? null;
        }
    }
    vi.stubGlobal(
        "document",
        Object.assign(new EventTarget(), {
            createElement: () => new Element(),
            getElementById: () => undefined,
        }),
    );
    const requests: string[] = [];
    const first = vi.fn(async (_url: string, init?: RequestInit) => {
        const input = JSON.parse(String(init?.body));
        requests.push(input.action);
        return Response.json({
            content: input.action === "read" ? "original" : "formatted",
            language: "txt",
        });
    });
    const second = vi.fn();
    vi.stubGlobal("__doocConnections", {
        active: "a",
        items: new Map([
            ["a", { fetch: first }],
            ["b", { fetch: second }],
        ]),
    });
    const editors = createTextfileEditors(
        [],
        () => {},
        () => {},
    );
    const state = EditorState.create({ doc: "![](code.txt)", extensions: editors.extension });
    const widget = state.field(editors.extension).iter().value?.spec.widget;
    if (!widget) throw new Error("Missing textfile controls");
    const controls = widget.toDOM({} as EditorView) as unknown as Element;
    controls.children
        .find((child) => child.className === "pbtn cm-textfile-validate")
        ?.dispatchEvent(new Event("click"));
    await vi.waitFor(() => expect(editors.content("code.txt")).toBe("formatted"));
    if (globalThis.__doocConnections) globalThis.__doocConnections.active = "b";
    await vi.advanceTimersByTimeAsync(600);
    expect(requests).toEqual(["read", "validate", "save"]);
    expect(second).not.toHaveBeenCalled();
    expect(editors.hasUnsavedChanges()).toBe(false);
});
