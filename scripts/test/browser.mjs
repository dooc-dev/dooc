import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { parseApplicationOptions, runApplication } from "../../dist/server/application.js";
import { buildBundle } from "../../dist/server/build.js";
import { createDevWorkspace } from "../dev-workspace.ts";
import {
    testDocumentVersionDrafts,
    testDocumentVersionLayout,
    testDocumentVersionReader,
} from "./document-versions.mjs";
import {
    testBrowserWorkspace,
    testSocketWorkspace,
    testUnavailableWorkspaceBranch,
} from "./workspace-browser.mjs";

const root = mkdtempSync(join(tmpdir(), "dooc-browser-test-"));
const applications = [];
const urls = {};
const styles = {};
let browser;

async function start(product, runtime, project, extra = [], development = false) {
    const probe = createServer();
    await new Promise((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", resolve);
    });
    const { port } = probe.address();
    await new Promise((resolve, reject) =>
        probe.close((error) => (error ? reject(error) : resolve())),
    );
    const options = parseApplicationOptions(product, [
        "run",
        runtime,
        "--client",
        "--server",
        "--port",
        String(port),
        "--project",
        project,
        ...extra,
    ]);
    applications.push(await runApplication(options, development));
    return `http://localhost:${port}${runtime === "node" ? "/client/" : "/"}`;
}

async function open(page, url, editor = true) {
    await page.goto(url);
    await page.waitForSelector(editor ? "#cm .cm-content" : "main article");
    await page.evaluate(() => document.fonts.ready);
}

before(
    async () => {
        const project = join(root, "workspace");
        createDevWorkspace(project);
        urls.editor = await start("editor", "node", project);
        urls.reader = await start("reader", "node", project, ["--versions", "*"]);
        urls.latest = await start("reader", "node", project);
        urls.web = await start("editor", "web", project);
        browser = await chromium.launch();
        const page = await browser.newPage();
        try {
            for (const mode of ["editor", "reader"]) {
                await open(page, urls[mode], mode === "editor");
                styles[mode] = await page
                    .locator("style")
                    .evaluateAll((elements) =>
                        elements.map((element) => element.outerHTML).join(""),
                    );
            }
        } finally {
            await page.close();
        }
    },
    { timeout: 120_000 },
);

