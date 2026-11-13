import { MAX_FILE_UPLOAD_BYTES } from "../../engine/src/core/files.js";
import { CHECK_ICON } from "../../engine/src/core/icons.js";
import type { HmrBridge } from "../../server/src/hmr.js";
import { pageWorkspace } from "../../workspace/src/client.js";
import { showNotice } from "./edit-dialog.js";
import { t } from "./i18n.js";

export const mountFileUpload = (): void => {
    const nav = document.getElementById("nav-groups");
    if (!nav) return;
    let busy = false;
    let state = "";
    let count = 0;
    let total = 0;
    let error = "";
    let depth = 0;
    const pending = new Set<string>();
    const refresh = () => document.dispatchEvent(new Event("docs:files-changed"));
    const owner = window as Window & { __docsHmr?: HmrBridge };
    owner.__docsHmr ??= { setDirty: () => {} };
    const bridge = owner.__docsHmr;
    const previous = bridge.onContent;
    const onContent = (files: string[]) => {
        if (previous) previous(files);
        else if (document.getElementById("files-manager")) refresh();
        else location.reload();
    };
    bridge.onContent = (files) => {
        if (busy) for (const file of files) pending.add(file);
        else onContent(files);
    };
    const sync = () => {
        const card = document.getElementById("nav-files");
        const status = card?.querySelector<HTMLElement>(".files-upload-status");
        if (!card || !status) return;
        card.setAttribute("aria-busy", String(busy));
        status.dataset.state = state;
        const label =
            state === "loading"
                ? t("Uploading {count}/{total}", { count, total })
                : error || t(state === "done" ? "Files uploaded" : "Upload files");
        status.title = state ? label : "";
        status.setAttribute("aria-label", state ? label : "");
        if (state === "done") status.innerHTML = CHECK_ICON;
        else status.textContent = state === "loading" ? `${count}/${total}` : error ? "!" : "";
    };
    new MutationObserver(sync).observe(nav, { childList: true });
    document.addEventListener("docs:ui-language", sync);
    const clearDrag = () => {
        depth = 0;
        document.body.classList.remove("files-dragging", "files-over");
    };
    const toBase64 = (file: File): Promise<string> =>
        new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
        });
    const upload = async (files: File[]) => {
        if (busy || !files.length) return;
        busy = true;
        state = "loading";
        count = 0;
        total = files.length;
        error = "";
        sync();
        const failures: string[] = [];
        for (const file of files) {
            try {
                if (file.size > MAX_FILE_UPLOAD_BYTES) throw new Error(t("File exceeds 64 MiB"));
                await pageWorkspace().request("files", {
                    action: "upload",
                    name: file.name,
                    data: await toBase64(file),
                });
                count++;
                sync();
            } catch (cause) {
                failures.push(
                    `${file.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
                );
            }
        }
        error = failures.join("\n");
        state = failures.length ? "error" : "done";
        sync();
        if (failures.length) await showNotice(error);
        busy = false;
        sync();
        if (pending.size) onContent([...pending]);
        else refresh();
        pending.clear();
    };
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files");
    const inFiles = (event: DragEvent) =>
        event.target instanceof Element && !!event.target.closest("#nav-files");
    document.addEventListener("dragenter", (event) => {
        if (!hasFiles(event)) return;
        if (depth++ === 0)
            document.getElementById("nav-files")?.scrollIntoView({ block: "nearest" });
        document.body.classList.add("files-dragging");
    });
    document.addEventListener("dragover", (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        document.body.classList.add("files-dragging");
        document.body.classList.toggle("files-over", inFiles(event) && !busy);
        if (inFiles(event) && event.dataTransfer)
            event.dataTransfer.dropEffect = busy ? "none" : "copy";
    });
    document.addEventListener("dragleave", (event) => {
        if (hasFiles(event) && --depth <= 0) clearDrag();
    });
    document.addEventListener(
        "drop",
        (event) => {
            clearDrag();
            if (!hasFiles(event)) return;
            event.preventDefault();
            if (!inFiles(event)) return;
            event.stopPropagation();
            if (
                [...(event.dataTransfer?.items ?? [])].some(
                    (item) => item.webkitGetAsEntry?.()?.isDirectory,
                )
            ) {
                void showNotice(t("Choose files inside the folder"));
                return;
            }
            void upload([...(event.dataTransfer?.files ?? [])]);
        },
        true,
    );
    document.addEventListener("dragend", clearDrag);
    window.addEventListener("blur", clearDrag);
    sync();
};
