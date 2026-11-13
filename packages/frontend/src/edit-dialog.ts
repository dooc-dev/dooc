import { t } from "./i18n.js";

export const showDialog = (
    title: string,
    content: string | HTMLElement,
    actions: { value: string; label: string; danger?: boolean }[],
): Promise<string> =>
    new Promise((resolve) => {
        const previous = document.activeElement;
        const dialog = document.createElement("dialog");
        dialog.className = "app-dialog";
        dialog.setAttribute("aria-label", title);
        const heading = document.createElement("h2");
        heading.textContent = title;
        const body = typeof content === "string" ? document.createElement("p") : content;
        if (typeof content === "string") body.textContent = content;
        const footer = document.createElement("div");
        footer.className = "dialog-actions";
        for (const action of actions) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = action.label;
            button.autofocus = action.value === "";
            button.classList.toggle("danger", !!action.danger);
            button.addEventListener("click", () => dialog.close(action.value));
            footer.append(button);
        }
        dialog.append(heading, body, footer);
        dialog.addEventListener(
            "close",
            () => {
                dialog.remove();
                if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
                resolve(dialog.returnValue);
            },
            { once: true },
        );
        document.body.append(dialog);
        dialog.showModal();
    });

export const confirmDialog = async (
    message: string,
    action: string,
    danger = false,
): Promise<boolean> =>
    (await showDialog(action, message, [
        { value: "", label: t("Cancel") },
        { value: "confirm", label: action, danger },
    ])) === "confirm";

export const showNotice = (message: string): Promise<string> =>
    showDialog(t("Notice"), message, [{ value: "", label: t("OK") }]);
