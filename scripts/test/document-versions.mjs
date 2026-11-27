import assert from "node:assert/strict";
import { build } from "esbuild";

async function choose(page, id, value) {
    await page.locator(`#${id}`).locator("..").locator("input").click();
    await page.locator(`#${id}-picker button`).evaluateAll((buttons, value) => {
        const option = buttons.find((button) => button.dataset.value === value);
        if (!option) throw new Error(`Missing picker option: ${value}`);
        option.click();
    }, value);
}

export async function testDocumentVersionLayout(page) {
    const select = page.locator("#document-version-select");
    await select.locator("option").nth(1).waitFor({ state: "attached" });
    if (await page.locator("body.sidebar-closed").count()) {
        await page.locator("#sidebar-toggle").click();
    }
    const input = select.locator("..").locator("input");
    await input.waitFor({ state: "visible" });
    const check = await input.evaluate((input) => {
        const footer = document.getElementById("document-versions");
        const tools = document.getElementById("nav-tools");
        const status = input.parentElement.querySelector(":scope > .version-status");
        const label = input.closest(".subformat-control").querySelector(".subformat-control-label");
        const box = input.getBoundingClientRect();
        const labelBox = label.getBoundingClientRect();
        return {
            border: getComputedStyle(input).borderTopWidth,
            borderColor: getComputedStyle(input).borderTopColor,
            label: label.textContent,
            floatingLabel:
                labelBox.width > 0 && labelBox.top < box.top && labelBox.bottom > box.top,
            divider: getComputedStyle(footer).borderTopWidth,
            aboveTools:
                !tools ||
                footer.getBoundingClientRect().bottom <= tools.getBoundingClientRect().top,
            number: input.value,
            status: status.textContent,
            statusRight: status.getBoundingClientRect().left > input.getBoundingClientRect().left,
        };
    });
    assert.equal(check.border, "1px");
    assert.equal(check.label, "version");
    assert.equal(check.floatingLabel, true);
    assert.equal(check.divider, "0px");
    assert.equal(check.aboveTools, true);
    assert.match(check.number, /^\d+\.\d+\.\d+$/);
    assert.equal(check.status, "latest");
    assert.equal(check.statusRight, true);
    await input.focus();
    assert.deepEqual(
        await input.evaluate((input) => {
            const style = getComputedStyle(input);
            return [style.borderTopWidth, style.borderTopColor, style.outlineStyle];
        }),
        ["1px", check.borderColor, "none"],
    );
    assert.equal(
        await page.evaluate(async () => {
            const footer = document.getElementById("document-versions");
            await window.__docsRefreshNav?.();
            return document.getElementById("document-versions") === footer;
        }),
        true,
    );
    await input.press("ArrowDown");
    const latest = page.locator("#document-version-select-picker button").first();
    assert.equal(await latest.locator("span").first().textContent(), check.number);
    assert.equal(await latest.locator(".version-status").textContent(), "latest");
    await input.press("Escape");
    for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        if (!(await page.locator("body.sidebar-closed").count()))
            await page.locator("#sidebar-toggle").click();
        await page.waitForFunction(() => document.getElementById("sidebar").clientWidth <= 52);
        const compact = await input.evaluate((input) => {
            const wrapper = input.parentElement;
            const status = wrapper.querySelector(":scope > .version-status");
            const label = input
                .closest(".subformat-control")
                .querySelector(".subformat-control-label");
            const sidebar = document.getElementById("sidebar").getBoundingClientRect();
            const box = input.getBoundingClientRect();
            const badge = status.getBoundingClientRect();
            return {
                visible: input.checkVisibility(),
                labelAbove: label.getBoundingClientRect().bottom <= box.top,
                statusBelow: badge.top > box.top + 18 && badge.bottom < box.bottom,
                centered: Math.abs((badge.left + badge.right) / 2 - (box.left + box.right) / 2) < 1,
                fits: box.left >= sidebar.left && box.right <= sidebar.right,
                value: input.value,
                title: input.title,
            };
        });
        assert.equal(compact.visible, true);
        assert.equal(compact.labelAbove, true);
        assert.equal(compact.statusBelow, true);
        assert.equal(compact.centered, true);
        assert.equal(compact.fits, true);
        assert.equal(compact.value, check.number);
        assert.match(compact.title, /latest/);
        await input.click();
        const bounds = await page.locator("#document-version-select-picker").boundingBox();
        assert(bounds && bounds.width >= 180 && bounds.x >= 0 && bounds.x + bounds.width <= width);
        assert.equal(await page.locator("body.sidebar-closed").count(), 1);
        await input.press("Escape");
    }
}