after(async () => {
    try {
        await browser?.close();
        for (const application of applications) await application.close();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

function browserTest(name, run) {
    test(name, { timeout: 120_000 }, async (t) => {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        t.after(() => context.close());
        const page = await context.newPage();
        page.setDefaultTimeout(30_000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await run(page);
        assert.deepEqual(errors, [], "Browser scripts must not raise uncaught errors");
    });
}

async function inject(page, file) {
    const result = await build({
        entryPoints: [fileURLToPath(new URL(`${file}.mjs`, import.meta.url))],
        bundle: true,
        write: false,
        format: "iife",
    });
    await page.addScriptTag({ content: result.outputFiles[0].text });
}

async function blank(page, mode = "editor") {
    const url = new URL("__browser-test", urls[mode]).href;
    await page.route(url, (route) =>
        route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><html><head><meta charset="utf-8">${styles[mode]}</head><body class="${mode === "editor" ? "edit" : ""}"></body></html>`,
        }),
    );
    await page.goto(url);
}

browserTest("Document roots, included editors and standalone redirects", async (page) => {
    const project = join(root, "document-tree");
    mkdirSync(join(project, "child"), { recursive: true });
    writeFileSync(
        join(project, "dooc.yaml"),
        `document:
  title: Handbook
  children:
    - document:
        title: Reference
        url: child/dooc.yaml
    - document:
        title: Shortcut
        url: /child
    - document:
        title: Website
        url: https://example.com/
`,
    );
    writeFileSync(join(project, "child/dooc.yaml"), "document:\n  title: Guide\n  url: guide.md\n");
    writeFileSync(join(project, "child/guide.md"), "# Child guide\n\n![](example.txt)\n");
    writeFileSync(join(project, "child/example.txt"), "Child content\n");
    const url = await start("editor", "node", project);
    await page.goto(url);
    await page.locator("#nav-groups").waitFor();
    await page.locator('#site-title.cur[aria-current="page"]').waitFor();
    assert.equal(
        await page
            .locator("#nav-groups a")
            .filter({ hasText: /^Handbook$/ })
            .count(),
        0,
    );
    assert.equal(
        await page
            .locator("#nav-groups a")
            .filter({ hasText: /^Website$/ })
            .getAttribute("data-jump-url"),
        "https://example.com/",
    );
    assert.match(await page.locator("main").textContent(), /Reference/);
    assert.deepEqual(await page.locator("main h1:visible").allTextContents(), []);
    await page
        .locator("#nav-groups a")
        .filter({ hasText: /^Reference$/ })
        .click();
    await page.locator("#cm .cm-content").waitFor();
    await page.locator("#site-title:not(.cur):not([aria-current])").waitFor();
    assert.match(await page.locator("#cm .cm-content").textContent(), /example\.txt/);
    await page.locator('[data-file="child/example.txt"]').first().waitFor();
    assert.match(await page.locator("main").textContent(), /Child content/);
    await page.locator("#site-title").click();
    await page.waitForURL((current) => !current.pathname.endsWith("/child"));
    await page.locator('#site-title.cur[aria-current="page"]').waitFor();
    assert.equal(await page.locator("#nav-groups a.cur").count(), 0);
    assert.match(await page.locator("main").textContent(), /Reference/);
    for (const redirect of [false, true]) {
        if (redirect) {
            const file = join(project, "dooc.yaml");
            writeFileSync(
                file,
                readFileSync(file, "utf8").replace(
                    "  title: Handbook",
                    "  title: Handbook\n  url: redirect:first",
                ),
            );
        }
        const result = await buildBundle(project, { format: "html" });
        const file = join(root, redirect ? "redirect.html" : "index.html");
        writeFileSync(file, result.data);
        await page.goto(pathToFileURL(file).href);
        await page.locator("main article").waitFor();
        if (redirect) {
            await page.waitForURL((current) => current.hash === "#/child");
            assert.match(await page.locator("main").textContent(), /Child content/);
            assert.equal(await page.locator("#site-title").getAttribute("aria-current"), null);
            await page.locator("#site-title").click();
            await page.waitForURL((current) => current.hash === "#/child");
        } else {
            assert.match(await page.locator("main").textContent(), /Reference/);
            assert.deepEqual(await page.locator("main h1:visible").allTextContents(), []);
            assert.equal(new URL(page.url()).hash, "");
            await page.locator('#site-title.cur[aria-current="page"]').waitFor();
            await page
                .locator("#nav-groups a")
                .filter({ hasText: /^Reference$/ })
                .click();
            await page.locator("#site-title:not(.cur):not([aria-current])").waitFor();
            await page.locator("#site-title").press("Enter");
            await page.locator('#site-title.cur[aria-current="page"]').waitFor();
            assert.equal(new URL(page.url()).hash, "#/");
        }
    }
});

browserTest("Root document header navigation and title editing", async (page) => {
    const project = join(root, "root-header");
    mkdirSync(project);
    writeFileSync(
        join(project, "dooc.yaml"),
        "document:\n  title: Handbook\n  url: cover.md\n  children:\n    - document:\n        title: Guide\n        url: guide.md\n",
    );
    writeFileSync(join(project, "cover.md"), "# Authored heading\n\nWelcome to the handbook.\n");
    writeFileSync(join(project, "guide.md"), "Read the guide.\n");
    for (const product of ["editor", "reader"]) {
        const url = await start(product, "node", project);
        await open(page, `${url}?lang=eng`, product === "editor");
        assert.deepEqual(await page.locator("main h1").allTextContents(), ["Authored heading"]);
        await page.locator('#site-title.cur[aria-current="page"]').waitFor();
        assert.equal(
            new URL(await page.locator("#site-title").getAttribute("href"), url).pathname,
            "/client/",
        );
        await page
            .locator("#nav-groups a")
            .filter({ hasText: /^Guide$/ })
            .click();
        await page.locator("#site-title:not(.cur):not([aria-current])").waitFor();
        await page.locator("#site-title").press("Enter");
        await page.locator('#site-title.cur[aria-current="page"]').waitFor();
        assert.match(await page.locator("main").textContent(), /Welcome to the handbook/);
        assert.equal(await page.locator("#nav-groups a.cur").count(), 0);
        assert.equal(new URL(page.url()).searchParams.get("lang"), "eng");
        if (product !== "editor") continue;
        await page.locator("#site-title").press("F2");
        const input = page.locator('#site-title input[name="title"]');
        await input.fill("Cancelled title");
        await input.click();
        assert.equal(await page.locator("#site-title").getAttribute("href"), null);
        await input.press("Escape");
        assert.equal(await page.locator("#site-title").textContent(), "Handbook");
        await page.locator("#site-title").press("F2");
        await input.fill("Updated handbook");
        await input.press("Enter");
        await page
            .locator("#site-title[href]")
            .filter({ hasText: /^Updated handbook$/ })
            .waitFor();
        assert.equal(await page.locator("#site-title").getAttribute("aria-current"), "page");
        await page
            .locator("#nav-groups a")
            .filter({ hasText: /^Guide$/ })
            .click();
        await page.locator("#site-title:not(.cur)").waitFor();
        await page.locator("#site-title").dblclick();
        await input.press("Escape");
        await page.locator('#site-title.cur[aria-current="page"]').waitFor();
    }
});

browserTest("Save messages appear only on failure and clear after retry", async (page) => {
    const project = join(root, "save-feedback");
    mkdirSync(project);
    writeFileSync(join(project, "dooc.yaml"), "document:\n  title: Guide\n  url: guide.md\n");
    writeFileSync(join(project, "guide.md"), "Original body.\n");
    await open(page, `${await start("editor", "node", project)}?lang=eng`);
    await page.locator("#opt-autosave").evaluate((input) => {
        input.checked = false;
        input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const editor = page.locator("#cm .cm-content");
    await editor.focus();
    await page.keyboard.press("Control+End");
    await page.keyboard.insertText("\nEdited body.");
    assert.equal(await page.locator("#status").textContent(), "");
    await page.evaluate(() => {
        const connection = window.__doocConnections.items.get(window.__doocConnections.active);
        const fetch = connection.fetch;
        connection.fetch = (input, init) =>
            new URL(input, location.href).pathname.endsWith("/api/save")
                ? Promise.resolve(Response.json({ error: "Disk full" }, { status: 503 }))
                : fetch(input, init);
        window.restoreSaveFetch = () => {
            connection.fetch = fetch;
        };
    });
    await page.locator("#save").click();
    await page.locator("#status.err").filter({ hasText: "Disk full" }).waitFor();
    assert.equal(readFileSync(join(project, "guide.md"), "utf8"), "Original body.\n");
    await editor.focus();
    await page.keyboard.press("Control+End");
    await page.keyboard.insertText("\nKept after failure.");
    assert.match(await page.locator("#status.err").textContent(), /Disk full/);
    await page.evaluate(() => window.restoreSaveFetch());
    await page.locator("#save").click();
    await page.waitForFunction(() => document.getElementById("save").dataset.state === "saved");
    assert.equal(await page.locator("#status").textContent(), "");
    assert.equal(await page.locator("#status.err").count(), 0);
    assert.match(readFileSync(join(project, "guide.md"), "utf8"), /Kept after failure/);
});

browserTest("Uploaded SVG previews load automatically in the editor and reader", async (page) => {
    const project = join(root, "uploaded-preview");
    mkdirSync(project);
    writeFileSync(join(project, "dooc.yaml"), "document:\n  title: Uploads\n  url: guide.md\n");
    writeFileSync(join(project, "guide.md"), "![Uploaded SVG](files/svg/uploaded.svg)\n");
    await open(page, await start("editor", "node", project));
    await page.evaluate(() => {
        window.uploadDocument = document;
    });
    await page.locator("#nav-files").evaluate((target) => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 240"><!--${"x".repeat(100_001)}--><rect id="uploaded-shape" width="400" height="240" fill="#356cab"/></svg>`;
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(new File([svg], "uploaded.svg", { type: "image/svg+xml" }));
        target.dispatchEvent(
            new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }),
        );
    });
    const frame = page.frameLocator('iframe[data-doc-figure-frame="svg"]:visible');
    await frame.locator("#uploaded-shape").waitFor();
    assert.equal(await page.evaluate(() => window.uploadDocument === document), true);
    assert.equal(await page.locator("[data-figure-preview] > button:visible").count(), 0);
    assert(
        readFileSync(join(project, "files/svg/uploaded.svg"), "utf8").includes("uploaded-shape"),
    );
    await open(page, await start("reader", "node", project), false);
    await frame.locator("#uploaded-shape").waitFor();
    assert.equal(await page.locator("[data-figure-preview] > button:visible").count(), 0);
});

