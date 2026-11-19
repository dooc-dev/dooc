import type { DocumentVersionList } from "../../engine/src/core/document-version.js";
import { pageWorkspace } from "../../workspace/src/client.js";
import { workspaceConnection, workspaceId } from "../../workspace/src/connection.js";
import { connectServer } from "../../workspace/src/socket-connection.js";
import { t } from "./i18n.js";
import { mountSelectPickers } from "./language-picker.js";

export const mountDocumentVersions = () => {
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
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.hidden = true;
    footer.append(status);
    let sequence = 0;
    let basePath = "";
    const section = (): string | undefined =>
        (document.body.dataset.documentManifest ??
            JSON.parse(document.getElementById("boot")?.textContent || "{}").origin) ||
        undefined;
    let unsubscribe: (() => void) | undefined;
    const visibility = () => {
        footer.hidden = versions.box.hidden && status.hidden;
    };
    const refresh = async () => {
        const request = ++sequence;
        const id = workspaceId();
        const manifest = section();
        versions.select.disabled = true;
        try {
            const hello = await pageWorkspace(id).request<{ ops: string[] }>("hello");
            if (!hello.ops.includes("versions")) {
                versions.box.hidden = true;
                return;
            }
            const data = await pageWorkspace(id).request<DocumentVersionList>("versions", {
                action: "list",
                manifest,
            });
            if (request !== sequence || id !== workspaceId() || manifest !== section()) return;
            basePath = data.basePath ?? "";
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
                visibility();
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
            const next = await connection.openVersion(version, section());
            if (workspaceId() !== from) return;
            const path =
                document.body.dataset.documentPath ??
                (JSON.parse(document.getElementById("boot")?.textContent || "{}").path as
                    | string
                    | undefined);
            document.dispatchEvent(
                new CustomEvent("dooc:select-workspace", {
                    detail: {
                        id: next.id,
                        from,
                        path: path && basePath ? path.slice(basePath.length) || "/" : path,
                    },
                }),
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
    const watch = () => {
        unsubscribe?.();
        unsubscribe = pageWorkspace().on("change", () => void refresh());
        void refresh();
    };
    document.addEventListener("dooc:workspace-changed", watch);
    document.addEventListener("dooc:document-changed", () => void refresh());
    watch();
};
