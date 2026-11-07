import type { ProjectFont } from "../compiler/fonts.js";

/** Self-contained because published viewers embed this function directly. */
export const createFontSettings = (registered: readonly ProjectFont[]) => {
    type Target = "editor" | "viewer";
    const fonts = new Map<string, FontFace>();
    const selected = { editor: "", viewer: "" };
    const key = (target: Target): string => `docs-${target === "viewer" ? "preview" : target}:font`;
    for (const target of ["editor", "viewer"] as const) {
        try {
            selected[target] = localStorage.getItem(key(target)) ?? "";
        } catch {
            /* Defaults still work when storage is unavailable. */
        }
    }
    const apply = (): void => {
        for (const target of ["editor", "viewer"] as const) {
            const face = fonts.get(selected[target]);
            if (face)
                document.documentElement.style.setProperty(
                    `--${target}-font`,
                    `"${face.family}", "UDEV Gothic", monospace`,
                );
            else document.documentElement.style.removeProperty(`--${target}-font`);
        }
        document.dispatchEvent(new Event("docs:font-change"));
    };
    const select = (target: Target, family: string): void => {
        if (family && !fonts.has(family)) throw new Error("Invalid font file");
        selected[target] = family;
        apply();
        try {
            localStorage.setItem(key(target), family);
        } catch {
            throw new Error("Font choice applies only to this tab");
        }
    };
    const ready = (async () => {
        const results = await Promise.allSettled(
            registered.map(async ({ family, source }) => {
                const face = await new FontFace(family, source).load();
                document.fonts.add(face);
                fonts.set(family, face);
            }),
        );
        for (const target of ["editor", "viewer"] as const)
            if (!fonts.has(selected[target])) selected[target] = "";
        apply();
        if (results.some((result) => result.status === "rejected"))
            throw new Error("Some registered fonts could not be loaded");
    })();
    return { fonts, selected, ready, select };
};
