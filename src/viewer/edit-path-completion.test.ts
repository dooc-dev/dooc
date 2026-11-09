import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { afterEach, expect, it, vi } from "vitest";
import { filePathCompletion } from "./edit-path-completion.js";

afterEach(() => vi.unstubAllGlobals());
const context = (doc: string) =>
    new CompletionContext(EditorState.create({ doc }), doc.length, false);

it.each(["[Link](", "![Preview]("])("completes actual folders and files in %s", async (start) => {
    const fetch = vi
        .fn()
        .mockResolvedValue(
            Response.json(["contents/guide.md", "contents/images/", "contents/日本語 (1).md"]),
        );
    vi.stubGlobal("fetch", fetch);
    const result = await filePathCompletion(context(`${start}contents/`), [
        { label: "contents/guide.md", detail: "Guide" },
    ]);
    expect(fetch).toHaveBeenCalledWith(
        "/api/files",
        expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ action: "complete", prefix: "contents/" }),
        }),
    );
    expect(result?.from).toBe(start.length);
    expect(result?.options).toEqual([
        { label: "contents/guide.md", detail: "Guide" },
        { label: "contents/images/", displayLabel: "contents/images/", type: "namespace" },
        {
            label: "contents/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%281%29.md",
            displayLabel: "contents/日本語 (1).md",
            type: "text",
        },
    ]);
});

it("decodes typed paths, leaves URLs alone, and keeps known references if listing fails", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("Offline"));
    vi.stubGlobal("fetch", fetch);
    const references = [{ label: "contents/guide.md" }];
    expect(await filePathCompletion(context("[](contents/my%20folder/"), references)).toMatchObject(
        { options: references },
    );
    expect(fetch.mock.calls[0]?.[1].body).toContain("contents/my folder/");
    fetch.mockClear();
    for (const doc of ["[](https://example.com/", "[](contents/a.md#L1", "[](bad%"])
        expect(await filePathCompletion(context(doc), references)).toBeNull();
    expect(filePathCompletion(context("ordinary text"), references)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
});

it("does not use a response after the completion context was aborted", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
        "fetch",
        vi.fn(
            () =>
                new Promise<Response>((resolve) => {
                    finish = resolve;
                }),
        ),
    );
    const ctx = context("[](");
    const result = filePathCompletion(ctx, []);
    vi.spyOn(ctx, "aborted", "get").mockReturnValue(true);
    finish(Response.json(["contents/"]));
    expect(await result).toBeNull();
});
