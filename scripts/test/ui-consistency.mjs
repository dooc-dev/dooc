import { showDialog } from "../../packages/frontend/src/edit-dialog.ts";
import { focusNavTree } from "../../packages/frontend/src/nav-focus.ts";

// Bundle and run testUiConsistency() on an edit page at desktop and mobile widths.
window.testUiConsistency = async () => {
    const assert = (condition, message) => {
        if (!condition) throw new Error(message);
    };
    const frame = () => new Promise(requestAnimationFrame);
    const visible = (element) => element.getClientRects().length > 0;
    const root = document.documentElement;
    const main = document.querySelector("main");
    const panel = document.querySelector("#panel");
    const pane = document.querySelector(".preview-pane.active");
    const palette = (element) => getComputedStyle(element).getPropertyValue("--c-bg1").trim();
    const gear = document.querySelector("#gear > button");
    const settings = document.querySelector("#gearmenu");
    const original = [root.dataset.theme, root.dataset.editorTheme, pane.dataset.theme];
    try {
        document.querySelector("#doc-search .search-close").click();
        for (const element of [main, panel]) {
            const rect = element.getBoundingClientRect();
            assert(rect.width >= 240, "The preview and editor remain readable");
            assert(rect.right <= innerWidth + 1, "Both panes stay inside the viewport");
        }
        assert(root.scrollWidth <= innerWidth, "The page has no horizontal overflow");
        for (const toggle of document.querySelectorAll(".nav-tree-toggle")) {
            const item = toggle.closest(".nav-item");
            const initial = item.classList.contains("open");
            assert(
                toggle.getAttribute("aria-expanded") === String(initial),
                "Disclosure state is initialized",
            );
            if (!visible(toggle)) continue;
            toggle.click();
            assert(
                toggle.getAttribute("aria-expanded") === String(!initial),
                "Disclosure state changes",
            );
            toggle.click();
        }
        const tree = document.createElement("div");
        tree.style.cssText = "position:fixed;top:0;left:0;width:120px;height:0;overflow:hidden";
        tree.dataset.expandedWidth = "120";
        tree.innerHTML =
            '<div class="nav-item" data-doc-id="a"><div class="nav-row"><button class="nav-tree-toggle" aria-expanded="false"></button></div><div class="nav-list"><div class="nav-item" data-doc-id="b"><div class="nav-row"><button class="nav-tree-toggle" aria-expanded="false"></button></div><div class="nav-list"><div class="nav-item" data-doc-id="c"><div class="nav-row"><a class="cur">Current</a></div></div></div></div></div></div>';
        document.body.append(tree);
        try {
            focusNavTree(tree);
            assert(
                [...tree.querySelectorAll(".nav-tree-toggle")].every(
                    (button) => button.getAttribute("aria-expanded") === "true",
                ),
                "Automatically expanded ancestors announce their state",
            );
        } finally {
            tree.remove();
        }
        gear.click();
        assert(
            visible(settings) && gear.getAttribute("aria-expanded") === "true",
            "Settings open explicitly",
        );
        const settingsRect = settings.getBoundingClientRect();
        assert(
            settingsRect.top >= 0 && settingsRect.bottom <= innerHeight,
            "Settings fit vertically",
        );
        gear.focus();
        gear.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        assert(
            !visible(settings) && gear.getAttribute("aria-expanded") === "false",
            "Escape dismisses focused settings",
        );
        assert(document.activeElement === gear, "Dismissal restores focus");

        root.dataset.theme = "dark";
        root.dataset.editorTheme = "light";
        pane.dataset.theme = "dark";
        pane.querySelector(".pane-language").click();
        await frame();
        const language = document.querySelector("#preview-language-menu");
        assert(
            visible(language) && palette(language) === palette(pane),
            "The language menu follows its preview theme",
        );
        language.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        const dismissed = showDialog("Theme check", "Temporary test dialog", [
            { value: "", label: "Close" },
        ]);
        const dialog = document.querySelector(".app-dialog");
        assert(palette(dialog) === palette(panel), "Dialogs follow the editor theme");
        dialog.close();
        await dismissed;

        document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }),
        );
        await frame();
        const search = document.querySelector("#doc-search");
        assert(
            search.open && palette(search) === palette(panel),
            "Search follows the editor theme",
        );
        const dock = search.querySelector(".search-dock");
        if (innerWidth <= 820) {
            assert(
                dock.disabled && !search.classList.contains("search-docked"),
                "Search floats on narrow screens",
            );
        } else if (!dock.disabled && !search.classList.contains("search-docked")) {
            dock.click();
            await frame();
            assert(
                panel.getBoundingClientRect().right <= innerWidth + 1,
                "Docked search leaves room for the editor",
            );
        }
        return {
            width: innerWidth,
            preview: main.getBoundingClientRect().width,
            editor: panel.getBoundingClientRect().width,
        };
    } finally {
        for (const [element, key, value] of [
            [root, "theme", original[0]],
            [root, "editorTheme", original[1]],
            [pane, "theme", original[2]],
        ]) {
            if (value === undefined) delete element.dataset[key];
            else element.dataset[key] = value;
        }
    }
};
