import { showDialog } from "./edit-dialog.js";
import { t } from "./i18n.js";

export const chooseConflict = async (
    file: string,
    local: string,
    external: string | null,
): Promise<"local" | "external" | undefined> => {
    const columns = document.createElement("div");
    columns.className = "conflict-columns";
    for (const [label, content] of [
        ["Use my edits", local],
        ["Use external changes", external ?? t("File was deleted")],
    ] as const) {
        const section = document.createElement("section");
        const heading = document.createElement("h3");
        heading.textContent = t(label);
        const preview = document.createElement("pre");
        preview.textContent = content;
        section.append(heading, preview);
        columns.append(section);
    }
    const result = await showDialog(`${t("Conflicting changes")}: ${file}`, columns, [
        { value: "", label: t("Cancel") },
        { value: "external", label: t("Use external changes") },
        { value: "local", label: t("Use my edits") },
    ]);
    return result === "local" || result === "external" ? result : undefined;
};
