import {
    RELAY_MESSAGE_BYTES,
    RELAY_POLL_MS,
    type RelayCall,
    type RelayCredentials,
    validateRelayUrl,
} from "./mcp-relay.js";

const request = async (
    url: string,
    path: string,
    body: unknown,
    token?: string,
    signal?: AbortSignal,
    method = "POST",
    keepalive = false,
) => {
    const response = await fetch(`${url}${path}`, {
        method,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal,
        keepalive,
        headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const text = (await response.json().catch(() => ({}))) as { error?: string };
        throw Object.assign(new Error(text.error ?? `Relay request failed (${response.status})`), {
            status: response.status,
        });
    }
    return response;
};

export const pairRelay = async (url: string, readOnly: boolean): Promise<RelayCredentials> => {
    const response = await request(
        validateRelayUrl(url),
        "/relay/pair",
        { readOnly },
        undefined,
        AbortSignal.timeout(10_000),
    );
    const credentials = (await response.json()) as RelayCredentials;
    if (
        typeof credentials.browser !== "string" ||
        typeof credentials.mcp !== "string" ||
        !/^[a-zA-Z0-9_.-]+$/.test(credentials.browser) ||
        !/^[a-zA-Z0-9_.-]+$/.test(credentials.mcp)
    )
        throw new Error("Invalid relay credentials");
    return credentials;
};

export const startRelay = (options: {
    url: string;
    credentials: RelayCredentials;
    execute(name: string, args: Record<string, unknown>, deadline: number): Promise<unknown>;
    status(message: string): void;
}) => {
    const url = validateRelayUrl(options.url);
    const instance = crypto.randomUUID();
    const abort = new AbortController();
    const token = options.credentials.browser;
    const status = (message: string) => {
        if (!abort.signal.aborted) options.status(message);
    };
    const done = (async () => {
        let delay = 500;
        while (!abort.signal.aborted) {
            try {
                const response = await request(
                    url,
                    "/relay/poll",
                    { instance },
                    token,
                    AbortSignal.any([abort.signal, AbortSignal.timeout(RELAY_POLL_MS + 10_000)]),
                );
                status("Connected. Keep this tab open.");
                delay = 500;
                if (response.status === 204) continue;
                const call = (await response.json()) as RelayCall;
                if (
                    !call ||
                    typeof call.id !== "string" ||
                    typeof call.name !== "string" ||
                    typeof call.deadline !== "number" ||
                    !call.args ||
                    typeof call.args !== "object" ||
                    Array.isArray(call.args)
                )
                    throw new Error("Invalid relay request");
                let value: unknown;
                try {
                    if (abort.signal.aborted) break;
                    if (Date.now() >= call.deadline)
                        throw new Error("Request expired before execution");
                    value = await options.execute(call.name, call.args, call.deadline);
                } catch (error) {
                    value = { error: error instanceof Error ? error.message : String(error) };
                }
                if (abort.signal.aborted) break;
                let body = { instance, id: call.id, value: value ?? null };
                if (new TextEncoder().encode(JSON.stringify(body)).length > RELAY_MESSAGE_BYTES)
                    body = {
                        ...body,
                        value: { error: "Tool result exceeds the relay's 8 MiB message limit" },
                    };
                // Never repeat execution when a result is lost; the relay expires that call.
                await request(
                    url,
                    "/relay/result",
                    body,
                    token,
                    AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
                );
            } catch (error) {
                if (abort.signal.aborted) break;
                status(error instanceof Error ? error.message : String(error));
                if (error && typeof error === "object" && "status" in error && error.status === 401)
                    break;
                await new Promise<void>((resolve) => {
                    const finish = () => {
                        clearTimeout(timer);
                        abort.signal.removeEventListener("abort", finish);
                        resolve();
                    };
                    const timer = setTimeout(finish, delay);
                    abort.signal.addEventListener("abort", finish, { once: true });
                });
                delay = Math.min(delay * 2, 5_000);
            }
        }
    })();
    let stopped: Promise<void> | undefined;
    return {
        done,
        stop() {
            if (stopped) return stopped;
            abort.abort();
            options.status("Disconnected");
            stopped = request(
                url,
                "/relay/connection",
                { instance },
                token,
                AbortSignal.timeout(5_000),
                "DELETE",
                true,
            ).then(
                () => {},
                () => {},
            );
            return stopped;
        },
    };
};

export const relayCommandText = (url: string, token: string): string => {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    return `claude mcp add --transport http dooc ${quote(`${validateRelayUrl(url)}/mcp`)} --header ${quote(`Authorization: Bearer ${token}`)}`;
};
