import { mountResourceDownloads } from "../../packages/frontend/src/resource-download.ts";

// Bundle with esbuild and run testResourceDownloads() in a browser without the download runtime.
window.testResourceDownloads = async () => {
    const assert = (condition, message) => {
        if (!condition) throw new Error(message);
    };
    const wait = async (condition) => {
        for (let attempt = 0; attempt < 100; attempt++) {
            if (condition()) return;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("Download did not finish");
    };
    const originalFetch = window.fetch;
    const host = document.createElement("div");
    host.innerHTML =
        '<a href="https://example.test/source.txt" download="source.txt" data-resource-download>Download</a>';
    document.body.append(host);
    const link = host.querySelector("a");
    let fail = false;
    let release;
    const requests = [];
    const downloads = [];
    const capture = (event) => {
        const target = event.target.closest?.("a");
        if (!target?.href.startsWith("blob:")) return;
        event.preventDefault();
        downloads.push({
            filename: target.download,
            content: originalFetch(target.href).then((r) => r.text()),
        });
    };
    document.addEventListener("click", capture, true);
    window.fetch = async (url, options) => {
        requests.push({ url, options });
        await new Promise((resolve) => {
            release = resolve;
        });
        return new Response(fail ? "Denied" : "Complete source\r\nLast line\r\n", {
            status: fail ? 403 : 200,
        });
    };
    try {
        mountResourceDownloads();
        link.click();
        link.click();
        assert(requests.length === 1, "Repeated clicks must not start concurrent downloads");
        assert(link.getAttribute("aria-busy") === "true", "Show download progress");
        release();
        await wait(() => !link.hasAttribute("aria-busy"));
        assert(downloads.length === 1, "Save the fetched resource once");
        assert(downloads[0].filename === "source.txt", "Preserve the source filename");
        assert(
            (await downloads[0].content) === "Complete source\r\nLast line\r\n",
            "Preserve the complete source bytes",
        );
        assert(
            requests[0].options.credentials === "omit",
            "Do not send credentials to resource URLs",
        );
        fail = true;
        link.click();
        release();
        await wait(() => !link.hasAttribute("aria-busy"));
        assert(downloads.length === 1, "Do not save an HTTP error response");
        assert(
            host.querySelector('[role="status"]').textContent.includes("Download failed"),
            "Announce failed downloads",
        );
        fail = false;
        link.click();
        release();
        await wait(() => !link.hasAttribute("aria-busy"));
        assert(downloads.length === 2, "Allow retry after failure");
        assert(
            host.querySelector('[role="status"]').textContent === "",
            "Clear the previous error after retry",
        );
        return "Resource download checks passed";
    } finally {
        window.fetch = originalFetch;
        document.removeEventListener("click", capture, true);
        host.remove();
    }
};