browserTest("Document link titles, gestures and external confirmations", async (page) => {
    const project = join(root, "document-links");
    mkdirSync(join(project, "child"), { recursive: true });
    writeFileSync(
        join(project, "dooc.yaml"),
        `document:
  title: Linked handbook
  children:
    - document:
        title: Guide
        url: guide.md
    - document:
        title: Reference
        url: child/dooc.yaml
    - document:
        title: Website
        url: https://example.test/site?a=1&b=2
        icon: web.svg
    - document:
        title: Notes
        url: notes.txt
    - document:
        title: Guide shortcut
        url: /guide
    - document:
        title: First page
        url: redirect:first
        children:
          - document:
              title: First child
              url: first.md
`,
    );
    writeFileSync(join(project, "guide.md"), "Guide body.\n");
    writeFileSync(join(project, "notes.txt"), "A local file preview.\n");
    writeFileSync(join(project, "first.md"), "First child body.\n");
    writeFileSync(
        join(project, "child/dooc.yaml"),
        "document:\n  title: Reference\n  url: guide.md\n",
    );
    writeFileSync(join(project, "child/guide.md"), "Child guide.\n");
    writeFileSync(
        join(project, "web.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/></svg>',
    );
    await page.context().route("https://example.test/**", (route) =>
        route.fulfill({
            contentType: "text/html",
            body: "<h1>External website</h1>",
        }),
    );
    const website = () => page.locator("#nav-groups a").filter({ hasText: /^Website$/ });
    const confirm = () => page.getByRole("dialog", { name: "Open externally?" });
    const jump = async (action) => {
        const popup = page.context().waitForEvent("page");
        await action();
        const tab = await popup;
        await tab.waitForURL("https://example.test/site?a=1&b=2");
        assert.equal(await tab.evaluate(() => window.opener), null);
        await tab.close();
    };
    for (const product of ["editor", "reader"]) {
        const url = await start(product, "node", project);
        await page.goto(url);
        await website().waitFor();
        assert.equal(await page.locator(".document-kind").count(), 0);
        for (const selector of ["#nav-groups a", "main .idx a"])
            for (const [title, linked] of [
                ["Website", true],
                ["Reference", true],
                ["Guide shortcut", true],
                ["First page", true],
                ["Guide", false],
                ["Notes", false],
            ]) {
                const label = page
                    .locator(selector)
                    .filter({ hasText: new RegExp(`^${title}$`) })
                    .locator(".nav-label, .document-card-label");
                assert.equal(
                    await label.evaluate((element) =>
                        getComputedStyle(element).textDecorationLine.includes("underline"),
                    ),
                    linked,
                    `${selector}: ${title}`,
                );
            }
        const linkColor = await website()
            .locator(".nav-label")
            .evaluate((element) => getComputedStyle(element).color);
        const pageColor = await page
            .locator("#nav-groups a")
            .filter({ hasText: /^Guide$/ })
            .locator(".nav-label")
            .evaluate((element) => getComputedStyle(element).color);
        assert.notEqual(linkColor, pageColor);
        const address = page.url();
        await jump(() => website().click({ button: "middle" }));
        await jump(() => website().click({ modifiers: ["Control"] }));
        await jump(() => website().click({ modifiers: ["Meta"] }));
        assert.equal(page.url(), address);
        await website().click();
        await page
            .frameLocator("iframe.document-web-frame")
            .getByRole("heading", { name: "External website" })
            .waitFor();
        assert.match(new URL(page.url()).pathname, /\/Website$/);
        const iconRow = website().locator("..");
        const customIcon = iconRow.locator(".doc-icon-frame img");
        assert.equal(
            await customIcon.evaluate((element) => getComputedStyle(element).visibility),
            "visible",
            "Selecting a page preserves its original SVG image",
        );
        assert.equal(await iconRow.locator(".document-kind").count(), 0);
        assert.equal(
            await page.locator(".document-web-frame").getAttribute("sandbox"),
            "allow-scripts allow-forms allow-popups",
        );
        await page.locator(".document-web-frame").dispatchEvent("error");
        await confirm().waitFor();
        await confirm().getByRole("button", { name: "Cancel", exact: true }).click();
        assert.match(new URL(page.url()).pathname, /\/Website$/);
        await page.locator("[data-web-open]").click();
        await jump(() =>
            confirm().getByRole("button", { name: "Open externally", exact: true }).click(),
        );
        await page.locator("#site-title").click();
        await page.waitForURL((current) => current.pathname === new URL(url).pathname);
        await page
            .locator("#nav-groups a")
            .filter({ hasText: /^Notes$/ })
            .click();
        await page.getByText("A local file preview.", { exact: true }).waitFor();
        await page.locator("#site-title").click();
        await page.waitForURL((current) => current.pathname === new URL(url).pathname);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() => document.body.classList.remove("sidebar-closed"));
        const mobileAddress = page.url();
        await website().click();
        await confirm().waitFor();
        assert.equal(await page.locator(".document-web-frame").count(), 0);
        await confirm().getByRole("button", { name: "Cancel", exact: true }).click();
        assert.equal(page.url(), mobileAddress);
        await website().click();
        await jump(() =>
            confirm().getByRole("button", { name: "Open externally", exact: true }).click(),
        );
        assert.equal(page.url(), mobileAddress);
        await page.setViewportSize({ width: 1440, height: 1000 });
    }
    for (const mode of ["static", "network"]) {
        const result = await buildBundle(project, {
            format: "html",
            urlPreview: mode === "network" ? "network" : "embed",
        });
        const file = join(root, `links-${mode}.html`);
        writeFileSync(file, result.data);
        await page.goto(pathToFileURL(file).href);
        await website().click();
        if (mode === "static") {
            await confirm().waitFor();
            assert.equal(await page.locator(".document-web-frame").count(), 0);
            await jump(() =>
                confirm().getByRole("button", { name: "Open externally", exact: true }).click(),
            );
        } else {
            await page
                .frameLocator("iframe.document-web-frame")
                .getByRole("heading", { name: "External website" })
                .waitFor();
            assert.equal(new URL(page.url()).hash, "#/Website");
            await jump(() => website().click({ button: "middle" }));
        }
    }
});

