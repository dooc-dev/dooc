import { execFileSync } from "node:child_process";
import type { LookupAddress, LookupAllOptions } from "node:dns";
import { lookup } from "node:dns/promises";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { type RequestOptions, request } from "node:https";
import { Readable } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";
import { fetchPublicFile } from "./public-file.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("node:https", () => ({ request: vi.fn() }));
const dnsLookup = vi.mocked(
    lookup as (host: string, options: LookupAllOptions) => Promise<LookupAddress[]>,
);
let status: number;
let payload: Buffer;
let connected: unknown;
let options: RequestOptions;

beforeEach(() => {
    vi.resetAllMocks();
    status = 200;
    payload = Buffer.from("hello");
    connected = undefined;
    dnsLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fakeRequest = (
        _url: URL,
        opts: RequestOptions,
        callback: (response: IncomingMessage) => void,
    ): ClientRequest => {
        options = opts;
        const req = new EventEmitter() as ClientRequest;
        req.end = (() => {
            opts.lookup?.("example.com", { all: true }, (error, addresses) => {
                if (error) {
                    req.emit("error", error);
                    return;
                }
                connected = addresses;
                const response = Readable.from([payload]) as IncomingMessage;
                response.statusCode = status;
                callback(response);
            });
            return req;
        }) as ClientRequest["end"];
        return req;
    };
    vi.mocked(request).mockImplementation(fakeRequest as typeof request);
});

it("connects only to validated DNS answers, without an agent or authorization", async () => {
    expect(await fetchPublicFile("https://example.com/file.txt")).toEqual(payload);
    expect(connected).toEqual([{ address: "93.184.216.34", family: 4 }]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(options.agent).toBe(false);
    expect(options.headers).toBeUndefined();
    expect(options.auth).toBeUndefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
});

it.each([
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "192.168.0.1",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
    "2002:7f00:1::",
])("rejects a public hostname resolving to %s", async (address) => {
    dnsLookup.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }]);
    await expect(fetchPublicFile("https://example.com/file.txt")).rejects.toThrow("BLOCKED");
    expect(connected).toBeUndefined();
});

it("rejects mixed public/private DNS results and missing addresses", async () => {
    dnsLookup.mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
    ]);
    await expect(fetchPublicFile("https://example.com/file.txt")).rejects.toThrow("BLOCKED");
    dnsLookup.mockResolvedValue([]);
    await expect(fetchPublicFile("https://example.com/file.txt")).rejects.toThrow("BLOCKED");
});

it.each([302, 307, 500])("rejects status %s without following a redirect", async (code) => {
    status = code;
    await expect(fetchPublicFile("https://example.com/file.txt")).rejects.toThrow("UNAVAILABLE");
    expect(request).toHaveBeenCalledTimes(1);
});

it("distinguishes missing files and bounds the actual downloaded body", async () => {
    status = 404;
    await expect(fetchPublicFile("https://example.com/file.txt")).rejects.toThrow("NOT_FOUND");
    status = 200;
    payload = Buffer.alloc(2 * 1024 * 1024 + 1);
    await expect(fetchPublicFile("https://example.com/file.txt")).rejects.toThrow("UNAVAILABLE");
});

it("also works as a serialized child function and rejects literal private addresses before connecting", () => {
    // Load outside Vitest so its import instrumentation cannot leak into the child source.
    const script = `
        import { fetchPublicFile } from ${JSON.stringify(new URL("./public-file.ts", import.meta.url).href)};
        import { execFileSync } from "node:child_process";
        const child = "const __name = value => value; (" + fetchPublicFile.toString() + ")('https://127.0.0.1/file.txt').catch(error => process.stdout.write(error.message));";
        process.stdout.write(execFileSync(process.execPath, ["--input-type=module", "-e", child]));
    `;
    expect(
        execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
            timeout: 5000,
        }).toString(),
    ).toBe("BLOCKED");
});
