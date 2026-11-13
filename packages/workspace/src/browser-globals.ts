export { Buffer } from "buffer/";
export const process = {
    env: {},
    cwd: () => "/",
    platform: "browser",
    execPath: "",
    getuid: () => 0,
    getgid: () => 0,
    nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) =>
        queueMicrotask(() => callback(...args)),
};