for (const width of [1440, 820, 390]) {
    browserTest(`UI consistency at ${width}px`, async (page) => {
        await page.setViewportSize({ width, height: 1000 });
        await open(page, urls.editor);
        await inject(page, "ui-consistency");
        await page.evaluate(() => window.testUiConsistency());
    });
}

for (const [file, name] of [
    ["line-wrapping", "testLineWrapping"],
    ["nav-create", "testNavCreate"],
    ["nav-rename", "testNavRename"],
]) {
    browserTest(name, async (page) => {
        await open(page, urls.editor);
        await inject(page, file);
        await page.evaluate((name) => window[name](), name);
    });
}

for (const check of [testDocumentVersionLayout, testDocumentVersionDrafts]) {
    browserTest(check.name, async (page) => {
        await open(page, urls.editor);
        await check(page);
    });
}
for (const latest of [false, true]) {
    browserTest(`Reader versions (${latest ? "latest" : "all"})`, async (page) => {
        await open(page, latest ? urls.latest : urls.reader, false);
        await testDocumentVersionReader(page, latest);
    });
}

for (const product of ["editor", "reader"]) {
    browserTest(`Section versions (${product})`, async (page) => {
        const project = join(root, `section-${product}`);
        mkdirSync(join(project, "child"), { recursive: true });
        writeFileSync(
            join(project, "dooc.yaml"),
            "version: { major: 1, minor: 0, patch: 0 }\ndocument:\n  title: Parent\n  url: parent.md\n  children:\n    - document: { url: child/dooc.yaml }\n",
        );
        writeFileSync(join(project, "parent.md"), "Parent content.\n");
        writeFileSync(
            join(project, "child/dooc.yaml"),
            "version: { major: 4, minor: 0, patch: git }\ndocument: { title: Child, url: guide.md }\n",
        );
        writeFileSync(join(project, "child/guide.md"), "Old child content.\n");
        const git = (...args) => execFileSync("git", ["-C", project, ...args], { stdio: "pipe" });
        git("init", "-b", "main");
        git("config", "user.name", "Test");
        git("config", "user.email", "test@example.com");
        git("add", ".");
        git("commit", "-m", "Initial");
        writeFileSync(join(project, "child/guide.md"), "New child content.\n");
        git("add", ".");
        git("commit", "-m", "Update child");
        const url = await start(
            product,
            "node",
            project,
            product === "reader" ? ["--versions", "*"] : [],
        );
        await open(page, url, product === "editor");
        await page.waitForFunction(
            () => document.querySelector("#document-version-select")?.value === "1.0.0",
        );
        await page.locator('#nav-groups a[href*="/child"]').click();
        await page.waitForFunction(
            () => document.querySelector("#document-version-select")?.value === "4.0.1",
        );
        if (product === "editor") await testDocumentVersionDrafts(page);
        else {
            await testDocumentVersionReader(page, false);
            assert.equal(new URL(page.url()).searchParams.get("manifest"), "child/dooc.yaml");
            assert.match(await page.locator("main").innerText(), /Old child content/);
        }
    });
}

