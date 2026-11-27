export type NavigationProgress = (received: number, total?: number) => void;

export const readNavigationText = async (
    response: Response,
    progress?: NavigationProgress,
    signal?: AbortSignal,
): Promise<string> => {
    signal?.throwIfAborted();
    if (!progress || !response.body) return response.text();
    const length = Number(response.headers.get("content-length"));
    const encoding = response.headers.get("content-encoding");
    let total =
        Number.isSafeInteger(length) && length > 0 && (!encoding || encoding === "identity")
            ? length
            : undefined;
    progress(0, total);
    const reader = response.body.getReader();
    const cancel = () => void reader.cancel(signal?.reason).catch(() => {});
    signal?.addEventListener("abort", cancel, { once: true });
    const decoder = new TextDecoder();
    const parts: string[] = [];
    let received = 0;
    try {
        signal?.throwIfAborted();
        // shortcut: buffered RPC replies arrive at once; stream that transport for intermediate bytes.
        while (true) {
            const { done, value } = await reader.read();
            signal?.throwIfAborted();
            if (done) break;
            received += value.byteLength;
            if (total !== undefined && received > total) total = undefined;
            progress(received, total);
            parts.push(decoder.decode(value, { stream: true }));
        }
        parts.push(decoder.decode());
        return parts.join("");
    } finally {
        signal?.removeEventListener("abort", cancel);
        reader.releaseLock();
    }
};

export const startNavLoading = (signal: AbortSignal) => {
    const started = performance.now();
    const link = document.querySelector<HTMLElement>(
        "#site-title.cur, #nav-groups .nav-row > a.cur",
    );
    const label = link?.querySelector<HTMLElement>(".nav-label") ?? link;
    const timingName = `dooc:navigation:${link?.getAttribute("href")}`;
    const motion = matchMedia("(prefers-reduced-motion: reduce), (forced-colors: active)");
    let finished = false;
    let responded = false;
    let progress = 0;
    let animation: Animation | undefined;
    const clear = (): void => {
        finished = true;
        signal.removeEventListener("abort", clear);
        motion.removeEventListener("change", reduceMotion);
        animation?.cancel();
        link?.removeAttribute("aria-busy");
        if (!label) return;
        delete label.dataset.navLoading;
        label.style.removeProperty("--nav-progress");
    };
    const measure = (): number => {
        if (!label) return 0;
        // The label flexes to fill its row; measure the visible text, not the empty space.
        const range = document.createRange();
        range.selectNodeContents(label);
        return Math.min(label.clientWidth, range.getBoundingClientRect().width);
    };
    const animate = (
        fraction: number,
        duration = 240,
        easing = "cubic-bezier(.16, 1, .3, 1)",
    ): void => {
        if (!label) return;
        const from = getComputedStyle(label).getPropertyValue("--nav-progress").trim() || "0px";
        const to = `${Math.max(parseFloat(from), measure() * fraction)}px`;
        animation?.cancel();
        animation = undefined;
        label.style.setProperty("--nav-progress", to);
        if (!motion.matches && from !== to)
            animation = label.animate({ "--nav-progress": [from, to] }, { duration, easing });
    };
    const reduceMotion = (): void => {
        if (!motion.matches || !label) return;
        if (label.dataset.navLoading === "pending") {
            const current = getComputedStyle(label).getPropertyValue("--nav-progress");
            animation?.cancel();
            animation = undefined;
            label.style.setProperty("--nav-progress", current);
        } else animation?.finish();
    };
    if (!signal.aborted && label) {
        link?.setAttribute("aria-busy", "true");
        label.dataset.navLoading = "pending";
        signal.addEventListener("abort", clear, { once: true });
        motion.addEventListener("change", reduceMotion);
        const measured =
            performance.getEntriesByName(timingName).at(-1)?.duration ??
            performance.getEntriesByName("dooc:navigation").at(-1)?.duration;
        // shortcut: the first visit has no timing sample; later loads use measured durations.
        if (!motion.matches) animate(0.9, Math.max(240, measured ?? 1500), "linear");
    } else finished = true;
    return {
        update: (received: number, total?: number): void => {
            if (finished || !label) return;
            responded = true;
            if (total === undefined || received === 0) return;
            label.dataset.navLoading = "bytes";
            progress = Math.max(progress, Math.min(0.95, received / total));
            animate(progress);
        },
        finish: (success = false): void => {
            if (finished) return;
            if (!success || !label || !link?.classList.contains("cur")) {
                clear();
                return;
            }
            finished = true;
            link.removeAttribute("aria-busy");
            if (responded) {
                const end = performance.now();
                for (const name of [timingName, "dooc:navigation"]) {
                    performance.clearMeasures(name);
                    performance.measure(name, { start: started, end });
                }
            }
            const complete = (): void => {
                if (signal.aborted) return;
                if (!link.classList.contains("cur")) {
                    clear();
                    return;
                }
                motion.removeEventListener("change", reduceMotion);
                label.dataset.navLoading = "complete";
            };
            label.dataset.navLoading = "finishing";
            animate(1);
            if (animation) void animation.finished.then(complete).catch(() => {});
            else complete();
        },
    };
};
