// shortcut: browser-owned PDF and remote frame controls need host policy for stronger restrictions.
export function mountDownloadBlock(): void {
    const style = document.createElement("style");
    style.textContent =
        'html { -webkit-touch-callout: none; } a[download], a[data-resource-download], a[href^="data:"], a[href^="blob:"] { display: none !important; } @media print { body { display: none !important; } }';
    document.head.append(style);
    const stopDownload = (event: MouseEvent): void => {
        if (
            !(event.target instanceof Element) ||
            !event.target.closest(
                'a[download], a[data-resource-download], a[href^="data:"], a[href^="blob:"]',
            )
        )
            return;
        event.preventDefault();
        event.stopImmediatePropagation();
    };
    document.addEventListener("click", stopDownload, true);
    document.addEventListener("auxclick", stopDownload, true);
    document.addEventListener(
        "keydown",
        (event) => {
            if ((event.ctrlKey || event.metaKey) && ["s", "p"].includes(event.key.toLowerCase())) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        },
        true,
    );
    document.addEventListener("contextmenu", (event) => event.preventDefault(), true);
    document.addEventListener(
        "dragstart",
        (event) => {
            if (
                event.target instanceof Element &&
                event.target.closest("img, video, audio, object, a[download]")
            )
                event.preventDefault();
        },
        true,
    );
    const restrictMedia = (): void => {
        for (const media of document.querySelectorAll("video, audio")) {
            const controls = new Set(
                (media.getAttribute("controlslist") ?? "").split(/\s+/).filter(Boolean),
            );
            controls.add("nodownload");
            media.setAttribute("controlslist", [...controls].join(" "));
        }
        for (const pdf of document.querySelectorAll<HTMLObjectElement>(
            'object[type="application/pdf"]',
        )) {
            if (!/[#&]toolbar=0(?:&|$)/.test(pdf.data))
                pdf.data += `${pdf.data.includes("#") ? "&" : "#"}toolbar=0`;
        }
        for (const frame of document.querySelectorAll("iframe")) {
            if (!frame.hasAttribute("sandbox")) frame.setAttribute("sandbox", "allow-scripts");
            frame.sandbox.remove("allow-downloads");
            if (!frame.srcdoc) continue;
            if (!frame.sandbox.contains("allow-scripts")) {
                // Script-free SVG frames cannot intercept their own context menu.
                frame.style.pointerEvents = "none";
            } else if (!frame.srcdoc.includes("<script data-dooc-download-block>")) {
                const script =
                    `var __name = (f) => f; (${mountDownloadBlock.toString()})();`.replace(
                        /<\/(script)/gi,
                        "<\\/$1",
                    );
                frame.srcdoc += `<script data-dooc-download-block>${script}</script>`;
            }
        }
    };
    new MutationObserver(restrictMedia).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["srcdoc"],
    });
    restrictMedia();
}

/** Self-contained for standalone HTML; data URLs use the browser's native download behavior. */
export const mountResourceDownloads = (
    request: (url: string, init?: RequestInit, workspace?: string) => Promise<Response> = fetch,
): void => {
    document.addEventListener("click", async (event) => {
        const link =
            event.target instanceof Element
                ? event.target.closest<HTMLAnchorElement>("a[data-resource-download]")
                : null;
        if (!link || !/^https?:/.test(link.href)) return;
        event.preventDefault();
        if (link.getAttribute("aria-busy") === "true") return;
        const status =
            link.parentElement?.querySelector("[role=status]") ?? document.createElement("span");
        status.setAttribute("role", "status");
        status.textContent = "Downloading…";
        link.after(status);
        link.setAttribute("aria-busy", "true");
        try {
            const response = await request(
                link.href,
                {
                    credentials: "omit",
                    referrerPolicy: "no-referrer",
                    signal: AbortSignal.timeout(30000),
                },
                link.closest<HTMLElement>("[data-workspace]")?.dataset.workspace,
            );
            if (!response.ok) throw new Error();
            const url = URL.createObjectURL(await response.blob());
            const download = document.createElement("a");
            download.href = url;
            download.download = link.download;
            document.body.append(download);
            download.click();
            download.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
            status.textContent = "";
        } catch {
            status.textContent =
                "Download failed. Check your connection and the source's download permissions, then try again.";
        } finally {
            link.removeAttribute("aria-busy");
        }
    });
};

