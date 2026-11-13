// In a shared workspace every connection says who it is, so snapshots can credit the people who
// edited. The name is asked once and remembered in this browser.
import { pageWorkspace } from "../../workspace/src/client.js";
import type { WorkspaceHello } from "../../workspace/src/protocol.js";
import { showDialog } from "./edit-dialog.js";
import { t } from "./i18n.js";

const KEY = "docs:user";

const stored = (): { name: string; email?: string } | undefined => {
    try {
        const value = JSON.parse(localStorage.getItem(KEY) ?? "null");
        return typeof value?.name === "string" && value.name ? value : undefined;
    } catch {
        // Unreadable storage only means asking again.
        return undefined;
    }
};

const ask = async (): Promise<{ name: string; email?: string } | undefined> => {
    const form = document.createElement("div");
    form.className = "history-dialog";
    const name = document.createElement("input");
    name.type = "text";
    name.placeholder = t("Your name");
    name.setAttribute("aria-label", t("Your name"));
    const email = document.createElement("input");
    email.type = "email";
    email.placeholder = t("Email (optional)");
    email.setAttribute("aria-label", t("Email (optional)"));
    form.append(name, email);
    const answer = await showDialog(t("Shared workspace"), form, [
        { value: "", label: t("Cancel") },
        { value: "join", label: t("Join") },
    ]);
    if (answer !== "join" || !name.value.trim()) return undefined;
    return {
        name: name.value.trim(),
        ...(email.value.trim() ? { email: email.value.trim() } : {}),
    };
};

export const mountIdentity = (): void => {
    const workspace = pageWorkspace();
    let asking = false;
    // Every reconnection is a new session on the server, so identify again each time.
    workspace.opened(() => {
        void (async () => {
            const hello = await workspace.request<WorkspaceHello>("hello");
            if (!hello.shared || !hello.ops.includes("identify") || asking) return;
            asking = true;
            try {
                const user = stored() ?? (await ask());
                if (!user) return;
                await workspace.request("identify", user);
                try {
                    localStorage.setItem(KEY, JSON.stringify(user));
                } catch {
                    // Without storage the name is asked again next time.
                }
            } finally {
                asking = false;
            }
        })().catch(() => {
            // Dropped mid-way; the next connection starts over.
        });
    });
};