/** Run against an editor fixture with at least two committed document versions. */
export async function testDocumentVersionDrafts(page) {
    const bundle = await build({
        stdin: {
            contents: `import { EditorView } from "@codemirror/view";
                window.testEditorDocument = () => EditorView.findFromDOM(
                    document.querySelector("#cm .cm-content")
                ).state.doc.toString();`,
            resolveDir: import.meta.dirname,
        },
        bundle: true,
        write: false,
        format: "iife",
    });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const source = () => page.evaluate(() => window.testEditorDocument());
    const versions = page.locator("#document-version-select");
    await versions.locator("option").nth(1).waitFor({ state: "attached" });
    const workspace = await page
        .locator('select[data-workspace-pane][data-active="true"]')
        .evaluate((select) => ({ id: select.id, value: select.value }));
    const previous = await versions.locator("option").last().getAttribute("value");
    const autosave = await page.locator("#opt-autosave").isChecked();
    await page.locator("#opt-autosave").evaluate((input) => {
        input.checked = false;
        input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const editor = page.locator("#cm .cm-content");
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.insertText("UNSAVED VERSION TEST");
    const draft = await source();
    assert.equal(await page.locator("#document-draft-select").count(), 0);
    await choose(page, "document-version-select", previous);
    await page.waitForFunction(() => document.body.dataset.versionReadOnly === "true");
    const old = await source();
    assert.doesNotMatch(old, /UNSAVED VERSION TEST/);
    await editor.click();
    await page.keyboard.insertText("FORBIDDEN");
    assert.equal(await source(), old);
    assert.equal(await page.locator("#document-draft-select").count(), 0);
    await choose(page, workspace.id, workspace.value);
    await page.waitForFunction(() => document.body.dataset.versionReadOnly === "false");
    assert.equal(await source(), draft);
    await editor.click();
    await page.keyboard.press("Control+z");
    assert.doesNotMatch(await source(), /UNSAVED VERSION TEST/);
    await page.locator("#opt-autosave").evaluate((input, checked) => {
        input.checked = checked;
        input.dispatchEvent(new Event("change", { bubbles: true }));
    }, autosave);
}

/** Run against a reader fixture; its publication setting determines whether the control exists. */
export async function testDocumentVersionReader(page, latestOnly) {
    const versions = page.locator("#document-version-select");
    await versions.locator("option").first().waitFor({ state: "attached" });
    if (latestOnly) {
        assert.equal(await page.locator("#document-versions").isVisible(), false);
        assert.equal(await versions.locator("option").count(), 1);
        return;
    }
    const previous = await versions.locator("option").last().getAttribute("value");
    await choose(page, "document-version-select", previous);
    await page.waitForFunction(
        (version) => new URL(location.href).searchParams.get("version") === version,
        previous,
    );
    await page.reload();
    await page.waitForFunction(
        (version) => document.querySelector("#document-version-select")?.value === version,
        previous,
    );
    const other = page.locator("#nav-groups a:not(.cur)").first();
    if (await other.count()) {
        await other.click();
        await page
            .locator("#document-version-select option")
            .first()
            .waitFor({ state: "attached" });
        assert.equal(new URL(page.url()).searchParams.get("version"), previous);
    }
}
