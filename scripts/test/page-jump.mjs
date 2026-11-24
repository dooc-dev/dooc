import assert from "node:assert/strict";

const tick = (page) =>
    page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );

export const testPageJump = async (page, url, editor = false, live = true) => {
    await page.goto(url);
    const surface = editor ? ".preview-pane.active" : "main";
    const pane = page.locator(surface);
    await pane.locator("article p").first().click();
    const selected = () => page.locator("#site-title.cur, #nav-groups a.cur").innerText();
    const settled = async (name) => {
        await page
            .waitForFunction(
                ({ surface, name }) =>
                    document.querySelector(`${surface} article h1`)?.textContent === name &&
                    !document.querySelector("main[aria-busy=true]"),
                { surface, name },
            )
            .catch(async (error) => {
                const state = await page.evaluate(() => ({
                    url: location.href,
                    title: document.querySelector("main article h1")?.textContent,
                    selection: document.querySelector("#site-title.cur, #nav-groups a.cur")
                        ?.outerHTML,
                    focus: document.activeElement?.outerHTML.slice(0, 500),
                    busy: document.querySelector("main")?.getAttribute("aria-busy"),
                }));
                throw new Error(`Expected ${name}: ${JSON.stringify(state)}`, { cause: error });
            });
        assert.equal(await selected(), name === "Home" ? "Handbook" : name);
        assert(await pane.evaluate((element) => element.contains(document.activeElement)));
    };
    const move = async (arrow, name) => {
        await page.keyboard.down("Space");
        await page.keyboard.press(arrow);
        await page.keyboard.up("Space");
        await settled(name);
    };
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft"]) await move(key, "Home");
    await move("ArrowRight", "Alpha");
    await page.evaluate(() => {
        const item = document.querySelector("#nav-groups a.cur").closest("[data-doc-id]");
        window.__docsNavOpen(item.dataset.docId, false);
    });
    assert.equal(
        await page
            .locator("#nav-groups .nav-item:has(> .nav-row > a.cur)")
            .getAttribute("class")
            .then((value) => value.includes("open")),
        false,
    );
    await move("ArrowRight", "Alpha One");
    assert.equal(
        await page.locator("#nav-groups a.cur").evaluate((link) => {
            const parent = link.closest(".nav-item").parentElement.closest(".nav-item");
            return (
                parent.classList.contains("open") &&
                !parent.querySelector(":scope > .nav-list").inert
            );
        }),
        true,
        "A closed parent opens and enters its child in one command",
    );
    await move("ArrowRight", "Deep");
    await move("ArrowRight", "Deep");
    await move("ArrowLeft", "Alpha One");
    await move("ArrowDown", "Alpha Two");
    await move("ArrowDown", "Alpha Two");
    await move("ArrowUp", "Alpha One");
    await move("ArrowUp", "Alpha One");
    await move("ArrowLeft", "Alpha");
    await move("ArrowUp", "Alpha");

    if (live) {
        await page.evaluate(() => {
            const registry = globalThis.__doocConnections;
            const connection = registry.items.get(registry.active);
            const original = connection.fetch;
            window.pageJumpGate = {
                restore: () => {
                    connection.fetch = original;
                },
            };
            connection.fetch = async (...args) => {
                const response = await original(...args);
                const url = new URL(args[0], location.href);
                if (url.searchParams.get("route") === "/beta" || url.pathname.endsWith("/beta"))
                    await new Promise((resolve) => {
                        window.pageJumpGate.release = resolve;
                    });
                return response;
            };
        });
        await page.keyboard.down("Space");
        await page.keyboard.down("ArrowDown");
        await page.waitForFunction(() => !!window.pageJumpGate.release);
        assert.equal(await selected(), "Beta", "Selection advances before content arrives");
        await page.keyboard.down("ArrowDown");
        await page.keyboard.up("ArrowDown");
        await settled("Gamma");
        await page.evaluate(() => {
            window.pageJumpGate.restore();
            window.pageJumpGate.release();
        });
        await tick(page);
        await page.keyboard.up("Space");
        await settled("Gamma");
        assert.equal(await pane.evaluate((element) => element.scrollTop), 0);
    } else {
        await page.keyboard.down("Space");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.up("Space");
        await settled("Gamma");
    }
    await move("ArrowDown", "Gamma");
    await move("ArrowLeft", "Home");

    if (!(await page.locator("body").evaluate((body) => body.classList.contains("sidebar-closed"))))
        await page.locator("#sidebar-toggle").click();
    await pane.locator("article p").first().click();
    await move("ArrowRight", "Alpha");
    assert(
        await page.locator("body").evaluate((body) => body.classList.contains("sidebar-closed")),
    );
    await move("ArrowLeft", "Home");
    await page.locator("#sidebar-toggle").click();
    await pane.locator("article p").first().click();
    await pane.evaluate((element) => {
        element.scrollTop = 0;
    });
    await page.keyboard.down("Space");
    assert.equal(await pane.evaluate((element) => element.scrollTop), 0);
    await page.keyboard.up("Space");
    await page.waitForFunction((surface) => document.querySelector(surface).scrollTop > 0, surface);
    assert.equal(await selected(), "Handbook", "Space alone scrolls without navigating");
    await pane.evaluate((element) => {
        element.scrollTop = 0;
    });
    await page.keyboard.press("ArrowRight");
    assert.equal(await selected(), "Handbook", "Arrows alone do not navigate");

    await pane.evaluate((element) => {
        const input = document.createElement("textarea");
        input.id = "page-jump-input";
        element.prepend(input);
        input.focus();
    });
    await page.keyboard.down("Space");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.up("Space");
    assert.equal(await page.locator("#page-jump-input").inputValue(), " ");
    assert.equal(await selected(), "Handbook");
    await page.locator("#page-jump-input").evaluate((element) => element.remove());
    await pane.focus();
    await page.keyboard.down("Space");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.keyboard.press("ArrowRight");
    await page.keyboard.up("Space");
    assert.equal(await selected(), "Handbook", "Blur clears a held Space");
    await page.keyboard.down("Space");
    await page.locator("#site-title").focus();
    await pane.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.up("Space");
    assert.equal(await selected(), "Handbook", "Leaving the reading pane clears a held Space");

    if (!editor) return;
    await page.locator("#cm .cm-content").focus();
    await page.keyboard.down("Space");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.up("Space");
    assert.equal(await selected(), "Handbook", "Source editing keeps its own keys");
    await page.keyboard.press("Control+z");

    await page.locator("#split-preview").click();
    await page.waitForFunction(() => document.querySelectorAll(".preview-pane").length === 2);
    await pane.locator("article p").first().click();
    await move("ArrowRight", "Alpha");
    assert.equal(await page.locator(".preview-pane:not(.active) article h1").textContent(), "Home");
    await page.locator(".preview-pane:not(.active) article p").first().click();
    await pane
        .locator("article h1")
        .filter({ hasText: /^Home$/ })
        .waitFor();
    await pane.focus();
    await move("ArrowRight", "Alpha");
    await move("ArrowLeft", "Home");
    await page.locator("#split-preview").click();

    await page.locator("#gear > button").click();
    await page.locator("#language-setting .language-select-input").click();
    await page.locator('#ui-language-picker button[data-value="jpn"]').click();
    await page
        .locator("#gearmenu label:has(#opt-page-jump)")
        .filter({ hasText: "space+矢印 page jump" })
        .waitFor();
    await page.locator("#opt-page-jump").uncheck();
    await pane.locator("article p").first().click();
    await page.keyboard.down("Space");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.up("Space");
    assert.equal(await selected(), "Handbook", "The checkbox disables page jumps");
    await page.reload();
    await page.locator("#cm .cm-content").waitFor();
    assert.equal(await page.locator("#opt-page-jump").isChecked(), false);
    await page.locator("#gear > button").click();
    await page.locator("#opt-page-jump").check();
    await page.screenshot({ path: "/tmp/dooc-page-jump-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await tick(page);
    await page
        .locator("#sidebar")
        .evaluate((element) =>
            Promise.all(
                element
                    .getAnimations({ subtree: true })
                    .map((animation) => animation.finished.catch(() => {})),
            ),
        );
    await page.screenshot({ path: "/tmp/dooc-page-jump-mobile.png" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await pane.locator("article p").first().click();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await move("ArrowRight", "Alpha");
    await page.emulateMedia({ reducedMotion: "no-preference" });
};
