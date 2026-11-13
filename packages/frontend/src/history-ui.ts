import { pageWorkspace, type WorkspaceClient } from "../../workspace/src/client.js";
import type { Snapshot } from "../../workspace/src/history.js";
import { confirmDialog, showDialog, showNotice } from "./edit-dialog.js";
import { t } from "./i18n.js";

/** Snapshot list with "save" and "restore"; reopens itself after each action until closed. */
export const openHistory = async (workspace: WorkspaceClient = pageWorkspace()): Promise<void> => {
    for (;;) {
        let snapshots: Snapshot[];
        try {
            snapshots = await workspace.request<Snapshot[]>("history", { action: "list" });
        } catch (error) {
            await showNotice(error instanceof Error ? error.message : String(error));
            return;
        }
        const body = document.createElement("div");
        body.className = "history-dialog";
        const message = document.createElement("input");
        message.type = "text";
        message.placeholder = t("Snapshot message");
        message.setAttribute("aria-label", t("Snapshot message"));
        const list = document.createElement("ul");
        let restore = "";
        for (const snapshot of snapshots) {
            const item = document.createElement("li");
            const label = document.createElement("span");
            label.textContent = `${new Date(snapshot.time).toLocaleString()} — ${snapshot.message}${snapshot.author ? ` (${snapshot.author})` : ""}`;
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = t("Restore");
            button.addEventListener("click", () => {
                restore = snapshot.id;
                body.closest("dialog")?.close("restore");
            });
            item.append(label, button);
            list.append(item);
        }
        if (!snapshots.length) list.textContent = t("No snapshots yet");
        body.append(message, list);
        const answer = await showDialog(t("History"), body, [
            { value: "", label: t("Close") },
            { value: "save", label: t("Save snapshot") },
        ]);
        try {
            if (answer === "restore") {
                if (!(await confirmDialog(t("Restore every file to this snapshot?"), t("Restore"))))
                    continue;
                await workspace.request("history", { action: "restore", id: restore });
            } else if (answer === "save") {
                await workspace.request("history", {
                    action: "snapshot",
                    message: message.value,
                });
            } else return;
        } catch (error) {
            await showNotice(error instanceof Error ? error.message : String(error));
        }
    }
};
