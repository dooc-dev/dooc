import type { Writable } from "node:stream";
import { stripVTControlCharacters, styleText } from "node:util";
import { log, spinner } from "@clack/prompts";
import type { DownloadProgress } from "../../engine/src/compiler/download-progress.js";

function safeText(value: string): string {
    return stripVTControlCharacters(value)
        .replace(/\p{Cc}|\p{Cf}/gu, " ")
        .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"'`]+/giu, (value) => {
            try {
                const url = new URL(value);
                url.username = url.password = url.search = url.hash = "";
                return url.href;
            } catch {
                return "[invalid URL]";
            }
        });
}

function bytes(value: number): string {
    const size = Math.max(0, Number.isFinite(value) ? value : 0);
    const unit = Math.min(3, Math.floor(Math.log2(Math.max(1, size)) / 10));
    return `${unit ? (size / 1024 ** unit).toFixed(1) : Math.floor(size)} ${["B", "KiB", "MiB", "GiB"][unit]}`;
}

function amount(received: number, total?: number): string {
    return total !== undefined && Number.isFinite(total) && total > 0
        ? `${bytes(received)} / ${bytes(total)} (${Math.min(100, Math.floor((received / total) * 100))}%)`
        : bytes(received);
}

export function createTerminal(output: Writable & { isTTY?: boolean } = process.stderr) {
    const rich =
        output.isTTY === true &&
        process.stdin.isTTY === true &&
        process.env.NO_COLOR === undefined &&
        !process.env.CI &&
        process.env.TERM !== "dumb";
    const options = { output, spacing: 0, withGuide: false };
    const active = new Map<string, DownloadProgress>();
    let progress: ReturnType<typeof spinner> | undefined;
    let updated = 0;
    const color = (name: "cyan" | "green" | "yellow" | "red" | "gray" | "bold", text: string) =>
        rich ? styleText(name, text, { validateStream: false }) : text;
    const clear = () => {
        progress?.clear();
        progress = undefined;
    };
    const close = () => {
        active.clear();
        clear();
    };
    const summary = () => {
        const downloads = [...active.values()];
        const received = downloads.reduce((sum, item) => sum + item.received, 0);
        const total = downloads.every((item) => item.total !== undefined)
            ? downloads.reduce((sum, item) => sum + (item.total ?? 0), 0)
            : undefined;
        const label =
            downloads.length === 1
                ? safeText(downloads[0]?.url ?? "")
                : `${downloads.length} files`;
        const detail = downloads.length === 1 ? downloads[0]?.detail : undefined;
        return `Downloading ${label} · ${detail === undefined ? amount(received, total) : safeText(detail)}`;
    };
    const render = () => {
        if (!rich || !active.size) return;
        if (!progress) {
            progress = spinner({
                output,
                withGuide: false,
                onCancel: () => {
                    close();
                    process.exit(130);
                },
            });
            progress.start(summary());
        } else progress.message(summary());
    };
    const write = (label: string, message: string, tone: Parameters<typeof color>[0] = "gray") => {
        clear();
        log.message(`${color(tone, label)} ${safeText(message)}`, options);
        render();
    };
    return {
        ready(mode: string, root: string, url: string) {
            clear();
            log.message(
                [
                    "",
                    color("bold", `dooc · ${safeText(mode)}`),
                    `  ${color("cyan", safeText(url))}`,
                    `  ${safeText(root)}`,
                    color("gray", "  Ctrl+C to stop"),
                    "",
                ],
                options,
            );
            render();
        },
        info(message: string) {
            write("Info", message, "cyan");
        },
        warn(message: string) {
            write("Warning", message, "yellow");
        },
        error(message: string) {
            write("Error", message, "red");
        },
        operation(action: string, detail?: string) {
            write(new Date().toTimeString().slice(0, 8), `${action}${detail ? `  ${detail}` : ""}`);
        },
        download(event: DownloadProgress) {
            if (event.state === "complete" || event.state === "error") {
                active.delete(event.url);
                write(
                    event.state === "complete" ? "Downloaded" : "Download failed",
                    `${event.url} · ${event.detail ?? amount(event.received, event.total)}`,
                    event.state === "complete" ? "green" : "red",
                );
                return;
            }
            active.set(event.url, event);
            const now = Date.now();
            if (event.state === "start") {
                updated = now;
                if (rich) render();
                else
                    write(
                        "Downloading",
                        `${event.url} · ${event.detail ?? amount(event.received, event.total)}`,
                    );
            } else if (now - updated >= (rich ? 250 : 1000)) {
                updated = now;
                if (rich) render();
                else write("Progress", summary());
            }
        },
        close,
    };
}

export const terminal = createTerminal();
