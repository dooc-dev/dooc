export type DownloadProgress = {
    url: string;
    state: "start" | "progress" | "complete" | "error";
    received: number;
    total?: number;
    detail?: string;
};

let listener: ((event: DownloadProgress) => void) | undefined;

export const setDownloadProgressListener = (value?: (event: DownloadProgress) => void): void => {
    listener = value;
};

export const reportDownloadProgress = (event: DownloadProgress): void => {
    try {
        listener?.(event);
    } catch {
        // Reporting must not interrupt downloads or replace their errors.
    }
};
