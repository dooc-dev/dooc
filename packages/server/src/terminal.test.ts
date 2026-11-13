import { spawnSync } from "node:child_process";
import { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createTerminal } from "./terminal.js";

const terminals: ReturnType<typeof createTerminal>[] = [];
const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const hooks = ["SIGINT", "SIGTERM", "exit", "uncaughtExceptionMonitor", "unhandledRejection"];
const counts = () => hooks.map((name) => process.listenerCount(name));
const capture = (tty = false) => {
    const chunks: string[] = [];
    const output = Object.assign(
        new Writable({
            write(chunk, _encoding, done) {
                chunks.push(String(chunk));
                done();
            },
        }),
        { isTTY: tty, columns: 120 },
    );
    const terminal = createTerminal(output);
    terminals.push(terminal);
    return { terminal, text: () => chunks.join("") };
};
const interactive = () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("CI", undefined);
    vi.stubEnv("TERM", "xterm-256color");
};

afterEach(() => {
    for (const terminal of terminals.splice(0)) terminal.close();
    if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
    else Reflect.deleteProperty(process.stdin, "isTTY");
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

it("keeps piped logs plain and removes credentials, URL parameters and terminal controls", () => {
    const stdout = vi.spyOn(process.stdout, "write");
    const { terminal, text } = capture();
    terminal.ready(
        "edit",
        "/docs\nforged line",
        "http://alice:secret@localhost:5179/?token=secret#secret",
    );
    terminal.info("Fetch https://user:secret@example.test/file?access_token=secret#secret");
    terminal.warn("\u001b[31mwarning\u001b[0m\r\u0007");
    terminal.error("\u001b]8;;https://example.test/?secret\u0007failure\u001b]8;;\u0007");
    terminal.operation("Save", "file.md\u202E");
    expect(text()).toContain("http://localhost:5179/");
    expect(text()).toContain("https://example.test/file");
    expect(text()).toContain("/docs forged line");
    expect(text()).toMatch(/\d{2}:\d{2}:\d{2} Save {2}file.md/);
    for (const hidden of ["secret", "alice", "user:", "\u001b", "\r", "\u0007", "\u202E"])
        expect(text()).not.toContain(hidden);
    expect(stdout).not.toHaveBeenCalled();
});

it("reports known and unknown download sizes without flooding a pipe", () => {
    vi.useFakeTimers();
    const { terminal, text } = capture();
    const url = "https://example.test/archive?token=secret";
    terminal.download({ url, state: "start", received: 0, total: 1024 });
    for (let received = 1; received < 100; received++)
        terminal.download({ url, state: "progress", received, total: 1024 });
    expect(text().split("\n").filter(Boolean)).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    terminal.download({ url, state: "progress", received: 512, total: 1024 });
    expect(text()).toContain("512 B / 1.0 KiB (50%)");
    terminal.download({ url, state: "complete", received: 1024, total: 1024 });
    expect(text()).toContain("Downloaded https://example.test/archive · 1.0 KiB / 1.0 KiB (100%)");
    terminal.download({ url, state: "start", received: 0 });
    vi.advanceTimersByTime(1000);
    terminal.download({ url, state: "progress", received: 2048 });
    terminal.download({ url, state: "error", received: 2048 });
    expect(text()).toContain("Progress Downloading https://example.test/archive · 2.0 KiB\n");
    expect(text()).toContain("Download failed https://example.test/archive · 2.0 KiB\n");
    expect(text()).not.toMatch(/secret|NaN|Infinity/);
    expect(text()).not.toContain("\u001b");
});

it.each([
    false,
    true,
])("shows sanitized native Git progress instead of fake bytes (TTY=%s)", (tty) => {
    if (tty) interactive();
    vi.useFakeTimers();
    const { terminal, text } = capture(tty);
    const url = "https://example.test/repository.git?token=secret";
    terminal.download({ url, state: "start", received: 0, detail: "Cloning repository" });
    vi.advanceTimersByTime(1000);
    terminal.download({
        url,
        state: "progress",
        received: 0,
        detail: "\u001b[31mReceiving objects: 42% (42/100), 1.2 MiB\u001b[0m\r",
    });
    vi.advanceTimersByTime(100);
    terminal.download({ url, state: "complete", received: 0, detail: "Clone ready" });
    terminal.download({
        url,
        state: "error",
        received: 0,
        detail: "Failed: https://alice:secret@example.test/repository.git?token=secret#secret",
    });
    const plain = stripVTControlCharacters(text());
    expect(plain).toContain("Cloning repository");
    expect(plain).toContain("Receiving objects: 42% (42/100), 1.2 MiB");
    expect(plain).toContain("Downloaded https://example.test/repository.git · Clone ready");
    expect(plain).toContain("Failed: https://example.test/repository.git");
    expect(plain).not.toMatch(/secret|alice|0 B/);
    terminal.close();
});

it("shares one spinner across downloads and restores process hooks around logs and close", () => {
    interactive();
    vi.useFakeTimers();
    const before = counts();
    const { terminal, text } = capture(true);
    const a = "https://example.test/a";
    const b = "https://example.test/b";
    terminal.download({ url: a, state: "start", received: 512, total: 1024 });
    terminal.download({ url: b, state: "start", received: 1024, total: 2048 });
    vi.advanceTimersByTime(100);
    expect(stripVTControlCharacters(text())).toContain("2 files · 1.5 KiB / 3.0 KiB (50%)");
    expect(counts()).toEqual(before.map((count) => count + 1));
    terminal.operation("Save", "guide.md");
    expect(counts()).toEqual(before.map((count) => count + 1));
    terminal.download({ url: a, state: "complete", received: 1024, total: 1024 });
    vi.advanceTimersByTime(100);
    expect(stripVTControlCharacters(text())).toContain("Downloading https://example.test/b");
    terminal.close();
    expect(counts()).toEqual(before);
    expect(vi.getTimerCount()).toBe(0);
    expect(text()).toContain("\u001b[?25h");
    terminal.close();
    expect(counts()).toEqual(before);
});

it.each([
    ["NO_COLOR", "1"],
    ["CI", "true"],
    ["TERM", "dumb"],
])("keeps %s terminals plain without spinner hooks", (key, value) => {
    interactive();
    vi.stubEnv(key, value);
    const before = counts();
    const { terminal, text } = capture(true);
    terminal.download({ url: "https://example.test/file", state: "start", received: 0 });
    terminal.info("Ready");
    terminal.close();
    expect(counts()).toEqual(before);
    expect(text()).not.toContain("\u001b");
});

it("does not swallow termination while a spinner is active", () => {
    const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color" };
    delete env.CI;
    delete env.NO_COLOR;
    const result = spawnSync(
        process.execPath,
        [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            `import { createTerminal } from ${JSON.stringify(new URL("./terminal.ts", import.meta.url).href)};
            Object.defineProperty(process.stdin, 'isTTY', { value: true });
            Object.defineProperty(process.stderr, 'isTTY', { value: true });
            const terminal = createTerminal();
            terminal.download({ url: 'https://example.test/file', state: 'start', received: 0 });
            setTimeout(() => process.kill(process.pid, 'SIGTERM'), 20);`,
        ],
        { env, encoding: "utf8", timeout: 5000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(130);
    expect(result.stdout).toBe("");
});
