import assert from "node:assert/strict";

async function selectWorkspace(page, value, pane) {
    const select = page.locator(
        pane === undefined
            ? 'select[data-workspace-pane][data-active="true"]'
            : `select[data-workspace-pane=${JSON.stringify(pane)}]`,
    );
    const id = await select.getAttribute("id");
    const input = page.locator(`[id=${JSON.stringify(`${id}-input`)}]`);
    if ((await input.getAttribute("aria-expanded")) !== "true") await input.click();
    await page
        .locator(
            `[id=${JSON.stringify(`${id}-picker`)}] button[data-value=${JSON.stringify(value)}]`,
        )
        .click();
}

export async function testUnavailableWorkspaceBranch(page, branch) {
    const select = page.locator('select[data-workspace-pane][data-active="true"]');
    const option = select.locator(`option[data-branch=${JSON.stringify(branch)}]`);
    await option.waitFor({ state: "attached" });
    assert.equal(await option.evaluate((element) => element.disabled), true);
    const value = await option.getAttribute("value");
    const reason = await option.getAttribute("data-unavailable");
    assert.ok(reason);
    const before = await select.inputValue();
    const draft = await page.locator("#cm .cm-content").textContent();
    const id = await select.getAttribute("id");
    const input = page.locator(`[id=${JSON.stringify(`${id}-input`)}]`);
    await input.click();
    const popup = page.locator(`[id=${JSON.stringify(`${id}-picker`)}]`);
    const row = popup.locator(`button[data-value=${JSON.stringify(value)}]`);
    assert.equal(await row.getAttribute("aria-disabled"), "true");
    assert.equal(await row.getAttribute("aria-description"), reason);
    assert.equal(await row.getAttribute("title"), reason);
    assert.equal(await row.locator('svg[viewBox="0 0 20 20"]').count(), 1);
    assert.equal(
        await row.evaluate((element) => {
            const probe = document.createElement("span");
            probe.style.color = "light-dark(var(--c-danger), var(--doc-danger-2))";
            element.parentElement.append(probe);
            const matches = getComputedStyle(element).color === getComputedStyle(probe).color;
            probe.remove();
            return matches;
        }),
        true,
    );
    await row.hover();
    await row.click({ force: true });
    assert.equal(await select.inputValue(), before);
    assert.equal(await popup.evaluate((element) => element.matches(":popover-open")), true);
    const index = await row.evaluate((element) =>
        [...element.parentElement.children].indexOf(element),
    );
    await input.press("Home");
    for (let i = 0; i < index; i++) await input.press("ArrowDown");
    assert.equal(await input.getAttribute("aria-activedescendant"), await row.getAttribute("id"));
    await input.press("Enter");
    assert.equal(await select.inputValue(), before);
    assert.equal(await page.locator("#cm .cm-content").textContent(), draft);
    assert.equal(await popup.evaluate((element) => element.matches(":popover-open")), true);
    await input.press("Escape");
    return { branch, reason };
}