for (const [file, names] of [
    ["code-editing", ["testCodeEditing"]],
    ["subformat-form", ["testSubformatForm", "testReferencedEnumForm", "testSubformatDatePicker"]],
    ["subformat-cards", ["testSubformatCards"]],
    ["subformat-embeds", ["testSubformatEmbeds", "testSubformatEmbedEditor"]],
    ["schema-builder", ["testSchemaBuilder", "testSchemaDraftSaving", "testSchemaParameters"]],
    ["nav-update", ["testNavUpdate"]],
    ["plugin-editing", ["testPluginEditing"]],
    ["resource-download", ["testResourceDownloads", "testDownloadBlock"]],
    ["view-loading", ["testViewLoading"]],
]) {
    for (const name of names) {
        browserTest(name, async (page) => {
            await blank(page, file === "subformat-cards" ? "reader" : "editor");
            await inject(page, file);
            await page.evaluate((name) => window[name](), name);
        });
    }
}

for (const width of [1440, 390]) {
    browserTest(`Subformat embed layout at ${width}px`, async (page) => {
        await page.setViewportSize({ width, height: 1000 });
        await blank(page, "reader");
        await inject(page, "subformat-embeds");
        await page.evaluate(() => window.testSubformatEmbedLayout());
    });
}

for (const mode of ["editor", "reader"]) {
    browserTest(`Subformat schema page in ${mode}`, async (page) => {
        await open(page, urls[mode], mode === "editor");
        const board = await page
            .locator("#nav-groups a")
            .filter({ hasText: /^Tasks$/ })
            .getAttribute("href");
        assert(board, "The task board has a navigation URL");
        await page.goto(new URL(board, page.url()).href);
        await page.getByRole("link", { name: "JSON Schema", exact: true }).waitFor();
        assert.deepEqual(await page.locator("main h1:visible").allTextContents(), []);
        await page.getByRole("link", { name: "JSON Schema", exact: true }).click();
        await page.locator(".json-schema").waitFor();
        assert(
            page.url().includes("/_files/schema/task"),
            "The URL identifies the type, not its file",
        );
        await page.reload();
        await page.locator(".json-schema").waitFor();
        assert.equal(await page.locator(".json-schema-page .err").count(), 0);
        assert.match(
            await page.locator(".json-schema summary").filter({ hasText: /^id\b/ }).textContent(),
            /string.*Required/,
        );
        const review = page.locator(".json-schema summary").filter({ hasText: /^review\b/ });
        await review.focus();
        await page.keyboard.press("Enter");
        assert(
            await review.evaluate((summary) => summary.parentElement.open),
            "Nested fields expand with the keyboard",
        );
        const reference = page.locator(".json-schema summary").filter({ hasText: /^project\b/ });
        await reference.click();
        const definition = reference
            .locator("..")
            .locator("summary")
            .filter({ hasText: /^\$ref\b/ });
        await definition.click();
        assert.match(await definition.locator("..").textContent(), /Project-relative path/);
        for (const width of [1440, 820, 390]) {
            await page.setViewportSize({ width, height: 1000 });
            assert(
                await page
                    .locator(".json-schema-page")
                    .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
                `The schema fits at ${width}px`,
            );
        }
        if (mode === "editor") {
            await page.setViewportSize({ width: 1440, height: 1000 });
            await page.locator(".json-schema-page [data-resource-source]").click();
            await page.waitForSelector("#file-editor .schema-builder");
            await page.locator(".file-editor-heading .schema-mode-switch").click();
            await page.waitForSelector("#file-editor .cm-content");
            assert.match(
                await page.locator(".file-editor-title").textContent(),
                /task\.schema\.json/,
            );
        }
    });
}

