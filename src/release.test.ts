import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { release } from "./release.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
});
function fixture(target: string, status: string, conclusion = "") {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let requestId = "";
    let bump = "";
    const command = vi.fn((args: string[]) => {
        if (args[0] === "workflow") {
            requestId = args.find((arg) => arg.startsWith("request_id="))?.slice(11) ?? "";
            bump = args.find((arg) => arg.startsWith("bump="))?.slice(5) ?? "";
            return "";
        }
        if (args[1] === "list")
            return JSON.stringify([
                {
                    databaseId: 99,
                    displayTitle: `Release ${target} ${bump} another-request`,
                    url: "other",
                },
                {
                    databaseId: 42,
                    displayTitle: `Release ${target} ${bump} ${requestId}`,
                    url: "https://example.com/run/42",
                },
            ]);
        expect(args[2]).toBe("42");
        return JSON.stringify({
            status: status === "completed" ? "completed" : "in_progress",
            conclusion,
            jobs: [
                {
                    steps: [
                        {
                            name:
                                target === "dooc"
                                    ? "Publish GitHub release dooc-v0.0.10"
                                    : "Publish npm package v0.0.10",
                            status,
                            conclusion,
                        },
                    ],
                },
            ],
        });
    });
    return command;
}

describe.each(["dooc", "dooc-plugin"])("release %s", (target) => {
    it("only publishes through workflow_dispatch", () => {
        const filename = target === "dooc" ? "release.yml" : "publish-plugin.yml";
        const workflow = parse(
            readFileSync(new URL(`../.github/workflows/${filename}`, import.meta.url), "utf8"),
        );
        expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
        expect(workflow.on.workflow_dispatch.inputs.bump.options).toEqual([
            "patch",
            "minor",
            "major",
        ]);
        expect(workflow["run-name"]).toBe(
            `Release ${target} \${{ inputs.bump }} \${{ inputs.request_id }}`,
        );
    });
    it.each([
        "patch",
        "minor",
        "major",
    ])("dispatches and monitors a %s release in dooc-dev/dooc", async (bump) => {
        const command = fixture(target, "completed", "success");
        vi.mocked(execFileSync).mockImplementation((_file, args) => command(args as string[]));
        expect(await release(target, bump)).toEqual({
            version: "v0.0.10",
            url: "https://example.com/run/42",
        });
        const workflow = target === "dooc" ? "release.yml" : "publish-plugin.yml";
        expect(command.mock.calls[0]?.[0]).toEqual([
            "workflow",
            "run",
            workflow,
            "--ref",
            "main",
            "-f",
            `bump=${bump}`,
            "-f",
            expect.stringMatching(/^request_id=.+/),
            "--repo",
            "dooc-dev/dooc",
        ]);
        expect(command.mock.calls[1]?.[0]).toContain(workflow);
        for (const [file, args] of vi.mocked(execFileSync).mock.calls) {
            expect(file).toBe("gh");
            expect((args as string[]).slice(-2)).toEqual(["--repo", "dooc-dev/dooc"]);
        }
    });
    it("returns the version of this dispatch after publishing succeeds", async () => {
        const command = fixture(target, "completed", "success");
        expect(await release(target, "patch", command)).toEqual({
            version: "v0.0.10",
            url: "https://example.com/run/42",
        });
        expect(command.mock.calls.filter(([args]) => args[0] === "workflow")).toHaveLength(1);
    });
    it("monitors only the dispatched run through discovery and queueing", async () => {
        const command = fixture(target, "completed", "success");
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
        expect(await release(target, "patch", poll, pause)).toEqual({
            version: "v0.0.10",
            url: "https://example.com/run/42",
        });
        expect(pause).toHaveBeenCalledTimes(3);
    });
    it("does not report the other package's publishing step as completion", async () => {
        const command = fixture(target, "completed", "success");
        const expected = target === "dooc" ? "Publish GitHub release" : "Publish npm package";
        const other = target === "dooc" ? "Publish npm package" : "Publish GitHub release";
        await expect(
            release(target, "patch", (args) => command(args).replace(expected, other)),
        ).rejects.toThrow("did not finish publishing");
    });
    it("fails for skipped or failed publishing without claiming a version", async () => {
        for (const conclusion of ["failure", "skipped", "cancelled"]) {
            await expect(
                release(target, "patch", fixture(target, "completed", conclusion)),
            ).rejects.toThrow("did not finish publishing");
        }
    });
    it("waits for queued publishing, times out, and does not redispatch", async () => {
        const command = fixture(target, "queued");
        let time = 0;
        const pause = vi.fn(async () => {
            time += 30 * 60_000;
        });
        await expect(release(target, "patch", command, pause, () => time)).rejects.toThrow(
            "Timed out",
        );
        expect(pause).toHaveBeenCalledOnce();
        expect(command.mock.calls.filter(([args]) => args[0] === "workflow")).toHaveLength(1);
    });
    it("rejects invalid increments before dispatch", async () => {
        const command = vi.fn();
        await expect(release(target, "invalid", command)).rejects.toThrow(
            "Expected patch, minor or major",
        );
        expect(command).not.toHaveBeenCalled();
    });
});

it.each([
    "",
    "unknown",
    "@dooc-dev/dooc",
])("rejects invalid target %j before dispatch", async (target) => {
    const command = vi.fn();
    await expect(release(target, "patch", command)).rejects.toThrow("Expected dooc or dooc-plugin");
    expect(command).not.toHaveBeenCalled();
});