export async function testWorkspaceChooserTheme(page) {
    const original = await page.evaluate(() => ({
        editor: document.documentElement.getAttribute("data-editor-theme"),
        preview: document.documentElement.getAttribute("data-theme"),
        panes: [...document.querySelectorAll(".preview-pane")].map((pane) =>
            pane.getAttribute("data-theme"),
        ),
        scheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
        workspace: document.querySelector('select[data-workspace-pane][data-active="true"]').value,
        draft: document.querySelector("#cm .cm-content").textContent,
    }));
    const results = [];
    try {
        for (const { editor, preview, os } of [
            { editor: "dark", preview: "light", os: "light" },
            { editor: "light", preview: "dark", os: "dark" },
            { editor: "auto", preview: "light", os: "dark" },
            { editor: "auto", preview: "dark", os: "light" },
        ]) {
            await page.emulateMedia({ colorScheme: os });
            await page.evaluate(
                ({ editor, preview }) => {
                    document.documentElement.dataset.editorTheme = editor;
                    document.documentElement.dataset.theme = preview;
                    for (const pane of document.querySelectorAll(".preview-pane"))
                        pane.dataset.theme = preview;
                },
                { editor, preview },
            );
            await page.locator("#phead #editor-open-workspace").click();
            const chooser = page.locator(".workspace-dialog[open]");
            await chooser.waitFor();
            assert.equal(await chooser.count(), 1);
            await chooser.locator('select[name="mode"]').selectOption("new");
            const colors = await chooser.evaluate((dialog) => {
                const panel = document.getElementById("panel");
                const probe = document.createElement("span");
                panel.append(probe);
                const token = (name) => {
                    probe.style.color = `var(${name})`;
                    return getComputedStyle(probe).color;
                };
                const background = token("--c-bg1");
                const foreground = token("--c-fg");
                const line = token("--c-line");
                const scheme = getComputedStyle(panel).colorScheme;
                const style = getComputedStyle(dialog);
                const controls = [
                    ...dialog.querySelectorAll(
                        'input[name="name"], select[name="mode"], button[name="cancel"]',
                    ),
                ];
                const submit = getComputedStyle(dialog.querySelector('button[type="submit"]'));
                const result = {
                    background: style.backgroundColor,
                    foreground: style.color,
                    scheme: style.colorScheme,
                    matchesPanel:
                        style.backgroundColor === background &&
                        style.color === foreground &&
                        style.colorScheme === scheme,
                    controlsMatch: controls.every((element) => {
                        const value = getComputedStyle(element);
                        return (
                            value.backgroundColor === background &&
                            value.color === foreground &&
                            value.borderTopColor === line &&
                            value.colorScheme === scheme
                        );
                    }),
                    submitMatches:
                        submit.backgroundColor === foreground &&
                        submit.color === background &&
                        submit.colorScheme === scheme,
                };
                probe.remove();
                return result;
            });
            assert.equal(colors.matchesPanel, true);
            assert.equal(colors.controlsMatch, true);
            assert.equal(colors.submitMatches, true);
            assert.equal(colors.scheme, editor === "auto" ? os : editor);
            await chooser.getByRole("button", { name: "Cancel", exact: true }).click();
            await chooser.waitFor({ state: "detached" });
            assert.equal(await page.locator(".workspace-dialog").count(), 0);
            assert.equal(
                await page.locator('select[data-workspace-pane][data-active="true"]').inputValue(),
                original.workspace,
            );
            assert.equal(await page.locator("#cm .cm-content").textContent(), original.draft);
            results.push({ editor, preview, os, ...colors });
        }
    } finally {
        await page.emulateMedia({ colorScheme: original.scheme });
        await page.evaluate((original) => {
            for (const [name, value] of [
                ["data-editor-theme", original.editor],
                ["data-theme", original.preview],
            ]) {
                if (value === null) document.documentElement.removeAttribute(name);
                else document.documentElement.setAttribute(name, value);
            }
            [...document.querySelectorAll(".preview-pane")].forEach((pane, index) => {
                const value = original.panes[index];
                if (value === null) pane.removeAttribute("data-theme");
                else pane.setAttribute("data-theme", value);
            });
        }, original);
    }
    return results;
}

