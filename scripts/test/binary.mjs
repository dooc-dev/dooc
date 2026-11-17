import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";

const root = mkdtempSync(join(tmpdir(), "dooc-binary-"));
const binary = join(root, "dooc");
let server;
let socket;
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
    assert.match(run("self", "docs", "--help"), /GitHub/);
    assert.equal(existsSync(resolve("dist/dooc-docs")), false);
    const docsContent = readFileSync("dooc-docs/contents/md/system.md");
    const executable = readFileSync(binary);
    assert.ok(docsContent.length > 100);
    assert.equal(executable.includes(docsContent), false);
    assert.equal(executable.includes(Buffer.from(docsContent.toString("base64"))), false);
    assert.match(run("init"), /Created/);
    assert.match(readFileSync(join(root, "dooc.yaml"), "utf8"), /document:\n\s+url: ""/);
    mkdirSync(join(root, "content"));
    writeFileSync(
        join(root, "dooc.yaml"),
        "system:\n  default_lang: jpn\ndocument:\n  children:\n    - document:\n        url: content/guide.md\n",
    );
    writeFileSync(
        join(root, "content/guide.md"),
        "# Hello\n\n```js\nconst x = 1;\n```\n\n```graphth\n[a]: 書く\n[b]: 共有する\n[a] -> [b]\n```\n\n```mermaid\nflowchart LR\n A --> B\n```\n",
    );
    run("build", "--url_preview=embed");
    assert.ok(!existsSync(join(root, "dist/bundle.zip")));
    const html = readFileSync(join(root, "build/index.html"), "utf8");
    run("reader", "build", "web", "--client", "--server", "--out", "reader-web");
    assert.ok(existsSync(join(root, "reader-web/assets/workspace-worker.js")));
    assert.ok(!existsSync(join(root, "reader-web/assets/edit.js")));
    for (const product of ["editor", "reader"]) {
        const output = `${product}-web-mcp`;
        run(
            product,
            "build",
            "web",
            "--all",
            "--relay-url",
            "https://relay.example",
            "--out",
            output,
        );
        assert.ok(existsSync(join(root, output, "assets/mcp.js")));
        assert.ok(existsSync(join(root, output, "assets/workspace-worker.js")));
        assert.equal(
            JSON.parse(readFileSync(join(root, output, "dooc-client.json"), "utf8")).relayUrl,
            "https://relay.example",
        );
    }
    assert.match(run("relay", "--help"), /DOOC_MCP_RELAY_SECRET/);
    run("editor", "build", "node", "--all", "--out", "editor-node");
    assert.match(
        readFileSync(join(root, "editor-node/start.mjs"), "utf8"),
        /@dooc-dev\/dooc\/runtime/,
    );
    assert.match(
        readFileSync(join(root, "editor-node/client/index.html"), "utf8"),
        /\/client\/assets\/client.js/,
    );
    assert.ok(!existsSync(join(root, "editor-node/client/assets/workspace-worker.js")));
    assert.match(html, /data:font\/woff2;base64,/);
    assert.match(html, /Hello/);
    assert.match(html, /data-mermaid="pending"/);
    run("zip");
    assert.equal(readFileSync(join(root, "build/index.html"), "utf8"), html);
    assert.ok(readFileSync(join(root, "dist/bundle.zip")).subarray(0, 2).equals(Buffer.from("PK")));
    const rpc = execFileSync(
        binary,
        ["editor", "run", "node", "--mcp", "--mcp-transport", "stdio"],
        {
            ...options,
            input: [
                "{",
                "null",
                JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
                JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
                JSON.stringify({
                    jsonrpc: "2.0",
                    id: 2,
                    method: "tools/call",
                    params: { name: "build", arguments: { format: "zip" } },
                }),
                JSON.stringify({
                    jsonrpc: "2.0",
                    id: 3,
                    method: "tools/call",
                    params: {
                        name: "write_file",
                        arguments: { file: "mcp.txt", content: "Created after build", base: null },
                    },
                }),
                JSON.stringify({
                    jsonrpc: "2.0",
                    id: 4,
                    method: "tools/call",
                    params: { name: "read_file", arguments: { file: "mcp.txt" } },
                }),
                "",
            ].join("\n"),
        },
    );
    const replies = rpc
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    assert.equal(replies[0].error.code, -32700);
    assert.equal(replies[1].error.code, -32600);
    assert.ok(replies[2].result.tools.some((tool) => tool.name === "git"));
    assert.deepEqual(
        replies.slice(2).map((reply) => reply.id),
        [1, 2, 3, 4],
    );
    assert.equal(JSON.parse(replies[3].result.content[0].text).file, "dist/bundle.zip");
    assert.equal(JSON.parse(replies[4].result.content[0].text).ok, true);
    assert.equal(JSON.parse(replies[5].result.content[0].text).content, "Created after build");
    assert.match(run("editor", "--help"), /--mcp-transport stdio\|http/);
    const startServer = async (...args) => {
        server = spawn(binary, args, options);
        let output = "";
        return await new Promise((resolveUrl, reject) => {
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
            const readOutput = (data) => {
                output += data;
                const match = /http:\/\/localhost:\d+\/client\//.exec(output);
                if (match) {
                    clearTimeout(timer);
                    resolveUrl(match[0].replace("localhost", "127.0.0.1"));
                }
            };
            server.stdout.on("data", readOutput);
            server.stderr.on("data", readOutput);
        });
    };
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const url = await startServer(
        "editor",
        "run",
        "node",
        "--all",
        "--project",
        join(root, "dooc.yaml"),
        "--port",
        String(port),
    );
    for (const path of [
        "guide",
        "assets/edit.js",
        "assets/ui.js",
        "assets/code.js",
        "assets/code-worker.js",
        "assets/graph.js",
        "assets/fonts/udev-gothic-regular.woff2",
    ]) {
        const response = await fetch(new URL(path, url), { signal: AbortSignal.timeout(30_000) });
        assert.equal(response.status, 200, path);
        assert.ok((await response.arrayBuffer()).byteLength > 0, path);
    }
    socket = new WebSocket(`ws://127.0.0.1:${port}/server`, { origin: `http://localhost:${port}` });
    await once(socket, "open");
    let nextId = 0;
    const request = async (path, body) => {
        const id = ++nextId;
        const response = await new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`Workspace request timed out: ${path}`)),
                30_000,
            );
            const receive = (data) => {
                const message = JSON.parse(data.toString());
                if (message.id !== id) return;
                clearTimeout(timer);
                socket.off("message", receive);
                if (message.error) reject(new Error(message.error));
                else resolve(message.value);
            };
            socket.on("message", receive);
            socket.send(
                JSON.stringify({
                    id,
                    op: "http",
                    args: {
                        url: `/${path}`,
                        method: body === undefined ? "GET" : "POST",
                        headers: { "content-type": "application/json" },
                        body: body === undefined ? "" : JSON.stringify(body),
                    },
                }),
            );
        });
        assert.equal(response.status, 200, response.body);
        return JSON.parse(response.body);
    };
    assert.ok((await request("assets/code-grammars.json")).length > 0);
    const guide = (await request("api/page?route=/guide")).boot;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><circle r="4"/></svg>';
    await request("api/icon", { file: guide.file, data: Buffer.from(svg).toString("base64") });
    assert.ok(existsSync(join(root, "icons/content/guide.md.svg")));
    assert.match(
        (await request("api/page?route=/guide")).boot.icon,
        /^data:image\/svg\+xml;base64,/,
    );
    const source = readFileSync(join(root, "content/guide.md"), "utf8");
    const translated = join(root, "locales/eng/content/guide.md");
    await request("api/translation", { file: guide.file, language: "eng", added: true });
    assert.ok(existsSync(translated));
    const english = await request(`api/doc?file=${encodeURIComponent(guide.file)}&lang=eng`);
    assert.equal(english.raw, readFileSync(translated, "utf8"));
    const change = {
        file: guide.file,
        frontmatter: { title: "English guide" },
        baseTitle: english.frontmatter.title,
        body: "Translated **content**.\n",
        baseRaw: english.raw,
    };
    const saved = await request("api/save?lang=eng", change);
    assert.equal(saved.saved, true);
    assert.equal(readFileSync(translated, "utf8"), saved.raw);
    assert.equal(readFileSync(join(root, "content/guide.md"), "utf8"), source);
    const external = "Changed outside the editor.\n";
    writeFileSync(translated, external);
    const conflict = await request("api/save?lang=eng", { ...change, baseRaw: saved.raw });
    assert.equal(conflict.conflict, true);
    assert.equal(conflict.saved, false);
    assert.equal(readFileSync(translated, "utf8"), external);
    await request("api/translation", { file: guide.file, language: "eng", added: false });
    assert.equal(existsSync(translated), false);
    assert.equal(
        (await request(`api/doc?file=${encodeURIComponent(guide.file)}&lang=eng`)).raw,
        source,
    );
    const lint = await request("api/lint", {
        lang: "ja",
        body: "私は彼は好きな食べ物について話した。\n",
    });
    assert.ok(lint.findings.some((finding) => finding.ruleId === "no-doubled-joshi"));
    const editorExited = once(server, "exit");
    server.kill();
    await editorExited;
    execFileSync(process.execPath, [resolve("scripts/test/install.mjs"), binary], {
        stdio: "inherit",
    });
    console.log(
        "Standalone CLI, MCP, bundles, editor assets, Japanese lint, self update, and documentation packaging passed.",
    );
} finally {
    socket?.terminate();
    if (server && server.exitCode === null && server.signalCode === null) {
        const exited = once(server, "exit");
        server.kill();
        await exited;
    }
    rmSync(root, { recursive: true, force: true });
}
