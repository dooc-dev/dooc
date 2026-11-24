// Run in a reader page to compare its current tree before and after collapsing the sidebar.
window.testSidebarCollapse = async () => {
    const assert = (condition, message) => {
        if (!condition) throw new Error(message);
    };
    const sidebar = document.getElementById("sidebar");
    const root = document.getElementById("nav-groups");
    const toggle = document.getElementById("sidebar-toggle");
    const wasClosed = document.body.classList.contains("sidebar-closed");
    const settle = async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await Promise.all(
            sidebar
                .getAnimations({ subtree: true })
                .map((animation) => animation.finished.catch(() => {})),
        );
    };
    const visible = (element) =>
        element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const snapshot = () => {
        const rows = [...root.querySelectorAll(".nav-row:has(> a)")].filter(visible);
        const icons = [
            ...root.querySelectorAll(
                ".nav-doc-icon > svg, .doc-icon-frame, a > svg, .workspace-location > svg",
            ),
        ].filter(visible);
        const lines = [...root.querySelectorAll(".nav-item, .nav-row")]
            .filter(visible)
            .flatMap((element) =>
                ["::before", "::after"].flatMap((pseudo) => {
                    const style = getComputedStyle(element, pseudo);
                    return style.content !== "none" &&
                        style.display !== "none" &&
                        parseFloat(style.width) > 0 &&
                        parseFloat(style.height) > 0
                        ? [{ element, pseudo, color: style.backgroundColor }]
                        : [];
                }),
            );
        return {
            rows: rows.map((element) => ({
                element,
                top: element.getBoundingClientRect().top,
                height: element.getBoundingClientRect().height,
            })),
            icons: icons.map((element) => ({
                element,
                top: element.getBoundingClientRect().top,
                height: element.getBoundingClientRect().height,
                color: getComputedStyle(element).color,
                mask: getComputedStyle(element, "::after").maskImage,
            })),
            ancestors: [...root.querySelectorAll(".nav-ancestor")],
            lines,
            scroll: [
                sidebar.querySelector("#sidebar-content"),
                root.querySelector("#nav-docs"),
                root.querySelector(".nav-tool-cards"),
            ]
                .filter(Boolean)
                .map((element) => ({
                    element,
                    top: element.scrollTop,
                    height: element.scrollHeight,
                    viewportHeight: element.clientHeight,
                })),
        };
    };
    try {
        if (wasClosed) toggle.click();
        await settle();
        const before = snapshot();
        toggle.click();
        await settle();
        const after = snapshot();
        for (const key of ["rows", "icons", "lines", "scroll"]) {
            assert(before[key].length === after[key].length, `Collapsing preserves visible ${key}`);
            before[key].forEach((expected, index) => {
                const actual = after[key][index];
                for (const property of Object.keys(expected)) {
                    assert(
                        actual[property] === expected[property],
                        `Collapsing preserves ${key}[${index}].${property}`,
                    );
                }
            });
        }
        assert(
            before.ancestors.length === after.ancestors.length &&
                before.ancestors.every((element, index) => element === after.ancestors[index]),
            "Collapsing preserves the compact ancestor chain",
        );
        const bounds = sidebar.getBoundingClientRect();
        const centers = after.icons
            .filter(({ element }) => element.closest(".nav-row"))
            .map(({ element }) => {
                const box = element.getBoundingClientRect();
                return box.left + box.width / 2;
            });
        assert(
            centers.every((center) => Math.abs(center - centers[0]) < 1),
            "Collapsed navigation icons form one column",
        );
        for (const { element } of after.scroll)
            assert(
                element.scrollWidth <= element.clientWidth,
                "Collapsed navigation does not scroll horizontally",
            );
        for (const { element } of after.icons) {
            const box = element.getBoundingClientRect();
            assert(
                box.left >= bounds.left && box.right <= bounds.right,
                "Collapsed icons fit inside the sidebar",
            );
        }
        return `Passed: ${after.rows.length} rows, ${after.icons.length} icons, ${after.lines.length} connectors; heights, highlighting, compact ancestors, and scroll positions preserved`;
    } finally {
        if (document.body.classList.contains("sidebar-closed") !== wasClosed) toggle.click();
        await settle();
    }
};

window.testSidebarMotion = async () => {
    const assert = (value, message) => {
        if (!value) throw new Error(message);
    };
    const settle = async (element) => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await Promise.all(
            element
                .getAnimations({ subtree: true })
                .map((animation) => animation.finished.catch(() => {})),
        );
    };
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const sidebar = document.getElementById("sidebar");
    const sidebarToggle = document.getElementById("sidebar-toggle");
    if (document.body.classList.contains("sidebar-closed")) sidebarToggle.click();
    await settle(sidebar);
    const width = sidebar.getBoundingClientRect().width;
    sidebarToggle.click();
    const resize = sidebar
        .getAnimations()
        .find((animation) => animation.transitionProperty === "width");
    if (reduced) assert(!resize, "Reduced motion skips the sidebar slide");
    else {
        assert(resize, "Sidebar width animates");
        await resize.ready;
        resize.pause();
        resize.currentTime = resize.effect.getTiming().duration / 2;
        const current = sidebar.getBoundingClientRect().width;
        assert(current > 52 && current < width, "Sidebar passes through an intermediate width");
    }
    sidebarToggle.click();
    await settle(sidebar);
    assert(
        Math.abs(sidebar.getBoundingClientRect().width - width) < 1,
        "Reversing restores the sidebar width",
    );
    const toggle = [...sidebar.querySelectorAll(".nav-tree-toggle")].find((button) =>
        button.checkVisibility(),
    );
    assert(toggle, "Fixture contains an expandable branch");
    const item = toggle.closest(".nav-item");
    const list = item.querySelector(":scope > .nav-list");
    if (!item.classList.contains("open")) toggle.click();
    await settle(sidebar);
    const height = list.getBoundingClientRect().height;
    assert(height > 0, "Expanded children are visible");
    toggle.click();
    const fold = item
        .getAnimations()
        .find((animation) => animation.transitionProperty === "grid-template-rows");
    assert(
        list.inert && toggle.getAttribute("aria-expanded") === "false",
        "Collapsed children immediately leave keyboard navigation",
    );
    if (reduced) assert(!fold, "Reduced motion skips branch movement");
    else {
        assert(fold, "Branch height animates");
        await fold.ready;
        fold.pause();
        fold.currentTime = fold.effect.getTiming().duration / 2;
        const current = list.getBoundingClientRect().height;
        assert(current > 0 && current < height, "Branch passes through an intermediate height");
    }
    toggle.click();
    await settle(sidebar);
    assert(
        !list.inert && Math.abs(list.getBoundingClientRect().height - height) < 1,
        "Repeated clicks reverse the branch smoothly",
    );
    toggle.click();
    await settle(sidebar);
    assert(list.getBoundingClientRect().height === 0, "Closed branches leave no blank space");
    const handle = document.getElementById("sidebar-resize");
    handle.focus();
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true }));
    assert(
        sidebar.getBoundingClientRect().width === width + 20 &&
            Number(localStorage.getItem("docs:sidebar-width")) === width + 20,
        "Keyboard resizing applies and saves its final width immediately",
    );
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", cancelable: true }));
    handle.blur();
};
