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
