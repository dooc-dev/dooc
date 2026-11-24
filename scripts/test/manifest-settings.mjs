import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export async function testManifestSettings(page, url, project) {
    const file = join(project, "dooc.yaml");
    const original = readFileSync(file, "utf8");
    const libraryPath = "contents/ts/manifest-library-example.ts";
    const libraryFile = join(project, libraryPath);
    const completionPrefix = "contents/manifest-completion-test/";
    const completionDirectory = join(project, completionPrefix);
    mkdirSync(join(libraryFile, ".."), { recursive: true });
    writeFileSync(libraryFile, "const manifestLibraryExample = 42;\n");
    for (let i = 0; i < 40; i++) {
        const directory = join(completionDirectory, `folder-${String(i).padStart(2, "0")}`);
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "entry.txt"), "Completion fixture\n");
    }
    writeFileSync(file, `# Preserve this comment\n${original}`);
    const host = page.locator("#manifest-manager");
    const title = host.locator('[name="document.title"]');
    const path = host.locator('[name="system.library.files"]').first();
    const yaml = host.locator(".cm-content");
    const source = async () => (await yaml.locator(".cm-line").allTextContents()).join("\n");
    const replaceSource = async (value) => {
        await yaml.focus();
        await page.keyboard.press("ControlOrMeta+a");
        await page.keyboard.insertText(value);
    };
    try {
        await page.goto(url);
        await page.waitForSelector("#cm .cm-content");
        assert.equal(
            new URL(await page.locator(".nav-tool-cards a").first().getAttribute("href"), url)
                .pathname,
            new URL("_manifest", url).pathname,
        );
        await page.locator("#nav-manifest a").click();
        await title.waitFor();
        const icon = host.locator('details[data-path="document.icon"]');
        const library = host.locator('details[data-path="system.library"]');
        const libraryPaths = library.locator(".manifest-paths");
        const light = icon.locator('[name="document.icon.light"]');
        assert.equal(await light.isVisible(), false);
        await icon.locator(":scope > summary").click();
        assert.equal(await light.isVisible(), true);
        assert.equal(await title.locator("..").locator("span").textContent(), "title");
        await path.fill("contents/ts/manifest-");
        await host.getByRole("option", { name: libraryPath, exact: true }).waitFor();
        await path.press("ArrowDown");
        await path.press("Enter");
        assert.equal(await path.inputValue(), libraryPath);
        await testManifestPathMenu(page, host, completionPrefix);
        await libraryPaths.getByRole("button", { name: "Add file", exact: true }).click();
        const extraPath = libraryPaths.locator("input").nth(1);
        await extraPath.fill("contents/ts/temporary.ts");
        await libraryPaths
            .getByRole("button", { name: /^Remove path:/ })
            .nth(1)
            .click();
        assert.equal(await libraryPaths.locator("input").count(), 1);
        await library.locator(":scope > summary").focus();
        await page.keyboard.press("Space");
        assert.equal(await path.isVisible(), false);
        await title.fill("true");
        await host.getByRole("tab", { name: "YAML", exact: true }).click();
        assert.equal(parse(await source()).document.title, "true");
        assert.deepEqual(parse(await source()).system.library.files, [libraryPath]);
        await host.getByRole("tab", { name: "Settings", exact: true }).click();
        assert.equal(await title.inputValue(), "true");
        assert.equal(await light.isVisible(), true);
        assert.equal(await path.isVisible(), false);
        await library.locator(":scope > summary").click();
        assert.equal(await path.inputValue(), libraryPath);
        await title.press("ControlOrMeta+s");
        await page.waitForFunction(
            () => document.querySelector("#manifest-manager")?.dataset.dirty === "false",
        );
        const saved = readFileSync(file, "utf8");
        assert(saved.includes("# Preserve this comment"));
        assert.equal(parse(saved).document.sidebar?.icon, undefined);
        assert.deepEqual(
            parse(saved).document.icon,
            parse(original).document.icon ?? parse(original).document.sidebar?.icon,
        );
        assert.deepEqual(parse(saved).system.library.files, [libraryPath]);
        await page.locator("#nav-library a").click();
        await page.waitForFunction(() =>
            [...document.querySelectorAll(".resource-item")].some((item) =>
                item.textContent.includes("manifestLibraryExample"),
            ),
        );
        await page.locator("#nav-manifest a").click();
        await title.waitFor();
        await host.getByRole("tab", { name: "YAML", exact: true }).click();
        await replaceSource("document: [");
        await host.getByRole("button", { name: "Save", exact: true }).click();
        await host.getByRole("alert").waitFor();
        assert.equal(readFileSync(file, "utf8"), saved);
        await host.getByRole("tab", { name: "Settings", exact: true }).click();
        assert.equal(
            await host
                .getByRole("tab", { name: "YAML", exact: true })
                .getAttribute("aria-selected"),
            "true",
        );
        await page.locator("#nav-files a").click();
        await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
        assert.equal(await source(), "document: [");
        await replaceSource(saved);
        await host.getByRole("tab", { name: "Settings", exact: true }).click();
        await title.fill("Local draft");
        const external = saved.replace(/title: ["']?true["']?/, "title: External edit");
        assert.notEqual(external, saved);
        writeFileSync(file, external);
        await host.getByRole("button", { name: "Save", exact: true }).click();
        await page.waitForFunction(() =>
            document
                .querySelector("#manifest-manager [role=alert]")
                ?.textContent.includes("changed externally"),
        );
        assert.equal(readFileSync(file, "utf8"), external);
        assert.equal(await title.inputValue(), "Local draft");
        await host.getByRole("button", { name: "Reload", exact: true }).click();
        await page.getByRole("dialog").getByRole("button", { name: "Reload", exact: true }).click();
        await page.waitForFunction(
            () => document.querySelector('[name="document.title"]')?.value === "External edit",
        );
        await page.reload();
        await title.waitFor();
        assert.equal(await path.inputValue(), libraryPath);
    } finally {
        writeFileSync(file, original);
        rmSync(libraryFile, { force: true });
        rmSync(completionDirectory, { recursive: true, force: true });
    }
}

async function testManifestPathMenu(page, host, prefix) {
    const popup = host.locator(".manifest-completions");
    const options = popup.getByRole("option");
    const start = host.locator('[name="document.url"]');
    const skills = host.locator('[name="system.skills"]').first();
    const startValue = await start.inputValue();
    const skillsValue = await skills.inputValue();
    const layout = async (input, above) => {
        await popup.waitFor();
        const anchor = await input.boundingBox();
        const menu = await popup.boundingBox();
        const viewport = page.viewportSize();
        assert(Math.abs(menu.x - anchor.x) <= 1);
        assert(Math.abs(menu.width - anchor.width) <= 1);
        assert(menu.height <= 240 && menu.y >= 8 && menu.y + menu.height <= viewport.height - 8);
        assert(
            Math.abs(
                above ? anchor.y - menu.y - menu.height - 4 : menu.y - anchor.y - anchor.height - 4,
            ) <= 1,
        );
        assert(
            await popup
                .locator(".language-options")
                .evaluate((list) => list.scrollHeight > list.clientHeight),
        );
    };
    await start.scrollIntoViewIfNeeded();
    await start.fill(prefix);
    await layout(start, false);
    await start.press("Escape");
    assert.equal(await popup.isVisible(), false);
    assert.equal(await start.inputValue(), prefix);
    await start.fill(startValue);
    await skills.scrollIntoViewIfNeeded();
    await skills.fill(prefix);
    await layout(skills, true);
    assert.equal(await start.getAttribute("aria-expanded"), "false");
    await skills.press("ArrowDown");
    await skills.press("ArrowUp");
    const last = await options.last().textContent();
    assert.equal(
        await skills.getAttribute("aria-activedescendant"),
        await options.last().getAttribute("id"),
    );
    assert(await popup.locator(".language-options").evaluate((list) => list.scrollTop > 0));
    await skills.press("Enter");
    assert.equal(await skills.inputValue(), last);
    await popup.getByRole("option", { name: `${last}entry.txt`, exact: true }).click();
    assert.equal(await skills.inputValue(), `${last}entry.txt`);
    assert.equal(await skills.evaluate((input) => input === document.activeElement), true);
    assert.equal(await popup.isVisible(), false);
    await skills.fill(prefix);
    await popup.waitFor();
    await skills.press("Tab");
    assert.equal(await popup.isVisible(), false);
    await skills.fill(prefix);
    await popup.waitFor();
    await host.locator("h1").click();
    assert.equal(await popup.isVisible(), false);
    await skills.fill(prefix);
    await popup.waitFor();
    await start.evaluate((input) => input.scrollIntoView({ block: "start" }));
    await popup.waitFor({ state: "hidden" });
    await skills.fill(skillsValue);
    await start.click();
}

export async function testEmptyManifestSettings(page, url, file) {
    await page.goto(url);
    await page.locator("#nav-manifest a").click();
    const host = page.locator("#manifest-manager");
    const title = host.locator('[name="document.title"]');
    await title.fill("Updated empty workspace");
    await title.press("ControlOrMeta+s");
    await page.waitForFunction(
        () => document.querySelector("#manifest-manager")?.dataset.dirty === "false",
    );
    assert.equal(parse(readFileSync(file, "utf8")).document.title, "Updated empty workspace");
    await page.reload();
    await title.waitFor();
    assert.equal(await title.inputValue(), "Updated empty workspace");
    await host.getByRole("tab", { name: "YAML", exact: true }).click();
    await host.locator(".cm-content").waitFor();
    assert.equal(await page.locator("#boot").count(), 0);
}