browserTest("Sidebar collapse", async (page) => {
    await open(page, urls.reader, false);
    await inject(page, "sidebar-collapse");
    await page.evaluate(() => window.testSidebarCollapse());
});

browserTest("Browser workspace persistence, themes and branches", async (page) => {
    await testBrowserWorkspace(page, urls.web);
});

browserTest("Socket workspace branches and unavailable workspaces", async (page) => {
    const project = join(root, "branches");
    createDevWorkspace(project);
    const git = (...args) =>
        execFileSync("git", ["-C", project, ...args], {
            env: Object.fromEntries(
                Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
            ),
            stdio: "pipe",
        });
    git("branch", "feature", "example");
    git("switch", "-c", "unavailable");
    git("rm", "dooc.yaml");
    git("commit", "-m", "Remove workspace manifest");
    git("switch", "main");
    await testSocketWorkspace(page, await start("editor", "node", project));
    await testUnavailableWorkspaceBranch(page, "unavailable");
});

browserTest("Browser extension storage", async (page) => {
    const file = join(root, "sample-extension.zip");
    execFileSync(process.execPath, ["--import", "tsx", "scripts/build/sample-extension.mjs", file]);
    await blank(page);
    await inject(page, "extensions");
    await page.evaluate(
        (data) =>
            window.testExtensionStorage(
                new File(
                    [Uint8Array.from(atob(data), (character) => character.charCodeAt(0))],
                    "sample-extension.zip",
                ),
            ),
        readFileSync(file).toString("base64"),
    );
});

