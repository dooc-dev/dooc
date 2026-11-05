import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
    chmodSync,
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "dooc-binary-"));
const binary = join(root, "dooc");
let server;
try {
    copyFileSync(resolve(process.argv[2] ?? "build/bin/dooc"), binary);
    chmodSync(binary, 0o755);
    const options = {
        cwd: root,
        env: { ...process.env, PATH: "" },
        encoding: "utf8",
        timeout: 30_000,
    };
    const run = (...args) => execFileSync(binary, args, options);
    assert.match(run("--help"), /usage: dooc/);
    assert.ok(JSON.parse(run("json-schema", "latest")).properties.generation);
    mkdirSync(join(root, "content"));
    writeFileSync(join(root, "manifest.yaml"), "defaultLang: ja\ndocs:\n  - guide\n");
    writeFileSync(
        join(root, "content/guide.md"),
        "---\ntitle: Guide\n---\n# Hello\n\n```js\nconst x = 1;\n```\n\n```grapth\n[a]: 書く\n[b]: 共有する\n[a] -> [b]\n```\n",
    );
    run("code-language", "add", "python");
    assert.ok(JSON.parse(readFileSync(join(root, ".dooc/code-languages/python.json"))).length);
    run("export", "json");
    assert.equal(JSON.parse(readFileSync(join(root, "dist/artifact/docs.json"))).docs.length, 1);
    run("export", "html");
    const html = readFileSync(join(root, "dist/index.html"), "utf8");
    assert.match(html, /data:font\/woff2;base64,/);
    assert.match(html, /Hello/);
    run("export", "zip");
    assert.match(run("doc", "ls"), /guide/);
    const rpc = execFileSync(binary, ["mcp"], {
        ...options,
        input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
    });
    assert.ok(JSON.parse(rpc).result.tools.some((tool) => tool.name === "list_docs"));
    server = spawn(binary, ["edit", root, "0"], options);
    let output = "";
    server.stderr.on("data", (data) => {
        output += data;
    });
    const url = await new Promise((resolveUrl, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`Server did not start: ${output}`)),
            30_000,
        );
        server.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        server.once("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`Server exited (${code}): ${output}`));
        });
        server.stdout.on("data", (data) => {
            output += data;
            const match = /http:\/\/localhost:\d+\//.exec(output);
            if (match) {
                clearTimeout(timer);
                resolveUrl(match[0].replace("localhost", "127.0.0.1"));
            }
        });
    });
    for (const path of [
        "guide",
        "assets/edit.js",
        "assets/ui.js",
        "assets/code.js",
        "assets/fonts/udev-gothic-regular.woff2",
    ]) {
        const response = await fetch(new URL(path, url), { signal: AbortSignal.timeout(30_000) });
        assert.equal(response.status, 200, path);
        assert.ok((await response.arrayBuffer()).byteLength > 0, path);
    }
    const lint = await fetch(new URL("api/lint", url), {
        signal: AbortSignal.timeout(30_000),
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: url.slice(0, -1) },
        body: JSON.stringify({ lang: "ja", body: "私は彼は好きな食べ物について話した。\n" }),
    });
    assert.equal(lint.status, 200, await lint.clone().text());
    assert.ok(
        (await lint.json()).findings.some((finding) => finding.ruleId === "no-doubled-joshi"),
    );
    console.log(
        "Standalone CLI, MCP, exports, syntax grammars, editor assets, and Japanese lint passed (empty PATH).",
    );
} finally {
    if (server && server.exitCode === null && server.signalCode === null) {
        const exited = once(server, "exit");
        server.kill();
        await exited;
    }
    rmSync(root, { recursive: true, force: true });
}
