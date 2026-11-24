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
 * Expanded view with pointer, keyboard and touch zoom and pan controls.
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
            '<div class="resource-stage"></div><div class="resource-surface" tabindex="0" role="region" aria-label="Image preview"></div><div class="resource-modal-bar"><output>100%</output><button type="button" data-zoom="out" aria-label="Zoom out">−</button><button type="button" data-zoom="reset" aria-label="Reset zoom">100%</button><button type="button" data-zoom="in" aria-label="Zoom in">+</button><button data-close type="button" class="resource-download resource-expand" title="Close" aria-label="Close"><svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15"/></svg></button></div>';
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
        const points = new Map<number, { x: number; y: number }>();
        const translate = (key: string): string =>
            (window as Window & { __docsTranslate?: (key: string) => string }).__docsTranslate?.(
                key,
            ) ?? key;
        for (const control of dialog.querySelectorAll<HTMLElement>("[aria-label]")) {
            const label = translate(control.getAttribute("aria-label") ?? "");
            control.setAttribute("aria-label", label);
            control.title = label;
        }
        const apply = (): void => {
            const fit = Math.min(
                (dialog.clientWidth - 48) / stage.offsetWidth,
                (dialog.clientHeight - 48) / stage.offsetHeight,
                4,
            );
            stage.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) scale(${fit * zoom})`;
            surface.style.cursor = points.size ? "grabbing" : zoom === 1 ? "" : "grab";
            (bar.firstElementChild as HTMLElement).textContent = `${Math.round(zoom * 100)}%`;
        };
        const setZoom = (value: number, cx = 0, cy = 0): void => {
            const next = Math.min(16, Math.max(0.25, value));
            x = next === 1 ? 0 : cx - ((cx - x) * next) / zoom;
            y = next === 1 ? 0 : cy - ((cy - y) * next) / zoom;
            zoom = next;
        };
        // shortcut: expanded HTML is a preview; the surface owns its zoom and pan gestures.
        surface.addEventListener(
            "wheel",
            (wheel) => {
                wheel.preventDefault();
                let next = zoom * (wheel.deltaY < 0 ? 1.1 : 1 / 1.1);
                if (Math.abs(next - 1) < 0.04) next = 1;
                const box = surface.getBoundingClientRect();
                setZoom(
                    next,
                    wheel.clientX - box.left - box.width / 2,
                    wheel.clientY - box.top - box.height / 2,
                );
                apply();
            },
            { passive: false },
        );
        for (const type of ["mousedown", "auxclick"])
            surface.addEventListener(type, (event) => {
                if ((event as MouseEvent).button === 1) event.preventDefault();
            });
        const release = (id: number): void => {
            points.delete(id);
            if (surface.hasPointerCapture(id)) surface.releasePointerCapture(id);
            apply();
        };
        const stop = (): void => {
            for (const id of [...points.keys()]) release(id);
        };
        surface.addEventListener("pointerdown", (down) => {
            if (
                points.size >= 2 ||
                (down.pointerType !== "touch" && (points.size || zoom === 1 || down.button !== 1))
            )
                return;
            down.preventDefault();
            points.set(down.pointerId, { x: down.clientX, y: down.clientY });
            surface.setPointerCapture(down.pointerId);
            apply();
        });
        surface.addEventListener("pointermove", (drag) => {
            const previous = points.get(drag.pointerId);
            if (!previous) return;
            if (drag.pointerType !== "touch" && !(drag.buttons & 4)) return release(drag.pointerId);
            const other = [...points.entries()].find(([id]) => id !== drag.pointerId)?.[1];
            if (other) {
                const before = Math.hypot(previous.x - other.x, previous.y - other.y);
                const after = Math.hypot(drag.clientX - other.x, drag.clientY - other.y);
                if (before > 0 && after > 0) {
                    const box = surface.getBoundingClientRect();
                    setZoom(
                        (zoom * after) / before,
                        (previous.x + other.x) / 2 - box.left - box.width / 2,
                        (previous.y + other.y) / 2 - box.top - box.height / 2,
                    );
                    x += (drag.clientX - previous.x) / 2;
                    y += (drag.clientY - previous.y) / 2;
                }
            } else if (zoom !== 1) {
                x += drag.clientX - previous.x;
                y += drag.clientY - previous.y;
            }
            points.set(drag.pointerId, { x: drag.clientX, y: drag.clientY });
            apply();
        });
        const endPointer = (event: Event): void => {
            const id = (event as PointerEvent).pointerId;
            if (points.has(id)) release(id);
        };
        for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
            surface.addEventListener(type, endPointer);
        window.addEventListener("pointerup", endPointer);
        surface.addEventListener("mouseup", (up) => {
            if (up.button === 1) stop();
        });
        window.addEventListener("blur", stop);
        const visibility = () => {
            if (document.hidden) stop();
        };
        document.addEventListener("visibilitychange", visibility);
        bar.addEventListener("click", (event) => {
            const button = (event.target as Element).closest<HTMLButtonElement>("button");
            if (!button) return;
            if (button.hasAttribute("data-close")) {
                dialog.close();
                return;
            }
            stop();
            setZoom(
                button.dataset.zoom === "reset"
                    ? 1
                    : zoom * (button.dataset.zoom === "in" ? 1.25 : 0.8),
            );
            apply();
        });
        dialog.addEventListener("keydown", (event) => {
            if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
            if (["+", "=", "-", "0", "Home"].includes(event.key)) {
                setZoom(
                    event.key === "0" || event.key === "Home"
                        ? 1
                        : zoom * (event.key === "-" ? 0.8 : 1.25),
                );
            } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
                const step = event.shiftKey ? 120 : 40;
                x += event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0;
                y += event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0;
            } else return;
            event.preventDefault();
            event.stopPropagation();
            apply();
        });
        dialog.addEventListener("click", (click) => click.stopPropagation());
        dialog.addEventListener("close", () => {
            stop();
            window.removeEventListener("blur", stop);
            window.removeEventListener("pointerup", endPointer);
            document.removeEventListener("visibilitychange", visibility);
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
