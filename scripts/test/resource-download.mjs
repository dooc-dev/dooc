import {
    mountDownloadBlock,
    mountResourceDownloads,
    mountResourceExpand,
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
    let fail = 0;
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
        if (fail === -1) throw new TypeError("Network unavailable");
        return new Response(fail ? "Denied" : "Complete source\r\nLast line\r\n", {
            status: fail || 200,
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
        fail = 403;
        link.click();
        release();
        await wait(() => !link.hasAttribute("aria-busy"));
        assert(downloads.length === 1, "Do not save an HTTP error response");
        assert(
            host.querySelector('[role="status"]').textContent === "Access denied.",
            "Announce permission failures without a long generic message",
        );
        for (const [code, message] of [
            [404, "File unavailable."],
            [503, "Download failed. Retry."],
            [-1, "Download failed. Retry."],
        ]) {
            fail = code;
            link.click();
            release();
            await wait(() => !link.hasAttribute("aria-busy"));
            assert(
                host.querySelector('[role="status"]').textContent === message,
                "Distinguish unavailable files from retryable failures",
            );
            assert(
                host.querySelectorAll('[role="status"]').length === 1,
                "Reuse the status on retries",
            );
            assert(downloads.length === 1, "Never download an error body");
        }
        fail = 0;
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

window.testResourceExpand = async () => {
    const assert = (value, message) => {
        if (!value) throw new Error(message);
    };
    const host = document.createElement("div");
    host.className = "downloadable-resource";
    host.style.width = "400px";
    host.innerHTML =
        '<svg width="400" height="240"><rect width="400" height="240" fill="teal"/></svg><div class="resource-download-tools"><button data-resource-expand>Expand</button></div>';
    document.body.append(host);
    mountResourceExpand();
    host.querySelector("button").click();
    const dialog = host.querySelector("dialog");
    const surface = dialog.querySelector(".resource-surface");
    const stage = dialog.querySelector(".resource-stage");
    let captured;
    surface.setPointerCapture = (id) => {
        captured = id;
    };
    surface.hasPointerCapture = (id) => captured === id;
    surface.releasePointerCapture = () => {
        captured = undefined;
    };
    const pointer = (type, buttons = 4, id = 1, x = 100) =>
        surface.dispatchEvent(
            new PointerEvent(type, {
                bubbles: true,
                cancelable: true,
                pointerId: id,
                button: 1,
                buttons,
                clientX: x,
                clientY: x,
            }),
        );
    try {
        surface.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, cancelable: true }));
        for (const type of ["mousedown", "auxclick"])
            assert(
                !surface.dispatchEvent(new MouseEvent(type, { button: 1, cancelable: true })),
                `Suppress native middle-button behavior on ${type}`,
            );
        for (const ending of [
            "pointerup",
            "pointercancel",
            "lostpointercapture",
            "blur",
            "mouseup",
            "released",
            "left-only",
        ]) {
            pointer("pointerdown");
            const before = stage.style.transform;
            pointer("pointermove", 4, 2, 130);
            assert(stage.style.transform === before, "Another pointer cannot move the preview");
            pointer("pointermove", 4, 1, 120);
            assert(stage.style.transform !== before, "Middle-button dragging pans the preview");
            assert(surface.style.cursor === "grabbing", "Dragging has an active cursor");
            if (ending === "blur") window.dispatchEvent(new Event("blur"));
            else if (ending === "mouseup")
                surface.dispatchEvent(new MouseEvent("mouseup", { button: 1 }));
            else if (ending === "released" || ending === "left-only")
                pointer("pointermove", ending === "released" ? 0 : 1);
            else pointer(ending, 0);
            const stopped = stage.style.transform;
            pointer("pointermove", 4, 1, 200);
            assert(stage.style.transform === stopped, `${ending} ends panning`);
            assert(
                captured === undefined && surface.style.cursor === "grab",
                `${ending} releases capture and the cursor`,
            );
        }
        const zoom = () => dialog.querySelector("output").textContent;
        dialog.querySelector('[data-zoom="reset"]').click();
        assert(zoom() === "100%", "Reset returns to fit size");
        surface.dispatchEvent(
            new KeyboardEvent("keydown", { key: "+", bubbles: true, cancelable: true }),
        );
        assert(zoom() === "125%", "Keyboard zoom works without a wheel");
        const beforeArrow = stage.style.transform;
        surface.dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
        );
        assert(stage.style.transform !== beforeArrow, "Arrow keys pan the preview");
        dialog.querySelector('[data-zoom="out"]').click();
        assert(zoom() === "100%", "Zoom buttons work without a keyboard");
        const touch = (type, id, x) =>
            surface.dispatchEvent(
                new PointerEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    pointerType: "touch",
                    pointerId: id,
                    button: 0,
                    buttons: type === "pointerup" ? 0 : 1,
                    clientX: x,
                    clientY: 100,
                }),
            );
        touch("pointerdown", 10, 100);
        touch("pointerdown", 11, 200);
        touch("pointermove", 11, 300);
        assert(zoom() === "200%", "Two touch points pinch to zoom");
        touch("pointerup", 11, 300);
        const beforeTouchPan = stage.style.transform;
        touch("pointermove", 10, 140);
        assert(stage.style.transform !== beforeTouchPan, "The remaining touch point can pan");
        touch("pointercancel", 10, 140);
        const afterCancel = stage.style.transform;
        touch("pointermove", 10, 180);
        assert(
            stage.style.transform === afterCancel && surface.style.cursor === "grab",
            "Touch cancellation ends the gesture",
        );
        pointer("pointerdown");
        dialog.close();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        assert(!dialog.isConnected && captured === undefined, "Closing releases an active drag");
    } finally {
        if (dialog.open) dialog.close();
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
