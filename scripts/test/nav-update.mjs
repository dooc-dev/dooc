import { updateNav } from "../../src/viewer/nav-update.ts";

// Bundle with esbuild and run testNavUpdate() in a browser.
window.testNavUpdate = () => {
    const assert = (condition, message) => {
        if (!condition) throw new Error(message);
    };
    const item = (id, title = id, children = "") =>
        `<div class="nav-item" data-doc-id="${id}"><div class="nav-row"><a href="/${id}"><span class="nav-label">${title}</span></a><input aria-label="${id}"></div><div class="nav-list" data-parent="${id}">${children}</div></div>`;
    const markup = (items) =>
        `<div class="nav-list" data-parent="">${items}</div><details id="nav-test-tools" open><summary>Tools</summary><span class="files-upload-status"></span></details><template data-page-subformats>[]</template>`;
    const host = document.createElement("div");
    host.style.cssText =
        "position:fixed;left:0;top:0;width:300px;height:100px;overflow:auto;z-index:9999";
    const root = document.createElement("div");
    root.style.minHeight = "500px";
    host.append(root);
    document.body.append(host);
    const node = (id) => root.querySelector(`[data-doc-id="${id}"]`);
    const children = (id) => node(id).querySelector(":scope > .nav-list");
    try {
        const initial = markup(item("a", "A", item("b")) + item("c"));
        root.innerHTML = initial;
        const a = node("a");
        const b = node("b");
        const c = node("c");
        a.classList.add("open", "nav-ancestor");
        b.classList.add("open");
        c.inert = true;
        root.dataset.focusedDoc = "b";
        children("a").style.setProperty("--nav-depth", "2");
        const tools = root.querySelector("details");
        tools.open = false;
        const status = root.querySelector(".files-upload-status");
        status.textContent = "Uploading…";
        const draft = document.createElement("div");
        draft.className = "nav-new-item";
        draft.innerHTML = '<form><input value="Unsaved page"></form>';
        children("a").append(draft);
        const input = draft.querySelector("input");
        input.focus();
        input.setSelectionRange(2, 5);
        host.scrollTop = 30;
        const observer = new MutationObserver(() => {});
        observer.observe(root, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
        });
        updateNav(root, initial);
        assert(observer.takeRecords().length === 0, "Identical navigation must not mutate the DOM");
        observer.disconnect();
        assert(
            document.activeElement === input &&
                input.selectionStart === 2 &&
                input.selectionEnd === 5,
            "Refresh preserves draft focus and selection",
        );
        assert(host.scrollTop === 30, "Refresh preserves scrolling");
        assert(
            node("a") === a && node("b") === b && node("c") === c,
            "Refresh keeps every page node",
        );
        assert(
            a.classList.contains("open") &&
                a.classList.contains("nav-ancestor") &&
                b.classList.contains("open") &&
                c.inert,
            "Refresh preserves expanded and compact branches",
        );
        assert(
            !tools.open && status.textContent === "Uploading…",
            "Refresh preserves tools and upload status",
        );

        const label = a.querySelector(".nav-label");
        const text = label.firstChild;
        updateNav(root, markup(item("a", "Renamed", item("b")) + item("c")));
        assert(
            a.querySelector(".nav-label") === label &&
                label.firstChild === text &&
                text.nodeValue === "Renamed",
            "Rename only changes the label text",
        );
        assert(
            draft.parentElement === children("a") && input.value === "Unsaved page",
            "Rename preserves the create form",
        );

        updateNav(root, markup(item("new") + item("c", "C", item("b")) + item("a", "Renamed")));
        assert(
            node("b") === b && b.parentElement === children("c"),
            "Reparenting reuses the existing child",
        );
        assert(
            node("a") === a && node("c") === c && node("new"),
            "Insertion and reorder retain unaffected pages",
        );
        assert(document.activeElement === input, "Reordering retains form focus");

        updateNav(root, markup(item("b", "B", item("c")) + item("a", "Renamed")));
        assert(
            node("b") === b && node("c") === c && c.parentElement === children("b"),
            "Moving an ancestor under its former descendant works",
        );
        assert(!node("new"), "Deleted pages are removed");
        updateNav(root, markup(item("c") + item("a", "Renamed")));
        assert(node("c") === c && !node("b"), "Children survive removal of their old parent");
        updateNav(root, markup(item("c") + item("a", "Renamed")).replace("[]", '["issue"]'));
        assert(
            root.querySelector("template").content.textContent === '["issue"]',
            "Inert page choices update too",
        );
        return "Passed: no-op refresh, page identity, expansion, drafts, focus, selection, scrolling, rename, reorder, reparent, insert, delete, tools and templates";
    } finally {
        host.remove();
    }
};