// Run against `dooc client` using an isolated Playwright context.
export async function testBrowserWorkspace(page, url) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.locator("select[name=mode]").selectOption("new");
    await page.locator("input[name=name]").fill("Browser fixture");
    await page.locator("summary").click();
    await page.locator("input[name=author]").fill("Test");
    await page.locator("input[name=email]").fill("test@example.com");
    await page.getByRole("button", { name: "Open workspace", exact: true }).click();
    await page.waitForSelector("#cm .cm-content", { timeout: 90_000 });
    await page.waitForFunction(() => !document.querySelector("dialog[open]"));
    await testWorkspaceChooserTheme(page);
    const editor = page.locator("#cm .cm-content");
    await editor.fill("# Browser saved\n\nDurable client-only edit.\n");
    await page.locator("#save").click();
    await page.waitForFunction(async () => {
        const saved = JSON.parse(localStorage.getItem("dooc.browser.workspaces"))[0];
        const root = await (
            await (await navigator.storage.getDirectory()).getDirectoryHandle("dooc")
        ).getDirectoryHandle(saved.id);
        const file = await (
            await (await root.getDirectoryHandle("content")).getFileHandle("welcome.md")
        ).getFile();
        return (await file.text()).includes("Durable client-only edit");
    });
    await page.waitForFunction(() => document.querySelector("#save")?.dataset.state === "saved");
    await page.reload();
    await page.locator("select[name=mode]").selectOption("saved");
    await page.getByRole("button", { name: "Open workspace", exact: true }).click();
    await page.waitForSelector("#cm .cm-content", { timeout: 90_000 });
    assert.match(await editor.innerText(), /Durable client-only edit/);
    await page.evaluate(async () => {
        const connection = window.__doocConnections.items.get(window.__doocConnections.active);
        let state = await connection.client.request("git", { action: "read" });
        for (const change of state.changes) {
            await connection.client.request("git", {
                action: "stage",
                path: change.path,
                version: state.version,
            });
            state = await connection.client.request("git", { action: "read" });
        }
        await connection.client.request("git", {
            action: "commit",
            message: "Initial browser commit",
            version: state.version,
        });
    });
    await page.locator("#split-preview").click();
    await page.waitForFunction(() => document.querySelectorAll(".preview-pane").length === 2);
    const first = page.locator(".preview-pane").nth(0),
        second = page.locator(".preview-pane").nth(1);
    const firstPane = await first.getAttribute("data-pane-id");
    const secondPane = await second.getAttribute("data-pane-id");
    const leftSelector = page.locator(`select[data-workspace-pane=${JSON.stringify(firstPane)}]`);
    const rightSelector = page.locator(`select[data-workspace-pane=${JSON.stringify(secondPane)}]`);
    assert.equal(await page.locator(".workspace-select").count(), 2);
    assert.equal(await page.locator(".workspace-picker").count(), 2);
    await first.click({ position: { x: 20, y: 90 } });
    await page.evaluate(() => {
        const toggle = document.getElementById("opt-autosave");
        if (toggle?.checked) toggle.click();
    });
    await editor.fill("# Unsaved left\n\nKeep branch main draft.\n");
    await second.click({ position: { x: 20, y: 90 } });
    await page.waitForFunction(
        () => !document.querySelector("#cm .cm-content")?.textContent.includes("Unsaved left"),
    );
    await first.click({ position: { x: 20, y: 90 } });
    await page.waitForFunction(() =>
        document.querySelector("#cm .cm-content")?.textContent.includes("Unsaved left"),
    );
    const originalMain = await first.getAttribute("data-workspace");
    await rightSelector.locator('option[data-create="true"]').waitFor({ state: "attached" });
    const createBranch = await rightSelector
        .locator('option[data-create="true"]')
        .getAttribute("value");
    await selectWorkspace(page, createBranch, secondPane);
    const branchDialog = page.locator(".app-dialog[open]");
    const createButton = branchDialog.getByRole("button", { name: "Create branch", exact: true });
    const branchName = branchDialog.getByRole("textbox", { name: "New branch", exact: true });
    assert.equal(await createButton.isDisabled(), true);
    await branchName.fill("   ");
    assert.equal(await createButton.isDisabled(), true);
    await branchDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await first.getAttribute("data-workspace"), originalMain);
    assert.equal(await second.getAttribute("data-workspace"), originalMain);
    assert.match(await editor.innerText(), /Unsaved left/);
    await selectWorkspace(page, createBranch, secondPane);
    await branchName.fill("cancelled-branch");
    await branchName.press("Escape");
    await branchDialog.waitFor({ state: "hidden" });
    assert.match(await editor.innerText(), /Unsaved left/);
    await selectWorkspace(page, createBranch, secondPane);
    await branchName.fill("feature");
    await branchName.press("Enter");
    await page.waitForFunction((pane) => {
        const select = document.querySelector(`select[data-workspace-pane="${pane}"]`);
        return (
            !select?.disabled &&
            select?.selectedOptions[0]?.textContent.includes("feature") &&
            select.dataset.active === "true"
        );
    }, secondPane);
    assert.equal(await first.getAttribute("data-workspace"), originalMain);
    assert.match(await editor.innerText(), /Durable client-only edit/);
    assert.doesNotMatch(await editor.innerText(), /Unsaved left/);
    await editor.fill("# Branch feature\n\nRight branch saved.\n");
    await page.locator("#save").click();
    await page.waitForFunction(() => document.querySelector("#save")?.dataset.state === "saved");
    await page.evaluate(async () => {
        const connection = window.__doocConnections.items.get(window.__doocConnections.active);
        const response = await connection.fetch("/api/textfile", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                action: "save",
                file: "added.txt",
                content: "New branch file\n",
                base: null,
            }),
        });
        if (!response.ok) throw new Error(await response.text());
    });
    await page.waitForFunction(
        () =>
            document.querySelector('select[data-workspace-pane][data-active="true"]')?.dataset
                .change === "added",
    );
    await first.click({ position: { x: 20, y: 90 } });
    await page.waitForFunction(() =>
        document.querySelector("#cm .cm-content")?.textContent.includes("Unsaved left"),
    );
    const selector = page.locator('select[data-workspace-pane][data-active="true"]');
    const pickerInput = page.locator('input.workspace-picker-input[data-active="true"]');
    assert.equal(await selector.count(), 1);
    assert.equal(await selector.isVisible(), false);
    assert.equal(await pickerInput.evaluate((input) => input.readOnly), true);
    assert.equal(await page.locator("#phead #editor-open-workspace").count(), 1);
    assert.equal(await page.locator(".pane-actions select").count(), 0);
    assert.equal(
        await first
            .locator(".pane-actions")
            .evaluate((element) => getComputedStyle(element).borderBottomWidth),
        "0px",
    );
    assert.match(await selector.locator("option:checked").innerText(), /main/);
    assert.match(await leftSelector.locator("option:checked").innerText(), /main/);
    assert.match(await rightSelector.locator("option:checked").innerText(), /feature/);
    assert.match(
        await page
            .locator(
                `input.workspace-picker-input[data-workspace-pane=${JSON.stringify(secondPane)}]`,
            )
            .getAttribute("title"),
        /feature/,
    );
    const originalLabel = await pickerInput.getAttribute("title");
    const longLabel = `main/${"documentation-workspace-".repeat(6)}`;
    await page.evaluate((label) => {
        const state = window.__doocConnections;
        state.items.get(state.active).label = label;
        document.dispatchEvent(
            new CustomEvent("dooc:select-workspace", {
                detail: { id: state.active, from: "not-current" },
            }),
        );
    }, longLabel);
    await page.waitForFunction(() =>
        document
            .querySelector('input.workspace-picker-input[data-active="true"]')
            ?.value.endsWith("..."),
    );
    assert.equal(await pickerInput.getAttribute("title"), longLabel);
    assert.equal(await selector.locator("option:checked").innerText(), longLabel);
    for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        const header = await pickerInput.evaluate((input) => {
            const root = input.closest("#phead");
            const select = root.querySelector('select[data-workspace-pane][data-active="true"]');
            const language = root.querySelector(".fm-language").getBoundingClientRect();
            const folder = root.querySelector("#editor-open-workspace").getBoundingClientRect();
            const saved = document.getElementById("save").getBoundingClientRect();
            const rect = root.querySelector("#editor-header-workspace").getBoundingClientRect();
            const bounds = root.getBoundingClientRect();
            const style = getComputedStyle(input);
            const arrow = getComputedStyle(input.closest(".workspace-select"), "::after");
            const color = document.createElement("span");
            color.style.color = `var(${({ added: "--c-ok", modified: "--c-accent", deleted: "--c-danger" })[select.dataset.change] ?? "--c-fg"})`;
            root.append(color);
            const expectedColor = getComputedStyle(color).color;
            color.remove();
            return {
                height: bounds.height,
                overflow: root.scrollWidth > root.clientWidth,
                sameRow: Math.abs(rect.top + rect.height / 2 - saved.top - saved.height / 2) < 1,
                ordered: language.right <= rect.left + 1 && rect.right <= folder.left + 1,
                left: language.left - bounds.left,
                right: bounds.right - folder.right,
                center: Math.abs(rect.left + rect.width / 2 - bounds.left - bounds.width / 2),
                statusColor: style.color === expectedColor,
                underlined: style.textDecorationLine.includes("underline"),
                inactivePlain: [
                    ...root.querySelectorAll('input.workspace-picker-input[data-active="false"]'),
                ].every(
                    (other) => !getComputedStyle(other).textDecorationLine.includes("underline"),
                ),
                borderless: style.borderWidth === "0px",
                transparent: style.backgroundColor === "rgba(0, 0, 0, 0)",
                arrowless: arrow.display === "none" || ["none", "normal"].includes(arrow.content),
            };
        });
        assert.equal(header.height, 36);
        assert.equal(header.overflow, false);
        assert.equal(header.sameRow, true);
        assert.equal(header.ordered, true);
        assert.ok(header.left >= 0 && header.left <= 12);
        assert.ok(header.right >= 0 && header.right <= 12);
        if (width === 1440) assert.ok(header.center <= 2);
        assert.equal(header.statusColor, true);
        assert.equal(header.underlined, true);
        assert.equal(header.inactivePlain, true);
        assert.equal(header.borderless, true);
        assert.equal(header.transparent, true);
        assert.equal(header.arrowless, true);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await pickerInput.hover();
    assert.equal(
        await pickerInput.evaluate((input) => getComputedStyle(input).backgroundColor),
        "rgba(0, 0, 0, 0)",
    );
    const originalTheme = await page.locator("html").getAttribute("data-editor-theme");
    const popupColors = [];
    for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => {
            document.documentElement.dataset.editorTheme = value;
        }, theme);
        await pickerInput.click();
        await pickerInput.press("ArrowDown");
        const popup = await pickerInput.evaluate((input) => {
            const select = input.closest(".workspace-select").querySelector("select");
            const picker = document.getElementById(`${select.id}-picker`);
            const probe = document.createElement("span");
            input.closest("#phead").append(probe);
            const color = (name) => {
                probe.style.color = `var(${name})`;
                return getComputedStyle(probe).color;
            };
            const style = getComputedStyle(picker);
            const focused = getComputedStyle(input);
            const accent = color("--c-accent");
            const items = [...picker.querySelectorAll('button[role="option"]')];
            const result = {
                open: picker.matches(":popover-open"),
                background: style.backgroundColor,
                themed:
                    style.backgroundColor === color("--c-surface") &&
                    style.color === color("--c-fg"),
                noOrangeRing:
                    (focused.outlineStyle === "none" ||
                        focused.outlineWidth === "0px" ||
                        focused.outlineColor !== accent) &&
                    !focused.boxShadow.includes(accent),
                transparentInput: focused.backgroundColor === "rgba(0, 0, 0, 0)",
                options: [...select.options]
                    .filter((option) => !option.disabled)
                    .every((option) => {
                        const item = items.find((button) => button.dataset.value === option.value);
                        const change = option.dataset.change ?? "";
                        return (
                            item &&
                            item.textContent === option.text &&
                            item.title === option.text &&
                            (item.dataset.change ?? "") === change &&
                            item.getAttribute("aria-selected") === String(option.selected) &&
                            getComputedStyle(item).color ===
                                color(
                                    {
                                        added: "--c-ok",
                                        modified: "--c-accent",
                                        deleted: "--c-danger",
                                    }[change] ?? "--c-fg",
                                ) &&
                            getComputedStyle(item).textDecorationLine.includes("underline") ===
                                option.selected
                        );
                    }),
            };
            probe.remove();
            return result;
        });
        assert.equal(popup.open, true);
        assert.equal(popup.themed, true);
        assert.equal(popup.noOrangeRing, true);
        assert.equal(popup.transparentInput, true);
        assert.equal(popup.options, true);
        popupColors.push(popup.background);
        await pickerInput.press("Escape");
    }
    assert.notEqual(popupColors[0], popupColors[1]);
    await page.evaluate((theme) => {
        if (theme === null) document.documentElement.removeAttribute("data-editor-theme");
        else document.documentElement.dataset.editorTheme = theme;
    }, originalTheme);
    await page.evaluate((label) => {
        const state = window.__doocConnections;
        state.items.get(state.active).label = label;
        document.dispatchEvent(
            new CustomEvent("dooc:select-workspace", {
                detail: { id: state.active, from: "not-current" },
            }),
        );
    }, originalLabel);
    const mainId = await first.getAttribute("data-workspace");
    const featureId = await second.getAttribute("data-workspace");
    assert.notEqual(mainId, featureId);
    await page.waitForFunction(
        (id) =>
            [
                ...document.querySelector('select[data-workspace-pane][data-active="true"]')
                    .options,
            ].find((option) => option.value === id)?.dataset.change === "added",
        featureId,
    );
    assert.equal(await selector.locator('option[data-change="added"]').count(), 1);
    await second.click({ position: { x: 20, y: 90 } });
    await page.waitForFunction(
        (pane) =>
            document.querySelector('select[data-workspace-pane][data-active="true"]')?.dataset
                .workspacePane === pane,
        secondPane,
    );
    const leftFeature = await leftSelector
        .locator(`option[value=${JSON.stringify(featureId)}]`)
        .getAttribute("value");
    await selectWorkspace(page, leftFeature, firstPane);
    await page.waitForFunction(
        ({ pane, workspace }) => {
            const selected = document.querySelector(
                'select[data-workspace-pane][data-active="true"]',
            );
            return (
                selected?.dataset.workspacePane === pane &&
                selected.value === workspace &&
                document
                    .querySelector("#cm .cm-content")
                    ?.textContent.includes("Right branch saved")
            );
        },
        { pane: firstPane, workspace: featureId },
    );
    assert.equal(await first.getAttribute("data-workspace"), featureId);
    assert.equal(await second.getAttribute("data-workspace"), featureId);
    assert.equal(await selector.getAttribute("data-workspace-pane"), firstPane);
    await second.click({ position: { x: 20, y: 90 } });
    await page.waitForFunction(
        (pane) =>
            document.querySelector('select[data-workspace-pane][data-active="true"]')?.dataset
                .workspacePane === pane,
        secondPane,
    );
    await selectWorkspace(page, mainId, firstPane);
    await page.waitForFunction(() =>
        document.querySelector("#cm .cm-content")?.textContent.includes("Unsaved left"),
    );
    assert.equal(await first.getAttribute("data-workspace"), mainId);
    assert.equal(await second.getAttribute("data-workspace"), featureId);
    assert.equal(await rightSelector.inputValue(), featureId);
    assert.match(await selector.locator("option:checked").innerText(), /main/);
    const disk = await page.evaluate(async () => {
        const rows = JSON.parse(localStorage.getItem("dooc.browser.workspaces"));
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("dooc");
        const results = {};
        for (const row of rows) {
            const directory = await root.getDirectoryHandle(row.id);
            const file = await (
                await (await directory.getDirectoryHandle("content")).getFileHandle("welcome.md")
            ).getFile();
            results[row.branch] = await file.text();
        }
        return results;
    });
    assert.match(disk.main, /Durable client-only edit/);
    assert.doesNotMatch(disk.main, /Right branch saved|Unsaved left/);
    assert.match(disk.feature, /Right branch saved/);
    const branches = await page.evaluate(() =>
        [...window.__doocConnections.items.values()].map(({ family, branch }) =>
            JSON.stringify([family, branch]),
        ),
    );
    assert.equal(new Set(branches).size, branches.length);
    assert.equal(branches.length, 2);
    const survivingInput = await pickerInput.getAttribute("id");
    const removedSelect = await rightSelector.getAttribute("id");
    await page.locator("#split-preview").click();
    await page.waitForFunction(() => document.querySelectorAll(".preview-pane").length === 1);
    assert.equal(await page.locator(".workspace-select").count(), 1);
    assert.equal(await page.locator(".workspace-picker").count(), 1);
    assert.equal(await pickerInput.getAttribute("id"), survivingInput);
    assert.equal(await selector.getAttribute("data-workspace-pane"), firstPane);
    assert.equal(
        await page.locator(`[id=${JSON.stringify(`${removedSelect}-picker`)}]`).count(),
        0,
    );
    assert.match(await editor.innerText(), /Unsaved left/);
    page.once("dialog", (dialog) => dialog.accept());
    await page.reload();
    await page.locator("select[name=mode]").selectOption("saved");
    await page.getByRole("button", { name: "Open workspace", exact: true }).click();
    await page.waitForSelector("#cm .cm-content", { timeout: 90_000 });
    await page.waitForFunction(
        () =>
            !!document.querySelector(
                'select[data-workspace-pane][data-active="true"] option[data-branch="feature"]',
            ),
    );
    const savedFeature = await selector
        .locator('option[data-branch="feature"]')
        .getAttribute("value");
    await page.evaluate(() => {
        const connection = window.__doocConnections.items.get(window.__doocConnections.active);
        const open = connection.openBranch.bind(connection);
        connection.openBranch = async (...args) => {
            await new Promise((resolve) => {
                window.__releaseBranch = resolve;
            });
            return open(...args);
        };
    });
    await selectWorkspace(page, savedFeature);
    await page.waitForFunction(
        () => document.querySelector('select[data-workspace-pane][data-active="true"]')?.disabled,
    );
    assert.equal(await pickerInput.getAttribute("aria-disabled"), "true");
    assert.equal(await selector.inputValue(), mainId);
    await page.evaluate(() => window.__releaseBranch());
    await page.waitForFunction(
        () =>
            !document.querySelector('select[data-workspace-pane][data-active="true"]')?.disabled &&
            document.querySelector("#cm .cm-content")?.textContent.includes("Right branch saved"),
    );
    assert.deepEqual(errors, []);
    return { disk, errors };
}

