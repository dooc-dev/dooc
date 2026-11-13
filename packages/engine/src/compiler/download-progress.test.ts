import { afterEach, expect, it, vi } from "vitest";
import { reportDownloadProgress, setDownloadProgressListener } from "./download-progress.js";

afterEach(() => setDownloadProgressListener());

it("only notifies the current optional listener and isolates reporting failures", () => {
    const event = { url: "https://example.com/file", state: "start", received: 0 } as const;
    expect(() => reportDownloadProgress(event)).not.toThrow();
    const first = vi.fn();
    setDownloadProgressListener(first);
    reportDownloadProgress(event);
    expect(first).toHaveBeenCalledWith(event);
    expect(first).toHaveBeenCalledTimes(1);
    setDownloadProgressListener(() => {
        throw new Error("Display failed");
    });
    expect(() => reportDownloadProgress(event)).not.toThrow();
    setDownloadProgressListener();
    reportDownloadProgress(event);
    expect(first).toHaveBeenCalledTimes(1);
});
