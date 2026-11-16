import {
    mountDownloadBlock,
    mountResourceDownloads,
} from "../../packages/frontend/src/resource-download.ts";

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

window.testDownloadBlock = async () => {
    const assert = (condition, message) => {
        if (!condition) throw new Error(message);
    };
    const host = document.createElement("div");
    host.innerHTML =
        '<a download="source.txt" href="data:text/plain,source"><span>Save</span></a><a href="#read">Read</a><video controls controlslist="nofullscreen"></video><img alt="Preview">';
    document.body.append(host);
    const cancelled = (target, event) => {
        target.dispatchEvent(event);
        return event.defaultPrevented;
    };
    const click = () => new MouseEvent("click", { bubbles: true, cancelable: true });
    mountDownloadBlock();
    assert(cancelled(host.querySelector("span"), click()), "Block downloads from child elements");
    assert(
        cancelled(
            host.querySelector("span"),
            new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }),
        ),
        "Block middle-click downloads",
    );
    assert(!cancelled(host.querySelector('a[href="#read"]'), click()), "Keep reading links active");
    for (const modifier of ["ctrlKey", "metaKey"])
        for (const key of ["s", "p"])
            assert(
                cancelled(
                    document,
                    new KeyboardEvent("keydown", { key, [modifier]: true, cancelable: true }),
                ),
                "Suppress page save and print shortcuts",
            );
    assert(
        !cancelled(
            document,
            new KeyboardEvent("keydown", { key: "c", ctrlKey: true, cancelable: true }),
        ),
        "Preserve copying and other shortcuts",
    );
    assert(
        cancelled(
            host.querySelector("img"),
            new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
        ),
        "Suppress image save menus",
    );
    assert(
        cancelled(
            host.querySelector("img"),
            new DragEvent("dragstart", { bubbles: true, cancelable: true }),
        ),
        "Suppress image dragging to save",
    );
    assert(
        host.querySelector("video").getAttribute("controlslist") === "nofullscreen nodownload",
        "Preserve media controls while hiding download",
    );
    const added = document.createElement("audio");
    host.append(added);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(
        added.getAttribute("controlslist") === "nodownload",
        "Restrict media added after navigation",
    );
    const frame = document.createElement("iframe");
    frame.sandbox = "allow-scripts allow-same-origin allow-downloads";
    frame.srcdoc =
        '<details><summary>Read more</summary>Body</details><a download="note.txt" href="data:text/plain,note">Save</a>';
    host.append(frame);
    let frameBlocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
        const doc = frame.contentDocument;
        if (doc?.querySelector("details"))
            frameBlocked = cancelled(
                doc,
                new frame.contentWindow.MouseEvent("contextmenu", { cancelable: true }),
            );
        if (frameBlocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(frameBlocked, "Suppress save menus inside embedded HTML");
    assert(!frame.sandbox.contains("allow-downloads"), "Keep frame downloads sandboxed");
    frame.contentDocument.querySelector("summary").click();
    assert(
        frame.contentDocument.querySelector("details").open,
        "Keep embedded disclosures interactive",
    );
    assert(
        frame.contentWindow.getComputedStyle(frame.contentDocument.querySelector("a")).display ===
            "none",
        "Hide embedded download controls",
    );
    const svg = document.createElement("iframe");
    svg.sandbox = "";
    svg.srcdoc =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
    host.append(svg);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(
        svg.style.pointerEvents === "none",
        "Prevent native save menus in script-free SVG frames",
    );
    assert(!svg.sandbox.contains("allow-scripts"), "Never enable scripts to block SVG saving");
    host.remove();
    return "Download block checks passed";
};