export async function testSocketWorkspace(page, url, socket) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(url);
    if (socket) {
        await page.locator("select[name=mode]").selectOption("server");
        await page.locator("input[name=server]").fill(socket);
        await page.getByRole("button", { name: "Open workspace", exact: true }).click();
    }
    await page.waitForSelector("#cm .cm-content", { timeout: 30_000 });
    await page.evaluate(() => {
        const toggle = document.getElementById("opt-autosave");
        if (toggle.checked) toggle.click();
    });
    await page.locator("#split-preview").click();
    const first = page.locator(".preview-pane").nth(0),
        second = page.locator(".preview-pane").nth(1);
    await first.click({ position: { x: 20, y: 120 } });
    await page.locator("#cm .cm-content").fill("# Left Node draft\n\nKeep this draft.\n");
    await second.click({ position: { x: 20, y: 120 } });
    await page.waitForFunction(
        () => !document.querySelector("#cm .cm-content")?.textContent.includes("Left Node draft"),
    );
    const selector = page.locator('select[data-workspace-pane][data-active="true"]');
    const mainId = await selector.inputValue();
    const mainText = await page.locator("#cm .cm-content").innerText();
    await page.locator('input.workspace-picker-input[data-active="true"]').click();
    await page.waitForFunction(
        () =>
            !!document.querySelector(
                'select[data-workspace-pane][data-active="true"] option[data-branch="feature"]',
            ),
    );
    const featureOption = await selector
        .locator('option[data-branch="feature"]')
        .getAttribute("value");
    await selectWorkspace(page, featureOption);
    await page.waitForFunction((id) => {
        const select = document.querySelector('select[data-workspace-pane][data-active="true"]');
        return (
            !select?.disabled &&
            document.querySelector(".preview-pane.active")?.dataset.workspace !== id
        );
    }, mainId);
    await page
        .locator("#cm .cm-content")
        .fill("# Node right saved\n\nOnly feature receives this edit.\n");
    await page.locator("#save").click();
    await page.waitForFunction(() => document.querySelector("#save")?.dataset.state === "saved");
    const featureId = await selector.inputValue();
    await selectWorkspace(page, mainId);
    await page.waitForFunction(
        (id) => document.querySelector(".preview-pane.active")?.dataset.workspace === id,
        mainId,
    );
    await page.waitForFunction(
        (text) => document.querySelector("#cm .cm-content")?.innerText === text,
        mainText,
    );
    await selectWorkspace(page, featureId);
    await page.waitForFunction(() =>
        document.querySelector("#cm .cm-content")?.textContent.includes("Only feature receives"),
    );
    assert.equal(await selector.locator(`option[value="${mainId}"]`).count(), 1);
    await first.click({ position: { x: 20, y: 120 } });
    await page.waitForFunction(() =>
        document.querySelector("#cm .cm-content")?.textContent.includes("Left Node draft"),
    );
    assert.match(await page.locator(".workspace-location").innerText(), /main/);
    await second.click({ position: { x: 20, y: 120 } });
    await page.waitForFunction(() =>
        document.querySelector(".workspace-location")?.textContent.includes("feature"),
    );
    await page.getByRole("link", { name: "Git", exact: true }).click();
    await page.waitForSelector('.preview-pane.active [aria-label="Git views"]');
    assert.equal(
        await page.locator('.preview-pane.active a[data-git-view="pull-requests"]').count(),
        1,
    );
}