/**
 * Expanded view of a block: wheel zooms around the pointer, middle-button dragging pans while zoomed.
 * Self-contained (stringified with toString and embedded in the page).
 */
export const mountResourceExpand = (): void => {
    document.addEventListener("click", (event) => {
        const source =
            event.target instanceof Element
                ? event.target
                      .closest("[data-resource-expand]")
                      ?.closest<HTMLElement>(".downloadable-resource")
                : null;
        if (!source) return;
        const dialog = document.createElement("dialog");
        dialog.className = "resource-modal";
        dialog.innerHTML =
            '<div class="resource-stage"></div><div class="resource-surface"></div><div class="resource-modal-bar"><output>100%</output><button type="button" class="resource-download resource-expand" title="Close" aria-label="Close"><svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15"/></svg></button></div>';
        const [stage, surface, bar] = dialog.children as unknown as HTMLElement[];
        if (!stage || !surface || !bar) return;
        // The copy keeps the inline layout width; 100% is that layout scaled to fit the dialog.
        stage.style.width = `${source.getBoundingClientRect().width}px`;
        for (const node of source.children)
            if (!node.classList.contains("resource-download-tools"))
                stage.append(node.cloneNode(true));
        let zoom = 1;
        let x = 0;
        let y = 0;
        const apply = (): void => {
            const fit = Math.min(
                (dialog.clientWidth - 48) / stage.offsetWidth,
                (dialog.clientHeight - 48) / stage.offsetHeight,
                4,
            );
            stage.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) scale(${fit * zoom})`;
            surface.style.cursor = zoom === 1 ? "" : "grab";
            (bar.firstElementChild as HTMLElement).textContent = `${Math.round(zoom * 100)}%`;
        };
        // shortcut: the surface takes every pointer event, so embedded HTML is not interactive
        // while expanded; forward events to the frame if that is needed.
        surface.addEventListener(
            "wheel",
            (wheel) => {
                wheel.preventDefault();
                let next = Math.min(16, Math.max(0.25, zoom * (wheel.deltaY < 0 ? 1.1 : 1 / 1.1)));
                if (Math.abs(next - 1) < 0.04) next = 1;
                const box = surface.getBoundingClientRect();
                const cx = wheel.clientX - box.left - box.width / 2;
                const cy = wheel.clientY - box.top - box.height / 2;
                // Keep the point under the pointer fixed; 100% always returns to the centre.
                x = next === 1 ? 0 : cx - ((cx - x) * next) / zoom;
                y = next === 1 ? 0 : cy - ((cy - y) * next) / zoom;
                zoom = next;
                apply();
            },
            { passive: false },
        );
        // The middle button pans; cancelling mousedown keeps the browser's autoscroll off.
        surface.addEventListener("mousedown", (down) => {
            if (down.button === 1) down.preventDefault();
        });
        surface.addEventListener("pointerdown", (down) => {
            if (zoom === 1 || down.button !== 1) return;
            surface.setPointerCapture(down.pointerId);
            const startX = x - down.clientX;
            const startY = y - down.clientY;
            const move = (drag: PointerEvent): void => {
                x = startX + drag.clientX;
                y = startY + drag.clientY;
                apply();
            };
            surface.addEventListener("pointermove", move);
            surface.addEventListener(
                "lostpointercapture",
                () => surface.removeEventListener("pointermove", move),
                { once: true },
            );
        });
        bar.querySelector("button")?.addEventListener("click", () => dialog.close());
        dialog.addEventListener("click", (click) => click.stopPropagation());
        dialog.addEventListener("close", () => {
            resize.disconnect();
            dialog.remove();
        });
        const resize = new ResizeObserver(apply);
        // Inside the block so the copy inherits its pane's theme; a modal dialog still fills the viewport.
        source.append(dialog);
        dialog.showModal();
        resize.observe(stage);
        resize.observe(dialog);
    });
};
