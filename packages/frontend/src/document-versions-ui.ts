import type { DocumentVersionList } from "../../engine/src/core/document-version.js";
import { pageWorkspace } from "../../workspace/src/client.js";
import { workspaceConnection, workspaceId } from "../../workspace/src/connection.js";
import { connectServer } from "../../workspace/src/socket-connection.js";
import { t } from "./i18n.js";
import { mountSelectPickers } from "./language-picker.js";

export interface DraftLocation {
    workspace: string;
    file: string;
    pane?: number;
}

export const mountDocumentVersions = (drafts: () => DraftLocation[] = () => []) => {
    const sidebar = document.getElementById("sidebar");
    const footer = document.getElementById("document-versions");
    if (!sidebar || !footer || footer.childElementCount) return;
    const control = (id: string, title: string) => {
        const box = document.createElement("div");
        box.className = "subformat-control";
        const label = document.createElement("span");
        label.className = "subformat-control-label";
        label.dataset.i18n = title;
        label.textContent = t(title);
        const select = document.createElement("select");
        select.id = id;
        select.setAttribute("aria-label", t(title));
        select.dataset.i18nAriaLabel = title;
        select.dataset.placeholder = t(title);
        box.append(label, select);
        footer.append(box);
        box.hidden = true;
        mountSelectPickers(t, [select]);
        return { box, select };
    };
    const versions = control("document-version-select", "version");
    const pending = control("document-draft-select", "Unsaved drafts");
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.hidden = true;
    footer.append(status);
    let sequence = 0;
    let unsubscribe: (() => void) | undefined;
    const visibility = () => {
        footer.hidden = versions.box.hidden && pending.box.hidden && status.hidden;
    };
    const refreshDrafts = () => {
        const locations = [
            ...new Map(drafts().map((draft) => [JSON.stringify(draft), draft])).values(),
        ];
        pending.select.replaceChildren(new Option(t("Choose an unsaved draft"), ""));
        for (const draft of locations) {
            const label = workspaceConnection(draft.workspace)?.label ?? draft.workspace;
            pending.select.add(new Option(`${label} — ${draft.file}`, JSON.stringify(draft)));
        }
        pending.box.hidden = !locations.length;
        visibility();
    };
    const refresh = async () => {
        const request = ++sequence;
        const id = workspaceId();
        versions.select.disabled = true;
        try {
            const hello = await pageWorkspace(id).request<{ ops: string[] }>("hello");
            if (!hello.ops.includes("versions")) {
                versions.box.hidden = true;
                return;
            }
            const data = await pageWorkspace(id).request<DocumentVersionList>("versions", {
                action: "list",
            });
            if (request !== sequence || id !== workspaceId()) return;
            versions.select.replaceChildren(
                ...data.versions.map((row, index) => {
                    const option = new Option(
                        index === 0 ? `${row.version} latest` : row.version,
                        row.version,
                    );
                    option.dataset.status = index === 0 ? "latest" : "";
                    return option;
                }),
            );
            versions.select.value = data.selected ?? "";
            versions.box.hidden = !data.showSelector;
            status.hidden = true;
            footer.dataset.readOnly = String(!!workspaceConnection(id)?.readOnly);
        } catch (error) {
            if (request !== sequence || id !== workspaceId()) return;
            status.textContent = error instanceof Error ? error.message : String(error);
            status.hidden = false;
        } finally {
            if (request === sequence) {
                versions.select.disabled = false;
                refreshDrafts();
            }
        }
    };
    versions.select.addEventListener("change", () => {
        const from = workspaceId();
        const version = versions.select.value;
        versions.select.disabled = true;
        void (async () => {
            const connection =
                workspaceConnection(from) ??
                (await connectServer(`${location.origin}/api/workspace`, true));
            if (!connection.openVersion)
                throw new Error("Version switching is unavailable for this workspace");
            const next = await connection.openVersion(version);
            if (workspaceId() !== from) return;
            document.dispatchEvent(
                new CustomEvent("dooc:select-workspace", { detail: { id: next.id, from } }),
            );
        })()
            .catch((error) => {
                status.textContent = error instanceof Error ? error.message : String(error);
                status.hidden = false;
                visibility();
            })
            .finally(() => {
                versions.select.disabled = false;
            });
    });
    pending.select.addEventListener("change", () => {
        if (!pending.select.value) return;
        const draft = JSON.parse(pending.select.value) as DraftLocation;
        document.dispatchEvent(new CustomEvent("dooc:select-draft", { detail: draft }));
    });
    const watch = () => {
        unsubscribe?.();
        unsubscribe = pageWorkspace().on("change", () => void refresh());
        void refresh();
    };
    document.addEventListener("dooc:workspace-changed", watch);
    document.addEventListener("dooc:drafts-changed", refreshDrafts);
    document.addEventListener("docs:ui-language", refreshDrafts);
    watch();
};
