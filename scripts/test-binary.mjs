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
    mkdirSync(join(root, "content"));
    writeFileSync(join(root, "dooc.yaml"), "defaultLang: ja\ndocs:\n  - guide\n");
    writeFileSync(
        join(root, "content/guide.md"),
        "---\ntitle: Guide\n---\n# Hello\n\n```js\nconst x = 1;\n```\n\n```grapth\n[a]: 書く\n[b]: 共有する\n[a] -> [b]\n```\n",
    );
    run("export", "html");
    const html = readFileSync(join(root, "dist/index.html"), "utf8");
    assert.match(html, /data:font\/woff2;base64,/);
    assert.match(html, /Hello/);
    run("export", "zip");
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
    const request = async (path, body) => {
        const response = await fetch(new URL(path, url), {
            signal: AbortSignal.timeout(30_000),
            ...(body === undefined
                ? {}
                : {
                      method: "POST",
                      headers: { "Content-Type": "application/json", Origin: url.slice(0, -1) },
                      body: JSON.stringify(body),
                  }),
        });
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
    };
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><circle r="4"/></svg>';
    await request("api/icon", { file: "guide.md", data: Buffer.from(svg).toString("base64") });
    assert.ok(existsSync(join(root, "files/svg/guide-icon.svg")));
    assert.match(readFileSync(join(root, "dooc.yaml"), "utf8"), /files\/svg\/guide-icon\.svg/);
    assert.match(
        (await request("api/page?route=/guide")).boot.icon,
        /^data:image\/svg\+xml;base64,/,
    );
    const source = readFileSync(join(root, "content/guide.md"), "utf8");
    const translated = join(root, "locales/eng/content/guide.md");
    await request("api/translation", { file: "guide.md", language: "eng", added: true });
    assert.ok(existsSync(translated));
    const english = await request("api/doc?file=guide.md&lang=eng");
    assert.equal(english.raw, readFileSync(translated, "utf8"));
    const change = {
        file: "guide.md",
        frontmatter: { title: "English guide" },
        body: "Translated **content**.\n",
        baseRaw: english.raw,
    };
    const saved = await request("api/save?lang=eng", change);
    assert.equal(saved.saved, true);
    assert.equal(readFileSync(translated, "utf8"), saved.raw);
    assert.equal(readFileSync(join(root, "content/guide.md"), "utf8"), source);
    const external = "---\ntitle: External edit\nlang: eng\n---\n\nChanged outside the editor.\n";
    writeFileSync(translated, external);
    const conflict = await request("api/save?lang=eng", { ...change, baseRaw: saved.raw });
    assert.equal(conflict.conflict, true);
    assert.equal(conflict.saved, false);
    assert.equal(readFileSync(translated, "utf8"), external);
    await request("api/translation", { file: "guide.md", language: "eng", added: false });
    assert.equal(existsSync(translated), false);
    assert.equal((await request("api/doc?file=guide.md&lang=eng")).raw, source);
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
        "Standalone CLI, MCP, exports, Markdown translations, editor assets, and Japanese lint passed (empty PATH).",
    );
} finally {
    if (server && server.exitCode === null && server.signalCode === null) {
        const exited = once(server, "exit");
        server.kill();
        await exited;
    }
    rmSync(root, { recursive: true, force: true });
}
