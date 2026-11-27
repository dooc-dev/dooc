import { expect, it, vi } from "vitest";
import { readNavigationText } from "./nav-loading.js";

const bytes = new TextEncoder().encode("A日本語🙂Z");
const stream = (headers: HeadersInit = {}) => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const response = new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                source = controller;
            },
            cancel,
        }),
        { headers },
    );
    return { response, source, cancel };
};

it("counts received bytes and decodes text split inside a multibyte character", async () => {
    const { response, source } = stream({ "content-length": String(bytes.byteLength) });
    const progress = vi.fn();
    const text = readNavigationText(response, progress);
    expect(progress).toHaveBeenLastCalledWith(0, bytes.byteLength);
    source.enqueue(bytes.slice(0, 2));
    await vi.waitFor(() => expect(progress).toHaveBeenLastCalledWith(2, bytes.byteLength));
    source.enqueue(bytes.slice(2));
    source.close();
    expect(await text).toBe(new TextDecoder().decode(bytes));
    expect(progress).toHaveBeenLastCalledWith(bytes.byteLength, bytes.byteLength);
    expect(response.body?.locked).toBe(false);
});

it.each<HeadersInit>([
    {},
    { "content-length": "0" },
    { "content-length": "-1" },
    { "content-length": "invalid" },
    { "content-length": "9007199254740992" },
    { "content-length": String(bytes.byteLength), "content-encoding": "gzip" },
])("does not invent progress for an unknown or encoded length: %j", async (headers) => {
    const { response, source } = stream(headers);
    const progress = vi.fn();
    const text = readNavigationText(response, progress);
    source.enqueue(bytes);
    source.close();
    expect(await text).toBe(new TextDecoder().decode(bytes));
    expect(progress.mock.calls).toEqual([
        [0, undefined],
        [bytes.byteLength, undefined],
    ]);
});

it("drops an invalid total instead of overflowing the label", async () => {
    const { response, source } = stream({ "content-length": "1" });
    const progress = vi.fn();
    const text = readNavigationText(response, progress);
    source.enqueue(bytes);
    source.close();
    await text;
    expect(progress).toHaveBeenLastCalledWith(bytes.byteLength, undefined);
});

it.each(["abort", "error"])("releases a stalled stream after %s", async (failure) => {
    const { response, source, cancel } = stream({ "content-length": String(bytes.byteLength) });
    const progress = vi.fn();
    const controller = new AbortController();
    const text = readNavigationText(response, progress, controller.signal);
    source.enqueue(bytes.slice(0, 1));
    await vi.waitFor(() => expect(progress).toHaveBeenCalledTimes(2));
    const error = new Error(failure);
    if (failure === "abort") controller.abort(error);
    else source.error(error);
    await expect(text).rejects.toBe(error);
    expect(progress).toHaveBeenCalledTimes(2);
    expect(response.body?.locked).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(failure === "abort" ? 1 : 0);
});
