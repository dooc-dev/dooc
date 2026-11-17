import { beforeEach, expect, it, vi } from "vitest";
import { fetchPublicFile } from "../../engine/src/compiler/public-file.js";
import { frameBlocked } from "./frame-policy.js";

vi.mock("../../engine/src/compiler/public-file.js", () => ({ fetchPublicFile: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

it.each([
    [{ "x-frame-options": "DENY" }, "https://example.com", true],
    [{ "x-frame-options": "SAMEORIGIN" }, "http://localhost:3000", true],
    [{ "x-frame-options": "sameorigin" }, "https://example.com", undefined],
    [
        { "content-security-policy": "default-src 'self'; frame-ancestors 'none'" },
        "https://example.com",
        true,
    ],
    [{ "content-security-policy": "frame-ancestors 'self'" }, "http://localhost:3000", true],
    [{ "content-security-policy": "frame-ancestors 'self'" }, "https://example.com", undefined],
    [
        { "content-security-policy": "frame-ancestors https:", "x-frame-options": "DENY" },
        "https://viewer.example.com",
        undefined,
    ],
    [{}, "http://localhost:3000", undefined],
] as const)("recognizes definite framing denials: %j", async (headers, parent, blocked) => {
    vi.mocked(fetchPublicFile).mockImplementation(
        async (_url, _type, _progress, _address, inspect) => {
            inspect?.(headers);
            return Buffer.alloc(0);
        },
    );
    expect(await frameBlocked("https://example.com/page", parent)).toBe(blocked);
});

it("leaves unavailable and redirected responses to the browser", async () => {
    vi.mocked(fetchPublicFile).mockRejectedValue(new Error("UNAVAILABLE"));
    expect(await frameBlocked("https://example.com", "http://localhost:3000")).toBeUndefined();
});
