import { describe, expect, it } from "vitest";
import { parseWorkspaceSource, workspaceLabel } from "./workspace.js";

describe("workspace metadata", () => {
    it("distinguishes Git branches from service-owned storage labels and icons", () => {
        expect(
            workspaceLabel(parseWorkspaceSource({ protocol: "git", branch: "docs/update" })),
        ).toBe("docs/update");
        expect(parseWorkspaceSource({ protocol: "git", branch: "main", repo: "my-repo" })).toEqual({
            protocol: "git",
            branch: "main",
            repo: "my-repo",
        });
        const storage = {
            protocol: "storage",
            folder: "team/docs",
            service: "Object store",
            icon: '<svg viewBox="0 0 20 20"><path d="M2 2h16v16H2z"/></svg>',
        };
        expect(parseWorkspaceSource(storage)).toEqual(storage);
        expect(workspaceLabel(parseWorkspaceSource(storage))).toBe("team/docs / Object store");
    });

    it.each([
        null,
        [],
        { protocol: "git", branch: "" },
        { protocol: "git", branch: "main\nother" },
        { protocol: "git", branch: "main", repo: "" },
        { protocol: "storage", folder: "docs" },
        { protocol: "storage", folder: " ", service: "Local" },
        { protocol: "storage", folder: "docs", service: "Local", icon: {} },
        { protocol: "provider", folder: "docs", service: "Provider" },
    ])("rejects invalid metadata: %j", (value) => {
        expect(() => parseWorkspaceSource(value)).toThrow();
    });
});
