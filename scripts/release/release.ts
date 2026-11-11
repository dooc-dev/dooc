import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const repo = "dooc-dev/dooc";
const gh = (args: string[]): string =>
    execFileSync("gh", [...args, "--repo", repo], {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "inherit"],
    });

interface Run {
    databaseId: number;
    displayTitle: string;
    url: string;
}
interface Progress {
    status: string;
    conclusion: string;
    jobs: { steps: { name: string; status: string; conclusion: string }[] }[];
}

export async function release(
    target: string,
    bump: string,
    command = gh,
    pause = () => setTimeout(5000),
    now = Date.now,
): Promise<{ version: string; url: string }> {
    if (!["dooc", "dooc-plugin"].includes(target)) throw new Error("Expected dooc or dooc-plugin");
    if (!["patch", "minor", "major"].includes(bump))
        throw new Error("Expected patch, minor or major");
    const workflow = target === "dooc" ? "release.yml" : "publish-plugin.yml";
    const publishedStep =
        target === "dooc"
            ? /^Publish GitHub release dooc-(v\d+\.\d+\.\d+)$/
            : /^Publish npm package (v\d+\.\d+\.\d+)$/;
    const requestId = randomUUID();
    const title = `Release ${target} ${bump} ${requestId}`;
    const deadline = now() + 30 * 60_000;
    command([
        "workflow",
        "run",
        workflow,
        "--ref",
        "main",
        "-f",
        `bump=${bump}`,
        "-f",
        `request_id=${requestId}`,
    ]);
    console.error(`status: waiting\nrequest: ${requestId}`);
    let run: Run | undefined;
    while (now() < deadline) {
        if (!run) {
            const runs: Run[] = JSON.parse(
                command([
                    "run",
                    "list",
                    "--workflow",
                    workflow,
                    "--event",
                    "workflow_dispatch",
                    "--branch",
                    "main",
                    "--limit",
                    "100",
                    "--json",
                    "databaseId,displayTitle,url",
                ]),
            );
            run = runs.find((candidate) => candidate.displayTitle === title);
            if (run) console.error(`workflow: ${run.url}`);
        }
        if (run) {
            const progress: Progress = JSON.parse(
                command([
                    "run",
                    "view",
                    String(run.databaseId),
                    "--json",
                    "status,conclusion,jobs",
                ]),
            );
            for (const step of progress.jobs.flatMap((job) => job.steps)) {
                const version = publishedStep.exec(step.name)?.[1];
                if (!version) continue;
                if (step.status === "completed" && step.conclusion === "success") {
                    return { version, url: run.url };
                }
            }
            if (progress.status === "completed")
                throw new Error(
                    `Release did not finish publishing (${progress.conclusion}): ${run.url}`,
                );
        }
        await pause();
    }
    throw new Error(
        `Timed out waiting for release; inspect the existing run before retrying: ${run?.url ?? requestId}`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    release(process.argv[2] ?? "", process.argv[3] ?? "").then(
        ({ version, url }) =>
            console.log(`status: success\nphase: published\nworkflow: ${url}\nversion: ${version}`),
        (error) => {
            console.error(
                `status: error\nmessage: ${error instanceof Error ? error.message : String(error)}`,
            );
            process.exitCode = 1;
        },
    );
}
