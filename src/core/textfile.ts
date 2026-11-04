export const isRemoteTextfile = (file: string): boolean => /^https?:\/\//i.test(file);

/** The source stays intact for tooltips; only the visible label and language use this name. */
export const textfileName = (file: string): string => {
    if (!isRemoteTextfile(file)) return file.split("/").at(-1) ?? file;
    try {
        const url = new URL(file);
        const path =
            url.pathname.endsWith(".git") && url.hash.includes(":")
                ? url.hash.slice(url.hash.indexOf(":") + 1)
                : url.pathname;
        return decodeURIComponent(path.split("/").at(-1) || url.hostname);
    } catch {
        return file;
    }
};
