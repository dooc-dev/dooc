import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { embedBundleUrls } from "./bundle-urls.js";
import { type DownloadProgress, setDownloadProgressListener } from "./download-progress.js";
import { fetchPublicFile } from "./public-file.js";

vi.mock("./public-file.js", () => ({ fetchPublicFile: vi.fn() }));
let root: string;
let events: DownloadProgress[];
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dooc-bundle-progress-"));
    writeFileSync(join(root, "dooc.yaml"), "docs: [guide]\n");
    events = [];
    setDownloadProgressListener((event) => events.push(event));
    vi.mocked(fetchPublicFile).mockReset();
});
afterEach(() => {
    setDownloadProgressListener();
    rmSync(root, { recursive: true, force: true });
});

it("reports nested asset downloads once even when referenced repeatedly", async () => {
    const page = "https://example.com/page.html";
    const image = "https://example.com/image.png";
    const html = '<img src="image.png"><img src="image.png">';
    vi.mocked(fetchPublicFile).mockImplementation(async (url, contentType, progress) => {
        const body = Buffer.from(url === page ? html : "image");
        contentType?.(url === page ? "text/html" : "image/png");
        progress?.(0, body.length);
        progress?.(2, body.length);
        progress?.(body.length, body.length);
        return body;
    });
    const entries = await embedBundleUrls(root, [
        { name: "content/guide.md", data: Buffer.from(`![](${page})\n\n![](${page})\n`) },
    ]);
    expect(fetchPublicFile).toHaveBeenCalledTimes(2);
    expect(events).toEqual(
        [page, image].flatMap((url) => {
            const total = url === page ? Buffer.byteLength(html) : 5;
            return [
                { url, state: "start", received: 0 },
                { url, state: "progress", received: 0, total },
                { url, state: "progress", received: 2, total },
                { url, state: "progress", received: total, total },
                { url, state: "complete", received: total, total },
            ];
        }),
    );
    expect(entries.find((entry) => entry.name.endsWith(".html"))?.data.toString()).toContain(
        "data:image/png;base64,aW1hZ2U=",
    );
});

it("reports failed downloads with bytes received and preserves contextual errors", async () => {
    const url = "https://example.com/missing.txt";
    vi.mocked(fetchPublicFile).mockImplementation(async (_url, _type, progress) => {
        progress?.(2);
        throw new Error("UNAVAILABLE");
    });
    await expect(
        embedBundleUrls(root, [{ name: "content/guide.md", data: Buffer.from(`![](${url})`) }]),
    ).rejects.toThrow(`${url}: UNAVAILABLE`);
    expect(events).toEqual([
        { url, state: "start", received: 0 },
        { url, state: "progress", received: 2, total: undefined },
        { url, state: "error", received: 2, total: undefined },
    ]);
});
