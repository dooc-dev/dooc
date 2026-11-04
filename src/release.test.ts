import { afterEach, describe, expect, it, vi } from "vitest";
import { release } from "./release.js";

afterEach(() => vi.restoreAllMocks());
function fixture(status: string, conclusion = "") {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let requestId = "";
    const command = vi.fn((args: string[]) => {
        if (args[0] === "workflow") {
            requestId = args.find((arg) => arg.startsWith("request_id="))?.slice(11) ?? "";
            return "";
        }
        if (args[1] === "list")
            return JSON.stringify([
                { databaseId: 99, displayTitle: "Release patch another-request", url: "other" },
                {
                    databaseId: 42,
                    displayTitle: `Release patch ${requestId}`,
                    url: "https://example.com/run/42",
                },
            ]);
        expect(args[2]).toBe("42");
        return JSON.stringify({
            status: status === "completed" ? "completed" : "in_progress",
            conclusion,
            jobs: [{ steps: [{ name: "Publish GitHub release v0.0.10", status, conclusion }] }],
        });
    });
    return command;
}

describe("release command", () => {
    it("returns the version of this dispatch after binary publishing succeeds", async () => {
        const command = fixture("completed", "success");
        expect(await release("patch", command)).toEqual({
            version: "v0.0.10",
            url: "https://example.com/run/42",
        });
        expect(command.mock.calls.filter(([args]) => args[0] === "workflow")).toHaveLength(1);
    });
    it("monitors only the dispatched run through discovery and queueing", async () => {
        const command = fixture("completed", "success");
        let lists = 0;
        let views = 0;
        const poll = (args: string[]) => {
            const output = command(args);
            if (args[1] === "list" && lists++ === 0) return "[]";
            if (args[1] === "view" && views++ < 2) {
                const progress = JSON.parse(output);
                progress.status = "in_progress";
                progress.jobs[0].steps[0].status = views === 1 ? "queued" : "in_progress";
                return JSON.stringify(progress);
            }
            return output;
        };
        const pause = vi.fn(async () => {});
        expect(await release("patch", poll, pause)).toEqual({
            version: "v0.0.10",
            url: "https://example.com/run/42",
        });
        expect(pause).toHaveBeenCalledTimes(3);
    });
    it("does not report npm publishing alone as a completed binary release", async () => {
        const command = fixture("completed", "success");
        await expect(
            release("patch", (args) =>
                command(args).replace("Publish GitHub release", "Publish private npm package"),
            ),
        ).rejects.toThrow("did not finish publishing");
    });
    it("fails for skipped or failed publishing without claiming a version", async () => {
        for (const conclusion of ["failure", "skipped", "cancelled"]) {
            await expect(release("patch", fixture("completed", conclusion))).rejects.toThrow(
                "did not finish publishing",
            );
        }
    });
    it("waits for queued publishing, times out, and does not redispatch", async () => {
        const command = fixture("queued");
        let time = 0;
        const pause = vi.fn(async () => {
            time += 30 * 60_000;
        });
        await expect(release("patch", command, pause, () => time)).rejects.toThrow("Timed out");
        expect(pause).toHaveBeenCalledOnce();
        expect(command.mock.calls.filter(([args]) => args[0] === "workflow")).toHaveLength(1);
    });
    it("rejects invalid increments before dispatch", async () => {
        const command = vi.fn();
        await expect(release("invalid", command)).rejects.toThrow("Expected");
        expect(command).not.toHaveBeenCalled();
    });
});
