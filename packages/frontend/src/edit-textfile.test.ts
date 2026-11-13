import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import { createTextfileEditors, fileValidationState, textfileLines } from "./edit-textfile.js";

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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
