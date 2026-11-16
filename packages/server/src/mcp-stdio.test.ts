import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "dooc-stdio-"));
    roots.push(root);
    mkdirSync(join(root, "content"));
    writeFileSync(join(root, "dooc.yaml"), "docs: [guide]\n");
    writeFileSync(join(root, "content/guide.md"), "Published text\n");
    return root;
};
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const args = (product: string, root: string) => [
    "--import",
    "tsx",
    cli,
    product,
    "run",
    "node",
    "--mcp",
    "--mcp-transport",
    "stdio",
    "--project",
    root,
];
const request = (id: number, method: string, params?: unknown) =>
    JSON.stringify({ jsonrpc: "2.0", id, method, params });
const call = (id: number, name: string, args: unknown) =>
    request(id, "tools/call", { name, arguments: args });
const run = (product: string, root: string, input: string[], extra: string[] = []) =>
    execFileSync(process.execPath, [...args(product, root), ...extra], {
        input: `${input.join("\n")}\n`,
        encoding: "utf8",
        timeout: 15000,
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
    })
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

it("serves only JSON-RPC on stdout and completes editor writes before subsequent reads", () => {
    const root = fixture();
    const responses = run("editor", root, [
        "{",
        "null",
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        request(1, "initialize", { protocolVersion: "2024-11-05" }),
        request(2, "tools/list"),
        call(3, "write_file", { file: "note.txt", content: "Saved through stdio", base: null }),
        call(4, "read_file", { file: "note.txt" }),
    ]);
    expect(responses).toHaveLength(6);
    expect(responses[0]).toMatchObject({ error: { code: -32700 } });
    expect(responses[1]).toMatchObject({ error: { code: -32600 } });
    expect(responses[2]).toMatchObject({ id: 1, result: { protocolVersion: "2024-11-05" } });
    expect(responses[3].result.tools.map((tool: { name: string }) => tool.name)).toContain(
        "write_file",
    );
    expect(responses[4]).toMatchObject({ id: 3, result: { isError: false } });
    expect(JSON.parse(responses[5].result.content[0].text)).toMatchObject({
        content: "Saved through stdio",
    });
    expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("Saved through stdio");
}, 20000);

it.each([
    "latest",
    "0.0.0",
])("serves reader publication %s and rejects mutation tools", (version) => {
    const root = fixture();
    const git = (...args: string[]) =>
        execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("config", "core.hooksPath", "/dev/null");
    git("add", ".");
    git("commit", "-m", "First publication");
    writeFileSync(join(root, "content/guide.md"), "Latest publication\n");
    git("add", ".");
    git("commit", "-m", "Second publication");
    writeFileSync(join(root, "content/guide.md"), "Unpublished draft\n");
    const responses = run(
        "reader",
        root,
        [
            request(1, "tools/list"),
            call(2, "read_doc", { id: "guide" }),
            call(3, "write_file", { file: "note.txt", content: "Denied", base: null }),
            call(4, "build", { format: "html" }),
        ],
        ["--versions", version],
    );
    const names = responses[0].result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("read_doc");
    for (const name of ["write_file", "build", "git", "history"]) expect(names).not.toContain(name);
    expect(JSON.parse(responses[1].result.content[0].text)).toMatchObject({
        raw: version === "latest" ? "Latest publication\n" : "Published text\n",
    });
    for (const response of responses.slice(2))
        expect(response).toMatchObject({ error: { code: -32602 } });
    expect(readFileSync(join(root, "content/guide.md"), "utf8")).toBe("Unpublished draft\n");
}, 20000);

it("stops on SIGTERM while the stdio input remains open", async () => {
    const child = spawn(process.execPath, args("editor", fixture()), { stdio: "pipe" });
    const closed = once(child, "close");
    child.stderr.resume();
    try {
        const reply = once(child.stdout, "data");
        child.stdin.write(`${request(1, "ping")}\n`);
        expect(JSON.parse(String((await reply)[0]))).toMatchObject({ id: 1, result: {} });
        child.kill("SIGTERM");
        expect(await closed).toEqual([0, null]);
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
    }
}, 20000);
