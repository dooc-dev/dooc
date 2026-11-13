import { afterEach, expect, it, vi } from "vitest";
import { fetchPublicFile } from "./browser-host.js";

afterEach(() => vi.unstubAllGlobals());

it("reports browser stream bytes and uses unknown totals for decoded bodies", async () => {
    for (const encoding of [undefined, "gzip"]) {
        const headers = new Headers({ "content-length": "5" });
        if (encoding) headers.set("content-encoding", encoding);
        const fetch = vi.fn().mockResolvedValue(
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode("he"));
                        controller.enqueue(new TextEncoder().encode("llo"));
                        controller.close();
                    },
                }),
                { headers },
            ),
        );
        vi.stubGlobal("fetch", fetch);
        const progress = vi.fn();
        expect(
            (await fetchPublicFile("https://example.com/file", undefined, progress)).toString(),
        ).toBe("hello");
        const total = encoding ? undefined : 5;
        expect(progress.mock.calls).toEqual([
            [0, total],
            [2, total],
            [5, total],
        ]);
        expect(fetch).toHaveBeenCalledWith(
            new URL("https://example.com/file"),
            expect.objectContaining({
                credentials: "omit",
                redirect: "error",
                referrerPolicy: "no-referrer",
                signal: expect.any(AbortSignal),
            }),
        );
    }
});

it("keeps browser URL and size bounds with progress enabled", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array(2 * 1024 * 1024 + 1)));
    vi.stubGlobal("fetch", fetch);
    const progress = vi.fn();
    await expect(fetchPublicFile("https://127.0.0.1/file", undefined, progress)).rejects.toThrow(
        "public HTTPS",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
    await expect(fetchPublicFile("https://example.com/file", undefined, progress)).rejects.toThrow(
        "File exceeds 2 MiB",
    );
});
