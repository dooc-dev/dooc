/** Self-contained: standalone bundles cannot rely on the local viewer API. */
export const mountBundleNetwork = (): void => {
    const load = async (host: HTMLElement) => {
        if (host.dataset.loaded) return;
        host.dataset.loaded = "true";
        const source = host.dataset.embedUrl;
        if (!source) return;
        const url = new URL(source);
        const path = url.pathname.toLowerCase();
        const label = host.textContent || source;
        const link = host.querySelector("a");
        const failure = () => {
            if (link && !host.contains(link)) host.append(link);
            const status = document.createElement("p");
            status.setAttribute("role", "status");
            status.textContent = "Could not load this URL. Open the source link to view it.";
            host.append(status);
        };
        try {
            if (url.protocol !== "https:" || url.username || url.password) throw new Error();
            if (/\.(png|jpe?g|webp|gif|svg)$/.test(path)) {
                const image = document.createElement("img");
                image.alt = label;
                image.referrerPolicy = "no-referrer";
                image.style.maxWidth = "100%";
                image.onerror = failure;
                image.src = source;
                host.replaceChildren(image);
            } else if (/\.(mp4|webm)$/.test(path)) {
                const video = document.createElement("video");
                video.controls = true;
                video.preload = "metadata";
                video.style.maxWidth = "100%";
                video.onerror = failure;
                video.src = source;
                host.replaceChildren(video);
            } else if (
                /\.(txt|md|markdown|csv|tsv|json|yaml|yml|toml|xml|css|[cm]?js|[jt]sx?|py|rs|go|sh|sql)$/.test(
                    path,
                )
            ) {
                const response = await fetch(source, {
                    credentials: "omit",
                    referrerPolicy: "no-referrer",
                    signal: AbortSignal.timeout(10000),
                });
                if (!response.ok) throw new Error();
                const code = document.createElement("code");
                const text = await response.text();
                const range = /^#L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(url.hash);
                code.textContent = range
                    ? text
                          .split(/\r\n|\n|\r/)
                          .slice(Number(range[1]) - 1, Number(range[2] ?? range[1]))
                          .join("\n")
                    : text;
                const pre = document.createElement("pre");
                pre.style.cssText = "overflow:auto;white-space:pre-wrap";
                pre.append(code);
                host.replaceChildren(pre);
            } else {
                const frame = document.createElement("iframe");
                frame.title = label;
                frame.sandbox.add("allow-scripts");
                frame.referrerPolicy = "no-referrer";
                frame.style.cssText = "width:100%;height:400px;border:0";
                frame.src = source;
                host.prepend(frame);
            }
        } catch {
            failure();
        }
    };
    const mount = () => {
        for (const host of document.querySelectorAll<HTMLElement>(
            ".external-embed[data-embed-url]",
        ))
            void load(host);
    };
    new MutationObserver(mount).observe(document.querySelector("main") ?? document.body, {
        childList: true,
        subtree: true,
    });
    mount();
};