browserTest(
    "Development editor and reader share saved content and mounted navigation",
    async (page) => {
        const project = join(root, "development");
        mkdirSync(project);
        writeFileSync(
            join(project, "dooc.yaml"),
            `system:
  default_lang: eng
document:
  title: Development
  url: guide.md
  children:
    - document:
        title: Details
        url: details.md
`,
        );
        const source = join(project, "guide.md");
        writeFileSync(source, "Shared development document.\n");
        writeFileSync(join(project, "details.md"), "Development details.\n");
        const editorUrl = await start("editor", "node", project, ["--mcp"], true);
        const readerUrl = await start("reader", "node", project, ["--mcp"], true);
        const readerApplication = applications.at(-1);
        assert.notEqual(new URL(editorUrl).port, new URL(readerUrl).port);
        const reader = await page.context().newPage();
        const errors = [];
        reader.on("pageerror", (error) => errors.push(error.message));
        await open(page, editorUrl);
        await open(reader, readerUrl, false);
        assert.equal(await reader.locator("#cm").count(), 0);
        const editor = page.locator("#cm .cm-content");
        await editor.focus();
        await page.keyboard.press("Control+End");
        await page.keyboard.insertText("\nShared saved edit.");
        await page.locator("#save").click();
        await page.waitForFunction(() => document.getElementById("save").dataset.state === "saved");
        await reader.waitForFunction(() =>
            document.querySelector("main article")?.textContent.includes("Shared saved edit."),
        );
        assert(readFileSync(source, "utf8").includes("Shared saved edit."));
        await reader.locator(".nav-row a", { hasText: "Details" }).click();
        await reader.waitForFunction(() =>
            document.querySelector("main article")?.textContent.includes("Development details."),
        );
        assert.equal(new URL(reader.url()).pathname, "/client/details");
        await reader.locator("#site-title").click();
        await reader.waitForURL((url) => url.pathname === "/client/");
        await reader.locator('#site-title[aria-current="page"]').waitFor();
        writeFileSync(source, "Updated from the shared development source.\n");
        for (const current of [page, reader])
            await current.waitForFunction(() =>
                document
                    .querySelector("main article")
                    ?.textContent.includes("Updated from the shared development source."),
            );
        assert(
            (await editor.textContent()).includes("Updated from the shared development source."),
        );
        assert.deepEqual(errors, []);
        await reader.close();
        await readerApplication.close();
        assert.equal((await fetch(editorUrl)).status, 200);
    },
);

