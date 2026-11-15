export const RELAY_MESSAGE_BYTES = 8 * 1024 * 1024;
export const RELAY_POLL_MS = 25_000;
export const RELAY_OFFLINE_MS = 35_000;
export const RELAY_CALL_MS = 60_000;

export interface RelayCredentials {
    browser: string;
    mcp: string;
}

export interface RelayCall {
    id: string;
    deadline: number;
    name: string;
    args: Record<string, unknown>;
}

export interface DesktopConnection {
    url: string;
    browser: string;
    readOnly: boolean;
}

export const desktopConnection = (hash: string): DesktopConnection | undefined => {
    const value = new URLSearchParams(hash.replace(/^#/, "")).get("dooc_mcp");
    if (!value) return;
    if (value.length > 4096) throw new Error("Invalid Desktop connection link");
    const link = JSON.parse(value) as DesktopConnection;
    const url = new URL(link.url);
    if (
        validateRelayUrl(link.url) !== link.url ||
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        !url.port ||
        typeof link.readOnly !== "boolean" ||
        typeof link.browser !== "string" ||
        !/^[a-f0-9-]{36}\.[rw]\.b\.[A-Za-z0-9_-]{43}$/.test(link.browser) ||
        link.browser.split(".")[1] !== (link.readOnly ? "r" : "w")
    )
        throw new Error("Invalid Desktop connection link");
    return { url: url.origin, browser: link.browser, readOnly: link.readOnly };
};

export const validateRelayUrl = (value: string): string => {
    const url = new URL(value);
    if (
        (url.protocol !== "https:" &&
            !(
                url.protocol === "http:" &&
                ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
            )) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
    )
        throw new Error(
            "Relay must be an HTTPS origin without a path or credentials (loopback HTTP is allowed for development)",
        );
    return url.origin;
};
