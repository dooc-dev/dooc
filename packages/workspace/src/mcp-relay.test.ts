import { expect, it } from "vitest";
import { desktopConnection } from "./mcp-relay.js";

it("accepts only loopback Desktop links with browser-role credentials", () => {
    const link = {
        url: "http://127.0.0.1:43123",
        browser: `${"a".repeat(36)}.r.b.${"b".repeat(43)}`,
        readOnly: true,
    };
    const hash = (value: unknown) => `#${new URLSearchParams({ dooc_mcp: JSON.stringify(value) })}`;
    expect(desktopConnection(hash(link))).toEqual(link);
    expect(desktopConnection("#heading")).toBeUndefined();
    for (const change of [
        { url: "https://evil.example" },
        { url: "http://127.0.0.1:3000/mcp" },
        { url: "http://127.0.0.1" },
        { readOnly: false },
        { browser: link.browser.replace(".b.", ".m.") },
        { browser: "invalid" },
    ])
        expect(() => desktopConnection(hash({ ...link, ...change }))).toThrow();
});
