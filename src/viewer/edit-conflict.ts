import { t } from "./i18n.js";

export const chooseConflict = (
    file: string,
    local: string,
    external: string | null,
): Promise<"local" | "external" | undefined> =>
    new Promise((resolve) => {
        const dialog = document.createElement("dialog");
        dialog.className = "edit-conflict";
        const title = document.createElement("h2");
        title.textContent = `${t("Conflicting changes")}: ${file}`;
        dialog.setAttribute("aria-label", title.textContent);
        const columns = document.createElement("div");
        columns.className = "conflict-columns";
        dialog.append(title, columns);
        for (const [choice, label, content] of [
            ["local", "Use my edits", local],
            ["external", "Use external changes", external ?? t("File was deleted")],
        ] as const) {
            const section = document.createElement("section");
            const preview = document.createElement("pre");
            preview.textContent = content;
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = t(label);
            button.addEventListener("click", () => dialog.close(choice));
            section.append(preview, button);
            columns.append(section);
        }
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = t("Cancel");
        cancel.autofocus = true;
        cancel.addEventListener("click", () => dialog.close());
        dialog.append(cancel);
        dialog.addEventListener(
            "close",
            () => {
                const result = dialog.returnValue;
                dialog.remove();
                resolve(result === "local" || result === "external" ? result : undefined);
            },
            { once: true },
        );
        document.body.append(dialog);
        dialog.showModal();
    });
