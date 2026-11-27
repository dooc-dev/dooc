import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { buildBundle, writeBuildOutput } from "../../dist/server/build.js";

export async function testSplitBuild(page, root) {
    const project = join(root, "split-build");
    mkdirSync(join(project, "content"), { recursive: true });
    mkdirSync(join(project, "figures"));
    writeFileSync(
        join(project, "dooc.yaml"),
        "title: Split publication\ndefaultLang: eng\ndocs: [guide, next, third]\n",
    );
    const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aXcAAAAASUVORK5CYII=";
    writeFileSync(join(project, "figures/pixel.png"), Buffer.from(png, "base64"));
    writeFileSync(
        join(project, "figures/frame.html"),
        `<!--fig\ntitle: Embedded image\n-->\n<div><img alt="Inside frame" src="data:image/png;base64,${png}"></div>`,
    );
    writeFileSync(
        join(project, "content/guide.md"),
        "# First page\n\n![Picture](figures/pixel.png)\n\n![Frame](figures/frame.html)\n\n```mermaid\ngraph TD\n A[First] --> B[Second]\n```\n\n```ts\nconst value = 1;\n```\n",
    );
    writeFileSync(join(project, "content/next.md"), "# Second page\n\nSecond document content.\n");
    writeFileSync(join(project, "content/third.md"), "# Third page\n\nThird document content.\n");
    const bundle = await buildBundle(project, {
        format: "html",
        mode: "static",
        split: true,
        maxFileSize: "25MiB",
        maxBuildSize: "100MiB",
    });
    writeBuildOutput(join(project, "build/index.html"), bundle);
    const files = new Map([["index.html", Buffer.from(bundle.data)], ...bundle.files]);
    const requests = [];
    let failed;
    let delayed;
    let release;
    let started;
    const types = {
        html: "text/html",
        js: "text/javascript",
        css: "text/css",
        png: "image/png",
        woff2: "font/woff2",
    };
    const server = createServer((req, res) => {
        const file = new URL(req.url, "http://localhost").pathname.replace(
            /^\/published\/v1\//,
            "",
        );
        requests.push(file);
        const send = () => {
            const data = files.get(file);
            res.writeHead(data ? 200 : 404, {
                "Content-Type": types[file.split(".").at(-1)] ?? "application/octet-stream",
            });
            res.end(data ?? "Missing");
        };
        if (file === failed) {
            failed = undefined;
            res.writeHead(503);
            res.end("Unavailable");
        } else if (file === delayed) {
            delayed = undefined;
            release = () => {
                release = undefined;
                send();
            };
            started();
        } else send();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const url = `http://127.0.0.1:${server.address().port}/published/v1/index.html#/guide`;
        await page.goto(url);
        await page.locator("main article").waitFor();
        await page.waitForFunction(() =>
            [...document.querySelectorAll("main img")].some((img) => img.naturalWidth === 1),
        );
        const frame = page.frameLocator('iframe[data-doc-figure-frame="html"]');
        await frame.locator("img").waitFor();
        assert.equal(
            await frame.locator("img").evaluate((img) => img.complete && img.naturalWidth === 1),
            true,
        );
        await page.locator("[data-mermaid]").scrollIntoViewIfNeeded();
        await page.locator('[data-mermaid="ready"] svg').waitFor();
        await page.evaluate(() => document.fonts.ready);
        assert.ok(
            requests.some((file) => file.endsWith(".woff2")),
            "CSS fonts must resolve from nested hosting paths",
        );
        assert.ok(
            requests.some((file) => /dooc-assets\/[a-f0-9]+\/.*\.js/.test(file)),
            "ESM diagram chunks must load",
        );
        const nextFile = await page.locator('template[data-route="next"]').getAttribute("data-src");
        await page.locator("#sidebar").evaluate((element) => {
            element.dataset.retained = "yes";
        });
        delayed = nextFile.slice(2);
        const waiting = new Promise((resolve) => {
            started = resolve;
        });
        await page.locator('#nav-groups a[href="#/next"]').click();
        await waiting;
        assert.equal(
            await page.locator('#nav-groups a[href="#/next"]').getAttribute("aria-current"),
            "page",
        );
        assert.equal(await page.locator("main").getAttribute("aria-busy"), "true");
        await page.locator("#sidebar-toggle").click();
        assert.equal(await page.locator("#sidebar-toggle").getAttribute("aria-expanded"), "false");
        await page.locator("#sidebar-toggle").click();
        await page.locator('#nav-groups a[href="#/third"]').click();
        await page.waitForFunction(() =>
            document.querySelector("main").textContent.includes("Third document content."),
        );
        release();
        await page.locator('#nav-groups a[href="#/third"] [data-nav-loading="complete"]').waitFor();
        assert.equal(
            await page.locator('#nav-groups a[href="#/next"] [data-nav-loading]').count(),
            0,
        );
        assert.match(await page.locator("main").textContent(), /Third document content/);
        assert.equal(await page.locator("#sidebar").getAttribute("data-retained"), "yes");
        await page.locator('#nav-groups a[href="#/next"]').click();
        await page.waitForFunction(() =>
            document.querySelector("main").textContent.includes("Second document content."),
        );
        failed = nextFile.slice(2);
        await page.goto(url.replace("index.html#", "index.html?retry#"));
        await page.locator("main article").waitFor();
        await page.locator('#nav-groups a[href="#/next"]').click();
        await page.locator('main [role="alert"]').waitFor();
        assert.equal(await page.locator("[data-nav-loading]").count(), 0);
        assert.match(await page.locator('main [role="alert"]').textContent(), /503/);
        assert.equal(await page.locator("#sidebar").isVisible(), true);
        await page.locator('#nav-groups a[href="#/guide"]').click();
        await page.locator("main article").waitFor();
        await page.locator('#nav-groups a[href="#/next"]').click();
        await page.waitForFunction(() =>
            document.querySelector("main").textContent.includes("Second document content."),
        );
        return {
            files: files.size,
            bytes: bundle.bytes,
            largest: Math.max(...[...files.values()].map((data) => data.length)),
        };
    } finally {
        release?.();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}
