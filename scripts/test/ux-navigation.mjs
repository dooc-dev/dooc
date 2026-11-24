import assert from "node:assert/strict";

const tick = (page) =>
    page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
const visit = async (page, name) => {
    await page
        .locator("#nav-groups a")
        .filter({ hasText: new RegExp(`^${name}$`) })
        .click();
    await page.waitForFunction(
        (name) => document.querySelector("#cm .cm-content")?.textContent.includes(`${name} body`),
        name,
    );
};
const hold = (page, route) =>
    page.evaluate((route) => {
        const registry = globalThis.__doocConnections;
        const connection = registry.items.get(registry.active);
        const original = connection.fetch;
        window.uxGate = {};
        connection.fetch = async (...args) => {
            const response = await original(...args);
            if (
                new URL(args[0], location.href).searchParams.get("route") === route &&
                !window.uxGate.release
            )
                await new Promise((resolve) => {
                    window.uxGate.release = resolve;
                });
            return response;
        };
        window.uxGate.restore = () => {
            connection.fetch = original;
        };
    }, route);
const release = async (page) => {
    await page.evaluate(() => {
        window.uxGate.restore();
        window.uxGate.release();
    });
    await tick(page);
};

export const testUxNavigation = async (page, url) => {
    await page.goto(url);
    await page.locator("#cm .cm-content").waitFor();
    await hold(page, "/alpha");
    await page
        .locator("#nav-groups a")
        .filter({ hasText: /^Alpha$/ })
        .click();
    await page.waitForFunction(() => !!window.uxGate.release);
    await page.evaluate(() => window.__docsRefreshNav());
    assert.equal(
        await page.locator('#nav-groups a.cur[aria-current="page"]').innerText(),
        "Alpha",
        "Background navigation refresh preserves the pending target",
    );
    await release(page);
    await page.waitForFunction(() =>
        document.querySelector("#cm .cm-content").textContent.includes("Alpha body"),
    );
    await visit(page, "Beta");
    await visit(page, "Gamma");
    const length = await page.evaluate(() => history.length);
    await hold(page, "/beta");
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => !!window.uxGate.release);
    await page.evaluate(() => history.back());
    await page.waitForFunction(() =>
        document.querySelector("#cm .cm-content").textContent.includes("Alpha body"),
    );
    await release(page);
    assert.match(await page.locator("#cm .cm-content").textContent(), /Alpha body/);
    assert.equal(
        await page.evaluate(() => history.length),
        length,
        "Stale history responses preserve the forward stack",
    );
    await page.evaluate(() => history.forward());
    await page.waitForFunction(() =>
        document.querySelector("#cm .cm-content").textContent.includes("Beta body"),
    );
    assert.equal(await page.locator('#nav-groups [aria-current="page"]').innerText(), "Beta");

    await page.evaluate(() => {
        const registry = globalThis.__doocConnections;
        const connection = registry.items.get(registry.active);
        const original = connection.fetch;
        let count = 0;
        window.uxExternal = {};
        connection.fetch = async (...args) => {
            const response = await original(...args);
            if (!new URL(args[0], location.href).pathname.endsWith("/api/doc")) return response;
            const data = await response.json();
            const older = ++count === 1;
            data.body = data.raw = older ? "Older external body" : "Newer external body";
            if (older)
                await new Promise((resolve) => {
                    window.uxExternal.release = resolve;
                });
            return Response.json(data);
        };
        window.uxExternal.restore = () => {
            connection.fetch = original;
        };
        window.__docsHmr.onContent(["beta.md"]);
    });
    await page.waitForFunction(() => !!window.uxExternal.release);
    await page.evaluate(() => window.__docsHmr.onContent(["beta.md"]));
    await page.waitForFunction(() =>
        document.querySelector("#cm .cm-content").textContent.includes("Newer external body"),
    );
    await page.evaluate(() => {
        window.uxExternal.restore();
        window.uxExternal.release();
    });
    await tick(page);
    assert.match(
        await page.locator("#cm .cm-content").textContent(),
        /Newer external body/,
        "Older HMR responses cannot replace newer content",
    );

    await page.evaluate(() => {
        const registry = globalThis.__doocConnections;
        const connection = registry.items.get(registry.active);
        const original = connection.fetch;
        let count = 0;
        window.uxNav = {};
        connection.fetch = async (...args) => {
            const response = await original(...args);
            if (!new URL(args[0], location.href).pathname.endsWith("/api/nav")) return response;
            const data = await response.json();
            const older = ++count === 1;
            data.siteTitle = older ? "Older title" : "Newer title";
            if (older)
                await new Promise((resolve) => {
                    window.uxNav.release = resolve;
                });
            return Response.json(data);
        };
        window.uxNav.restore = () => {
            connection.fetch = original;
        };
        window.uxNav.first = window.__docsRefreshNav();
    });
    await page.waitForFunction(() => !!window.uxNav.release);
    await page.evaluate(() => window.__docsRefreshNav());
    await page.evaluate(async () => {
        window.uxNav.restore();
        window.uxNav.release();
        await window.uxNav.first;
    });
    assert.equal(
        await page.locator("#site-title").innerText(),
        "Newer title",
        "Navigation metadata keeps the latest response",
    );

    await page.goto(url);
    await page.locator("#cm .cm-content").waitFor();
    await page.locator("#split-preview").click();
    await page.waitForFunction(() => document.querySelectorAll(".preview-pane").length === 2);
    await hold(page, "/");
    await page
        .locator(".preview-pane")
        .first()
        .click({ position: { x: 40, y: 160 } });
    await page.waitForFunction(() => !!window.uxGate.release);
    await visit(page, "Beta");
    await release(page);
    assert.match(
        await page.locator("#cm .cm-content").textContent(),
        /Beta body/,
        "Pane refresh cannot consume or undo a navigation click",
    );

    await page.goto(url);
    await page.locator("#cm .cm-content").waitFor();
    for (const name of ["files", "library", "subformats"]) {
        await page.locator(`#nav-${name} a`).click();
        await page.waitForFunction((name) => location.pathname.endsWith(`/_${name}`), name);
    }
    await hold(page, "/_library");
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => !!window.uxGate.release);
    await page.evaluate(() => history.back());
    await page.locator("#files-manager").waitFor();
    await release(page);
    assert(new URL(page.url()).pathname.endsWith("/_files"));
    assert.equal(
        await page.locator("#files-manager").count(),
        1,
        "Resource history keeps content aligned with the latest URL",
    );
};

