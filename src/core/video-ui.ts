/** Self-contained so playback controls also work in exported HTML. */
export function mountVideos(doc: Document): void {
    const mobile = window.matchMedia("(max-width: 600px)");
    const mounted = new WeakMap<HTMLVideoElement, () => void>();
    let nextSettingsId = 0;
    let activeOptions: HTMLDivElement | undefined;
    const closeOptions = () => {
        if (activeOptions?.matches(":popover-open")) activeOptions.hidePopover();
    };
    const label = (key: string) =>
        (window as Window & { __docsTranslate?: (key: string) => string }).__docsTranslate?.(key) ??
        key;
    const name = (element: HTMLElement, key: string) => {
        element.dataset.i18nAriaLabel = key;
        element.dataset.i18nTitle = key;
        element.setAttribute("aria-label", label(key));
        element.title = label(key);
    };
    const icon = (path: string) =>
        `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
    const playIcon = icon('<path d="m8 5 11 7-11 7Z"/>');
    const pauseIcon = icon('<path d="M8 5v14M16 5v14"/>');
    const soundIcon = icon(
        '<path d="m11 5-6 4H2v6h3l6 4ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
    );
    const muteIcon = icon('<path d="m11 5-6 4H2v6h3l6 4Zm5 4 6 6m0-6-6 6"/>');
    const clock = (value: number): string => {
        const seconds = Math.floor(Number.isFinite(value) ? Math.max(0, value) : 0);
        const minutes = Math.floor(seconds / 60);
        return `${minutes >= 60 ? `${Math.floor(minutes / 60)}:` : ""}${minutes >= 60 ? String(minutes % 60).padStart(2, "0") : minutes}:${String(seconds % 60).padStart(2, "0")}`;
    };
    const initialize = () => {
        for (const video of doc.querySelectorAll<HTMLVideoElement>("video[data-dooc-video]")) {
            if (mounted.has(video) || video.closest("a")) continue;
            const player = doc.createElement("div");
            player.className = "video-player";
            video.before(player);
            player.append(video);
            const bar = doc.createElement("div");
            bar.className = "video-controls";
            const button = (key: string, markup: string) => {
                const element = doc.createElement("button");
                element.type = "button";
                name(element, key);
                element.innerHTML = markup;
                return element;
            };
            const play = button("Play", playIcon);
            const seek = doc.createElement("input");
            seek.type = "range";
            seek.min = "0";
            seek.max = "0";
            seek.step = "0.1";
            seek.value = "0";
            seek.className = "video-seek";
            name(seek, "Seek");
            const time = doc.createElement("span");
            time.className = "video-time";
            const mute = button("Mute", soundIcon);
            const volume = doc.createElement("input");
            volume.type = "range";
            volume.min = "0";
            volume.max = "1";
            volume.step = "0.05";
            volume.className = "video-volume";
            name(volume, "Volume");
            const settings = button(
                "Video settings",
                icon(
                    '<path d="M4 7h2m6 0h8M4 17h8m6 0h2"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
                ),
            );
            settings.setAttribute("aria-expanded", "false");
            const options = doc.createElement("div");
            options.className = "video-settings";
            options.id = `video-settings-${++nextSettingsId}`;
            options.popover = "auto";
            options.setAttribute("role", "dialog");
            name(options, "Video settings");
            settings.setAttribute("aria-haspopup", "dialog");
            settings.setAttribute("aria-controls", options.id);
            const speedLabel = doc.createElement("label");
            const speedText = doc.createElement("span");
            speedText.dataset.i18n = "Playback speed";
            speedText.textContent = label("Playback speed");
            const speed = doc.createElement("input");
            speed.type = "range";
            speed.min = "1";
            speed.max = "5";
            speed.step = "0.25";
            speed.className = "video-speed";
            name(speed, "Playback speed");
            const speedValue = doc.createElement("span");
            speedValue.className = "video-speed-value";
            speedLabel.append(speedText, speedValue, speed);
            options.append(speedLabel);
            const fullscreen = button(
                "Fullscreen",
                icon('<path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/>'),
            );
            fullscreen.hidden = !doc.fullscreenEnabled;
            const status = doc.createElement("p");
            status.className = "video-status";
            status.setAttribute("role", "status");
            status.hidden = true;
            const fail = (key: string) => {
                status.dataset.i18n = key;
                status.textContent = label(key);
                status.hidden = false;
            };
            const sync = () => {
                const overlay = mobile.matches || !!doc.fullscreenElement?.contains(video);
                video.controls = overlay;
                bar.hidden = overlay;
                if (overlay && options.matches(":popover-open")) {
                    options.hidePopover();
                    settings.setAttribute("aria-expanded", "false");
                }
                const paused = video.paused || video.ended;
                name(play, paused ? "Play" : "Pause");
                if (play.dataset.paused !== String(paused)) {
                    play.innerHTML = paused ? playIcon : pauseIcon;
                    play.dataset.paused = String(paused);
                }
                const duration = Number.isFinite(video.duration) ? video.duration : 0;
                seek.disabled = duration <= 0 || !!video.error;
                play.disabled = !!video.error;
                seek.max = String(duration);
                seek.value = String(video.currentTime);
                seek.style.setProperty(
                    "--video-progress",
                    `${duration > 0 ? Math.min(100, (video.currentTime / duration) * 100) : 0}%`,
                );
                seek.setAttribute(
                    "aria-valuetext",
                    `${clock(video.currentTime)} / ${clock(duration)}`,
                );
                time.textContent = `${clock(video.currentTime)} / ${clock(duration)}`;
                const silent = video.muted || video.volume === 0;
                name(mute, silent ? "Unmute" : "Mute");
                if (mute.dataset.muted !== String(silent)) {
                    mute.innerHTML = silent ? muteIcon : soundIcon;
                    mute.dataset.muted = String(silent);
                }
                volume.value = String(video.muted ? 0 : video.volume);
                volume.style.setProperty("--video-progress", `${Number(volume.value) * 100}%`);
                volume.setAttribute("aria-valuetext", `${Math.round(Number(volume.value) * 100)}%`);
                speed.value = String(video.playbackRate);
                speed.style.setProperty(
                    "--video-progress",
                    `${((Number(speed.value) - 1) / 4) * 100}%`,
                );
                speed.setAttribute("aria-valuetext", `${video.playbackRate}×`);
                speedValue.textContent = `${video.playbackRate}×`;
            };
            play.addEventListener("click", async () => {
                if (!video.paused && !video.ended) video.pause();
                else {
                    status.hidden = true;
                    try {
                        await video.play();
                    } catch {
                        fail("Video could not be played");
                    }
                }
            });
            seek.addEventListener("input", () => {
                video.currentTime = Number(seek.value);
                sync();
            });
            mute.addEventListener("click", () => {
                if (video.muted || video.volume === 0) {
                    video.muted = false;
                    if (video.volume === 0) video.volume = 1;
                } else video.muted = true;
                sync();
            });
            volume.addEventListener("input", () => {
                video.volume = Number(volume.value);
                video.muted = video.volume === 0;
                sync();
            });
            settings.addEventListener("click", () => {
                if (options.matches(":popover-open")) {
                    options.hidePopover();
                    return;
                }
                options.showPopover();
                activeOptions = options;
                const rect = settings.getBoundingClientRect();
                options.style.left = `${Math.max(8, Math.min(rect.right - options.offsetWidth, window.innerWidth - options.offsetWidth - 8))}px`;
                options.style.top = `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - options.offsetHeight - 8))}px`;
                settings.setAttribute("aria-expanded", "true");
                speed.focus({ preventScroll: true });
            });
            options.addEventListener("toggle", () => {
                const open = options.matches(":popover-open");
                settings.setAttribute("aria-expanded", String(open));
                if (!open && activeOptions === options) activeOptions = undefined;
            });
            options.addEventListener("keydown", (event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                options.hidePopover();
                settings.setAttribute("aria-expanded", "false");
                settings.focus();
            });
            speed.addEventListener("input", () => {
                video.playbackRate = Number(speed.value);
                sync();
            });
            fullscreen.addEventListener("click", async () => {
                video.controls = true;
                try {
                    await video.requestFullscreen();
                } catch {
                    fail("Fullscreen is unavailable");
                }
                sync();
            });
            for (const type of [
                "loadedmetadata",
                "durationchange",
                "timeupdate",
                "play",
                "pause",
                "ended",
                "volumechange",
                "ratechange",
                "emptied",
            ])
                video.addEventListener(type, sync);
            video.addEventListener("error", () => {
                fail("Video could not be played");
                sync();
            });
            bar.append(play, seek, time, mute, volume, settings, fullscreen);
            player.append(bar, options, status);
            mounted.set(video, sync);
            sync();
            if (video.error) fail("Video could not be played");
        }
    };
    const syncAll = () => {
        for (const video of doc.querySelectorAll<HTMLVideoElement>("video[data-dooc-video]"))
            mounted.get(video)?.();
    };
    mobile.addEventListener("change", syncAll);
    window.addEventListener("resize", closeOptions);
    doc.addEventListener(
        "scroll",
        (event) => {
            if (event.target instanceof Node && !activeOptions?.contains(event.target))
                closeOptions();
        },
        true,
    );
    doc.addEventListener("fullscreenchange", syncAll);
    doc.addEventListener("docs:ui-language", syncAll);
    new MutationObserver((records) => {
        if (
            records.some((record) =>
                [...record.addedNodes].some(
                    (node) =>
                        node instanceof Element &&
                        (node.matches("video[data-dooc-video]") ||
                            node.querySelector("video[data-dooc-video]")),
                ),
            )
        )
            initialize();
    }).observe(doc.documentElement, { childList: true, subtree: true });
    initialize();
}
