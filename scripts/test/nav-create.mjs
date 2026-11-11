// Run testNavCreate() in a browser on an edit page with at least one document.
window.testNavCreate = async () => {
    const assert = (condition, message) => {
        if (!condition) throw new Error(message);
    };
    const wait = async (test) => {
        for (let i = 0; i < 100; i++) {
            if (test()) return;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(`Timed out: ${test.toString()}`);
    };
    const rootTrigger = document.querySelector(".nav-create");
    const childTrigger = document.querySelector(".nav-row > .new");
    const template = document.querySelector("[data-page-subformats]");
    const originalFormats = template.innerHTML;
    const originalFetch = window.fetch;
    const originalRefresh = window.__docsRefreshNav;
    const originalNavigate = window.__docsNavigate;
    const requests = [];
    let navigation;
    let fail = true;
    window.__docsRefreshNav = async () => {};
    window.__docsNavigate = async (path) => {
        navigation = path;
    };
    window.fetch = async (url, options) => {
        if (new URL(url, location.href).pathname !== "/api/create")
            return originalFetch(url, options);
        requests.push(JSON.parse(options.body));
        return fail
            ? Response.json({ error: "Try again" }, { status: 409 })
            : Response.json({ path: "/added-page" });
    };
    const menu = document.querySelector("#nav-page-menu");
    const key = (value) =>
        document.activeElement.dispatchEvent(
            new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
        );
    try {
        template.content.textContent = JSON.stringify([{ ext: "issue" }, { ext: "release" }]);
        rootTrigger.click();
        assert(
            menu.matches(":popover-open") && !document.querySelector(".nav-new"),
            "The button opens a type menu before creating a form",
        );
        const triggerRect = rootTrigger.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        assert(
            menuRect.top <= triggerRect.top && menuRect.bottom >= triggerRect.bottom,
            "The add menu covers the original plus button position",
        );
        assert(
            [...menu.querySelectorAll(":scope > button")].every((button) =>
                button.firstElementChild?.matches("svg"),
            ),
            "Both page types begin with their icon in matching menu rows",
        );
        key("End");
        assert(document.activeElement.dataset.pageType === "subformat", "End focuses Subformat");
        key("Home");
        assert(document.activeElement.dataset.pageType === "markdown", "Home focuses Markdown");
        key("ArrowUp");
        assert(
            document.activeElement.dataset.pageType === "subformat",
            "Menu keyboard navigation wraps",
        );
        key("Escape");
        assert(
            !menu.matches(":popover-open") && document.activeElement === rootTrigger,
            "Escape closes the menu and restores focus",
        );

        childTrigger.click();
        menu.querySelector('[data-page-type="markdown"]').click();
        let form = document.querySelector(".nav-new");
        assert(
            !form.querySelector("select") && document.activeElement === form.elements.title,
            "Markdown goes straight to the title without a type selector",
        );
        form.elements.title.value = "Draft page";
        form.elements.title.dispatchEvent(new Event("input"));
        assert(form.elements.name.value === "Draft page.md", "Markdown still suggests a filename");
        form.requestSubmit();
        assert(
            form.querySelector(".nav-new-go").disabled,
            "Repeated submissions are blocked while saving",
        );
        await wait(() => form.querySelector(".err").textContent === "Try again");
        assert(
            form.elements.title.value === "Draft page" &&
                !form.querySelector(".nav-new-go").disabled,
            "Failure retains the draft and allows retry",
        );
        assert(
            requests[0].parent === childTrigger.dataset.parent && !requests[0].subformat,
            "Markdown keeps its selected parent",
        );
        fail = false;
        form.requestSubmit();
        await wait(() => !form.isConnected);
        assert(!navigation, "Markdown keeps the existing post-create navigation behavior");

        rootTrigger.click();
        const dropdown = menu.querySelector('[data-page-type="subformat"]');
        const formatsMenu = menu.querySelector("#nav-subformat-menu");
        assert(
            dropdown.hasAttribute("popovertarget"),
            "Subformat starts as a dropdown in the add menu",
        );
        dropdown.click();
        assert(
            !document.querySelector(".nav-new") &&
                formatsMenu.querySelectorAll("button").length === 2,
            "Subformat opens existing choices directly without a form, title or description",
        );
        key("End");
        assert(
            document.activeElement.dataset.subformat === "release",
            "Dropdown keyboard navigation stays within existing formats",
        );
        key("Escape");
        assert(
            menu.matches(":popover-open") &&
                !formatsMenu.matches(":popover-open") &&
                document.activeElement === dropdown,
            "Escape from the dropdown returns to the type menu",
        );
        fail = true;
        dropdown.click();
        formatsMenu.querySelector('[data-subformat="release"]').click();
        assert(
            dropdown.disabled && menu.getAttribute("aria-busy") === "true",
            "Choosing a format blocks duplicate requests while adding",
        );
        await wait(() => menu.querySelector(".err").textContent === "Try again");
        assert(
            !dropdown.disabled && menu.matches(":popover-open"),
            "Failed additions keep the dropdown available for retry",
        );
        fail = false;
        dropdown.click();
        formatsMenu.querySelector('[data-subformat="release"]').click();
        await wait(() => navigation);
        const added = requests.at(-1);
        assert(
            added.subformat === "release" &&
                added.title === "release" &&
                !("name" in added) &&
                !("parent" in added),
            "A single dropdown choice adds a root page using the format name without a Markdown file",
        );
        assert(
            navigation === "/added-page" && !menu.matches(":popover-open"),
            "The added page opens and the menu closes",
        );
        navigation = undefined;
        childTrigger.click();
        dropdown.click();
        formatsMenu.querySelector('[data-subformat="issue"]').click();
        await wait(() => navigation);
        assert(
            requests.at(-1).parent === childTrigger.dataset.parent,
            "Subformat additions preserve the selected parent",
        );

        template.content.textContent = "[]";
        rootTrigger.click();
        assert(
            menu.querySelector('[data-page-type="subformat"]').disabled &&
                menu.querySelector('[data-page-type="subformat"]').title,
            "Unavailable subformats disable the dropdown with an accessible explanation",
        );
        key("ArrowDown");
        assert(
            document.activeElement.dataset.pageType === "markdown",
            "Keyboard navigation skips the unavailable choice",
        );
        document.activeElement.click();
        form = document.querySelector(".nav-new");
        form.querySelector(".nav-new-cancel").click();
        assert(
            !form.isConnected && document.activeElement === rootTrigger,
            "Cancel restores focus to the originating button",
        );
        return "Passed: type menu, keyboard, child/root placement, direct dropdown, errors, retry, submit payloads, navigation and unavailable state";
    } finally {
        if (menu.matches(":popover-open")) menu.hidePopover();
        document.querySelector(".nav-new-item")?.remove();
        template.innerHTML = originalFormats;
        window.fetch = originalFetch;
        window.__docsRefreshNav = originalRefresh;
        window.__docsNavigate = originalNavigate;
    }
};