export const testSidebarReorder = async (page, url) => {
    await page.goto(url);
    await page.locator("#cm .cm-content").waitFor();
    const link = (name) => page.locator("#nav-docs a").filter({ hasText: new RegExp(`^${name}$`) });
    const row = (name) => link(name).locator("..");
    const tree = () =>
        page.evaluate(() => {
            const read = (list) =>
                [...list.children]
                    .filter((node) => node.dataset.docId)
                    .map((node) => ({
                        title: node.querySelector(":scope > .nav-row > a").textContent.trim(),
                        children: read(node.querySelector(":scope > .nav-list")),
                    }));
            return read(document.getElementById("nav-docs"));
        });
    const waitForTree = async (expected) => {
        for (let attempt = 0; attempt < 150; attempt++) {
            if (JSON.stringify(await tree()) === JSON.stringify(expected)) return;
            await tick(page);
        }
        assert.deepEqual(await tree(), expected);
    };
    const node = (title, children = []) => ({ title, children });
    await link("Beta").dragTo(link("Alpha"));
    await waitForTree([node("Alpha", [node("Beta")]), node("Gamma")]);
    await link("Beta").dragTo(page.locator("#nav-docs > .nav-placeholder > .nav-row"));
    await waitForTree([node("Alpha"), node("Gamma"), node("Beta")]);
    await link("Beta").dragTo(row("Alpha"), { targetPosition: { x: 100, y: 2 } });
    await waitForTree([node("Beta"), node("Alpha"), node("Gamma")]);
    const box = await row("Gamma").boundingBox();
    await link("Beta").dragTo(row("Gamma"), { targetPosition: { x: 100, y: box.height - 2 } });
    await waitForTree([node("Alpha"), node("Gamma"), node("Beta")]);
    await link("Beta").dragTo(link("Alpha"));
    await waitForTree([node("Alpha", [node("Beta")]), node("Gamma")]);
    await link("Alpha").dragTo(link("Beta"));
    assert.deepEqual(
        await tree(),
        [node("Alpha", [node("Beta")]), node("Gamma")],
        "A page cannot move beneath its descendant",
    );
    await link("Beta").dragTo(page.locator("#sidebar-head"));
    await waitForTree([node("Alpha"), node("Gamma"), node("Beta")]);
    await link("Beta").dragTo(link("Alpha"));
    await waitForTree([node("Alpha", [node("Beta")]), node("Gamma")]);
    const root = page.locator("#nav-docs");
    const rootBox = await root.boundingBox();
    await link("Beta").dragTo(root, { targetPosition: { x: 100, y: rootBox.height - 8 } });
    await waitForTree([node("Alpha"), node("Gamma"), node("Beta")]);
    assert.equal(
        await page
            .locator(
                "#sidebar .dragging, #sidebar .drop-before, #sidebar .drop-after, #sidebar .drop-into",
            )
            .count(),
        0,
        "Dropping clears the drag state and markers",
    );
    await page.reload();
    await page.locator("#cm .cm-content").waitFor();
    assert.deepEqual(
        await tree(),
        [node("Alpha"), node("Gamma"), node("Beta")],
        "Reordering is persisted in the manifest",
    );
    await page.evaluate(() => {
        const row = (name) =>
            [...document.querySelectorAll("#nav-docs a")]
                .find((link) => link.textContent.trim() === name)
                .closest(".nav-row");
        const alpha = row("Alpha");
        window.__docsNavOpen(alpha.closest(".nav-item").dataset.docId, false);
        const dataTransfer = new DataTransfer();
        row("Beta").dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
        const box = alpha.getBoundingClientRect();
        alpha.dispatchEvent(
            new DragEvent("dragover", {
                bubbles: true,
                cancelable: true,
                dataTransfer,
                clientY: box.top + box.height / 2,
            }),
        );
        window.dispatchEvent(new Event("blur"));
    });
    await page.waitForTimeout(550);
    assert.equal(
        await row("Alpha")
            .locator("..")
            .evaluate((item) => item.classList.contains("open")),
        false,
        "Canceling a drag also cancels the pending parent expansion",
    );
    assert.equal(await page.locator("#sidebar .dragging, #sidebar .drop-into").count(), 0);
};
