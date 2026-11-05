export const isRemoteTextfile = (file: string): boolean => /^https?:\/\//i.test(file);

/** GitHub-style, one-based inclusive line numbers. */
export const parseTextfileRange = (range: string): [number, number] => {
    const match = /^#L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(range);
    const start = Number(match?.[1]);
    const end = Number(match?.[2] ?? match?.[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start)
        throw new Error("Use #L10 or #L10-L20 with positive, ascending line numbers");
    return [start, end];
};

/** Split before decoding so an encoded # or ? remains part of a local filename. */
export const parseFileReference = (source: string): { file: string; range?: string } => {
    const hash = source.indexOf("#");
    const path = hash < 0 ? source : source.slice(0, hash);
    if (!path.trim()) throw new Error("File path is required");
    const remote = isRemoteTextfile(path);
    if (!remote && path.includes("?"))
        throw new Error("Local file references do not support query parameters");
    return {
        file: remote ? path : decodeURIComponent(path),
        ...(hash < 0 ? {} : { range: decodeURIComponent(source.slice(hash)) }),
    };
};

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
