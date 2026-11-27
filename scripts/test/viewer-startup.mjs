import assert from "node:assert/strict";

export async function testViewerStartup(page, url, theme, fail = false) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: theme === "dark" ? "light" : "dark" });
    await page.addInitScript((value) => {
        localStorage.setItem("docs-preview:theme", value);
        localStorage.setItem("docs-editor:theme", value);
    }, theme);
    let releaseNavigation;
    let releasePage;
    let heldNavigation = false;
    let heldPage = false;
    await page.routeWebSocket("**/server", (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((message) => {
            const request = JSON.parse(String(message));
            const path = request.op === "http" ? request.args.url : "";
            if (path.startsWith("/api/nav?") && !heldNavigation) {
                heldNavigation = true;
                releaseNavigation = () => server.send(message);
            } else if (path === "/" && fail) {
                socket.send(
                    JSON.stringify({
                        id: request.id,
                        value: { status: 503, headers: {}, body: "Unavailable" },
                    }),
                );
            } else if (path === "/" && !heldPage) {
                heldPage = true;
                releasePage = () => server.send(message);
            } else server.send(message);
        });
    });
    await page.goto(url);
    await page.locator("#client-loading").filter({ hasText: "Loading navigation…" }).waitFor();
    assert.equal(await page.locator("#sidebar").isVisible(), true);
    assert.equal(await page.locator("main article").count(), 0);
    const background = await page
        .locator("main")
        .evaluate((node) => getComputedStyle(node).backgroundColor);
    const painted = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(painted, theme === "dark" ? "rgb(16, 19, 22)" : "rgb(255, 255, 255)");
    assert.notEqual(background, theme === "dark" ? "rgb(255, 255, 255)" : "rgb(16, 19, 22)");
    assert.equal(await page.locator("#nav-groups a").count(), 0);
    releaseNavigation();
    await page.locator('#nav-groups a[title="Other"]').waitFor({ state: "attached" });
    assert.equal(await page.locator("#site-title").textContent(), "Guide");
    assert.equal(await page.locator("main article").count(), 0);
    if (fail) {
        await page.locator("#retry-document").waitFor();
        assert.equal(
            await page.locator("#client-loading").textContent(),
            "Could not load the document. Retry.",
        );
        fail = false;
        heldPage = true;
        await page.locator("#retry-document").click();
        await page.locator("main article").filter({ hasText: "Home body." }).waitFor();
    } else {
        await page.waitForFunction(
            () => document.getElementById("client-loading")?.textContent === "Loading page…",
        );
        await page.locator('#nav-groups a[title="Other"]').click();
        await page.locator("main article").filter({ hasText: "Other body." }).waitFor();
        releasePage();
        await page.waitForLoadState("networkidle");
        assert.match(await page.locator("main article").textContent(), /Other body\./);
    }
    assert.equal(await page.locator("#client-loading").count(), 0);
    assert.equal(await page.locator(".workspace-dialog").count(), 0);
}
