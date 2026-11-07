import { localFile } from "./files.js";

export const themeVariantFile = (file: string, theme: string): string => {
    if (!localFile(file) || !/^[a-z][a-z0-9-]*$/.test(theme))
        throw new Error("Expected a local file and a theme name");
    return `themes/${theme}/${file}`;
};

/** A pane selects its own variant; an absent variant falls back to the original content. */
export const mountThemeVariants = (doc: Document): void => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
        for (const group of doc.querySelectorAll<HTMLElement>("[data-theme-variants]")) {
            const choice = group.closest<HTMLElement>("[data-theme]")?.dataset.theme;
            const theme =
                !choice || choice === "auto" ? (media.matches ? "dark" : "light") : choice;
            const children = [...group.children] as HTMLElement[];
            const selected =
                children.find((child) => child.dataset.themeVariant === theme) ??
                children.find((child) => child.dataset.themeVariant === "");
            for (const child of children) {
                const hidden = child !== selected;
                if (child.hidden === hidden) continue;
                child.hidden = hidden;
                // Recreate hidden frame contexts so revealed SVGs receive a live viewport.
                if (!hidden)
                    for (const frame of child.querySelectorAll("iframe"))
                        frame.replaceWith(frame.cloneNode(true));
            }
        }
    };
    new MutationObserver(apply).observe(doc.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-theme"],
    });
    media.addEventListener("change", apply);
    apply();
};
