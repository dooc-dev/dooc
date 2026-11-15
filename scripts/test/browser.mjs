import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { parseApplicationOptions, runApplication } from "../../dist/server/application.js";
import { createDevWorkspace } from "../dev-workspace.ts";
import {
    testDocumentVersionDrafts,
    testDocumentVersionLayout,
    testDocumentVersionViewer,
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

async function start(product, runtime, project, extra = []) {
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
    applications.push(await runApplication(options));
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
        urls.viewer = await start("viewer", "node", project, ["--versions", "*"]);
        urls.latest = await start("viewer", "node", project);
        urls.web = await start("editor", "web", project);
        browser = await chromium.launch();
        const page = await browser.newPage();
        try {
            for (const mode of ["editor", "viewer"]) {
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
    browserTest(`Viewer versions (${latest ? "latest" : "all"})`, async (page) => {
        await open(page, latest ? urls.latest : urls.viewer, false);
        await testDocumentVersionViewer(page, latest);
    });
}

for (const [file, names] of [
    ["code-editing", ["testCodeEditing"]],
    ["subformat-form", ["testSubformatForm", "testReferencedEnumForm", "testSubformatDatePicker"]],
    ["subformat-cards", ["testSubformatCards"]],
    ["schema-builder", ["testSchemaBuilder", "testSchemaDraftSaving", "testSchemaParameters"]],
    ["nav-update", ["testNavUpdate"]],
    ["plugin-editing", ["testPluginEditing"]],
    ["resource-download", ["testResourceDownloads"]],
    ["view-loading", ["testViewLoading"]],
]) {
    for (const name of names) {
        browserTest(name, async (page) => {
            await blank(page, file === "subformat-cards" ? "viewer" : "editor");
            await inject(page, file);
            await page.evaluate((name) => window[name](), name);
        });
    }
}

browserTest("Sidebar collapse", async (page) => {
    await open(page, urls.viewer, false);
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
