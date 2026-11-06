export interface FileLayout {
    defaultLayout: boolean;
    documents: Record<string, string>;
    order: string[];
    icons?: Record<string, string>;
}

export const MAX_FILE_UPLOAD_BYTES = 64 * 1024 * 1024;

export const localFile = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    !/[\\:?#]/.test(value) &&
    [...value].every((char) => char.charCodeAt(0) >= 32) &&
    value.split("/").every((part) => !!part && !part.startsWith("."));

export const isDocumentFileName = (value: unknown): value is string =>
    localFile(value) && !value.includes("/") && value.endsWith(".md");

export const suggestDocFileName = (title: string): string => {
    const name = [...title]
        .filter((char) => char.charCodeAt(0) >= 32)
        .join("")
        .replace(/[\\/:?#]+/g, "-")
        .trim()
        .replace(/^\.+/, "");
    return name ? (name.endsWith(".md") ? name : `${name}.md`) : "";
};

export const fileExtension = (file: string): string => {
    const name = file.split("/").pop() ?? file;
    return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "other";
};

export const defaultFilePath = (file: string): string =>
    `files/${fileExtension(file)}/${file.split("/").pop()}`;

export const docFile = (id: string, layout?: FileLayout): string =>
    layout && Object.hasOwn(layout.documents, id)
        ? (layout.documents[id] as string)
        : `content/${id}.md`;

export const parseFileLayout = (value: unknown): FileLayout => {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("files must be an object");
    const v = value as Record<string, unknown>;
    if (
        Object.keys(v).some(
            (key) => !["defaultLayout", "documents", "order", "icons"].includes(key),
        ) ||
        (v.defaultLayout !== undefined && typeof v.defaultLayout !== "boolean")
    )
        throw new Error("Invalid file layout");
    const documents = v.documents ?? {};
    const order = v.order ?? [];
    const icons = v.icons;
    if (
        icons !== undefined &&
        (!icons ||
            typeof icons !== "object" ||
            Array.isArray(icons) ||
            Object.entries(icons).some(
                ([id, file]) =>
                    !/^[a-z0-9][a-z0-9-]*$/.test(id) || !localFile(file) || !file.endsWith(".svg"),
            ))
    )
        throw new Error("Invalid icon paths");
    if (
        !documents ||
        typeof documents !== "object" ||
        Array.isArray(documents) ||
        Object.entries(documents).some(
            ([id, file]) =>
                !/^[a-z0-9][a-z0-9-]*$/.test(id) || !localFile(file) || !file.endsWith(".md"),
        ) ||
        new Set(Object.values(documents)).size !== Object.keys(documents).length ||
        !Array.isArray(order) ||
        order.some((file) => !localFile(file)) ||
        new Set(order).size !== order.length
    )
        throw new Error("Invalid file paths or order");
    return {
        defaultLayout: v.defaultLayout !== false,
        documents: documents as Record<string, string>,
        order,
        ...(icons ? { icons: icons as Record<string, string> } : {}),
    };
};

export const docIconFile = (id: string, layout?: FileLayout): string =>
    layout?.icons && Object.hasOwn(layout.icons, id)
        ? (layout.icons[id] as string)
        : `icons/${id}.svg`;