for (const dirty of [false, true]) {
    browserTest(
        `Manifest hot reload preserves ${dirty ? "unsaved" : "saved"} content`,
        async (page) => {
            const project = join(root, dirty ? "hmr-dirty" : "hmr-clean");
            mkdirSync(join(project, "contents/md"), { recursive: true });
            const manifest = join(project, "dooc.yaml");
            const source = join(project, "contents/md/guide.md");
            const writeManifest = (title, extra = false) =>
                writeFileSync(
                    manifest,
                    `system:\n  default_lang: eng\ndocument:\n  sidebar:\n    title: {eng: Test site}\n  children:\n    - document:\n        url: contents/md/guide.md\n        title: ${title}\n${extra ? "    - document:\n        url: contents/md/extra.md\n        title: Extra page\n" : ""}`,
                );
            writeManifest("Old title");
            writeFileSync(source, "Original body.\n");
            writeFileSync(join(project, "contents/md/extra.md"), "Extra body.\n");
            const url = await start("editor", "node", project);
            await open(page, new URL("guide", url).href);
            await page.evaluate(() => {
                const autosave = document.getElementById("opt-autosave");
                autosave.checked = false;
                autosave.dispatchEvent(new Event("change"));
                window.hmrDocument = document;
            });
            const editor = page.locator("#cm .cm-content");
            if (dirty) {
                await editor.focus();
                await page.keyboard.press("Control+End");
                await page.keyboard.insertText("\nUnsaved paragraph.");
                await page.keyboard.press("Shift+Home");
            }
            const content = await editor.textContent();
            const selection = await page.evaluate(() => getSelection().toString());
            writeManifest("New title", true);
            await page.waitForFunction(() => document.title === "New title — Test site");
            await page.waitForFunction(() =>
                document.querySelector("#nav-docs")?.textContent.includes("Extra page"),
            );
            assert.equal(await editor.textContent(), content);
            assert.equal(await page.evaluate(() => getSelection().toString()), selection);
            assert.equal(await page.evaluate(() => window.hmrDocument === document), true);
            assert.equal(
                await page.locator("#nav-docs a.cur .nav-label").textContent(),
                "New title",
            );
            assert.equal(await page.locator("main h1").count(), 0);
            assert.equal(readFileSync(source, "utf8"), "Original body.\n");
            if (dirty) {
                await page.keyboard.press("Control+z");
                assert(!(await editor.textContent()).includes("Unsaved paragraph."));
                await page.keyboard.press("Control+Shift+z");
                assert((await editor.textContent()).includes("Unsaved paragraph."));
            } else {
                await editor.focus();
                await page.keyboard.press("Control+End");
                await page.keyboard.insertText("\nSaved paragraph.");
            }
            await page.locator("#save").click();
            await page.waitForFunction(
                () => document.getElementById("save").dataset.state === "saved",
            );
            assert(
                readFileSync(source, "utf8").includes(
                    dirty ? "Unsaved paragraph." : "Saved paragraph.",
                ),
            );
            assert(readFileSync(manifest, "utf8").includes("title: New title"));
            assert(!readFileSync(manifest, "utf8").includes("title: Old title"));
        },
    );
}
