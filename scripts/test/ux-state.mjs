import { mountFiles } from "../../packages/frontend/src/files-ui.ts";
import { mountGit } from "../../packages/frontend/src/git-ui.ts";
import { mountSearch, searchSections } from "../../packages/frontend/src/search.ts";
import { mountThemePickers } from "../../packages/frontend/src/theme-picker.ts";

const assert = (condition, message) => {
    if (!condition) throw new Error(message);
};
const wait = async (condition) => {
    for (let frame = 0; frame < 300; frame++) {
        if (condition()) return;
        await new Promise(requestAnimationFrame);
    }
    throw new Error("UI state did not settle");
};

window.testFilesFocusAndLanguage = async () => {
    const previous = globalThis.__doocConnections;
    const hosts = [document.createElement("div"), document.createElement("div")];
    document.body.append(...hosts);
    const listeners = new Map();
    const connections = ["first", "second"].map((id) => [
        id,
        {
            id,
            label: id,
            client: {
                request: async (op) =>
                    op === "hello"
                        ? { ops: [] }
                        : {
                              files: [{ path: `${id}/item.txt`, size: 10, extension: "txt" }],
                              revision: id,
                              documents: {},
                          },
                on: (_event, listener) => {
                    listeners.set(id, listener);
                    return () => listeners.delete(id);
                },
                opened: () => {},
            },
        },
    ]);
    globalThis.__doocConnections = { active: "first", items: new Map(connections) };
    const disposers = hosts.map((host, index) =>
        mountFiles(undefined, host, connections[index][0]),
    );
    try {
        await wait(() => hosts.every((host) => host.querySelector(".files-folder")));
        const folder = hosts[1].querySelector(".files-folder");
        folder.focus();
        folder.click();
        assert(
            document.activeElement.matches(".files-folder"),
            "Collapsing a folder retains keyboard focus",
        );
        assert(
            document.activeElement.getAttribute("aria-expanded") === "false",
            "Focus follows the collapsed folder",
        );
        document.dispatchEvent(new Event("docs:ui-language"));
        assert(
            hosts.every((host) => host.querySelector(".files-table")),
            "Language changes preserve both pane hosts",
        );
        assert(
            hosts[0].textContent.includes("first") && hosts[1].textContent.includes("second"),
            "Each pane keeps its workspace",
        );
        assert(
            hosts[1].contains(document.activeElement),
            "Language changes preserve the focused pane",
        );
        assert(
            document.activeElement.getAttribute("aria-expanded") === "false",
            "Language changes preserve collapsed folders",
        );
        document.activeElement.click();
        const row = hosts[1].querySelector('tr[data-path="second/item.txt"]');
        row.dispatchEvent(
            new MouseEvent("click", { ctrlKey: true, bubbles: true, cancelable: true }),
        );
        row.querySelector(".files-copy").focus();
        const before = row;
        listeners.get("second")({ kind: "content", files: ["second/item.txt"] });
        await wait(() => !before.isConnected);
        assert(
            hosts[1]
                .querySelector('tr[data-path="second/item.txt"]')
                .getAttribute("aria-selected") === "true",
            "Background reads retain selection",
        );
        assert(
            document.activeElement.matches(".files-copy") &&
                hosts[1].contains(document.activeElement),
            "Background reads retain row control focus",
        );
    } finally {
        for (const dispose of disposers) dispose?.();
        for (const host of hosts) host.remove();
        globalThis.__doocConnections = previous;
    }
};

window.testSearchRefreshAndTheme = async () => {
    const pane = document.createElement("div");
    pane.className = "preview-pane";
    pane.dataset.theme = "dark";
    document.body.append(pane);
    document.documentElement.dataset.theme = "dark";
    document.documentElement.dataset.editorTheme = "light";
    mountThemePickers({});
    pane.classList.add("resources-pane");
    pane.append(document.createElement("section"));
    await wait(() => pane.dataset.theme === "light");
    pane.classList.remove("resources-pane");
    pane.replaceChildren();
    await wait(() => pane.dataset.theme === "dark");
    assert(pane.dataset.theme === "dark", "Resource tools preserve the document theme");
    let index = [];
    mountSearch([], searchSections, {}, false, async () => Response.json(index));
    document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }),
    );
    const input = document.getElementById("doc-search-input");
    input.value = "FreshTerm";
    input.dispatchEvent(new Event("input"));
    input.setSelectionRange(2, 5);
    index = [
        {
            kind: "text",
            path: "/guide",
            file: "guide.md",
            title: "Guide",
            heading: "",
            anchor: "",
            text: "FreshTerm",
        },
    ];
    document.dispatchEvent(new Event("dooc:content-changed"));
    await wait(() =>
        document.getElementById("doc-search-results").textContent.includes("FreshTerm"),
    );
    assert(
        document.activeElement === input && input.selectionStart === 2 && input.selectionEnd === 5,
        "Search refresh preserves focus, query and selection",
    );
    assert(
        document.getElementById("doc-search").open,
        "Updated results appear without reopening search",
    );
};

window.testGitLiveRefresh = async () => {
    const previous = globalThis.__doocConnections;
    const host = document.createElement("div");
    document.body.append(host);
    let changed;
    const snapshot = {
        repo: "docs",
        branch: "main",
        head: "a".repeat(40),
        version: "before",
        branches: ["main"],
        changes: [],
        ahead: 0,
        behind: 0,
    };
    const client = {
        request: async () => structuredClone(snapshot),
        on: (_event, handler) => {
            changed = handler;
            return () => {
                changed = undefined;
            };
        },
        opened: () => {},
    };
    globalThis.__doocConnections = {
        active: "first",
        items: new Map([["first", { id: "first", client }]]),
    };
    const dispose = mountGit(host, "first");
    try {
        await wait(() => host.querySelector("textarea"));
        const message = host.querySelector("textarea");
        message.focus();
        message.value = "Unfinished commit message";
        message.dispatchEvent(new Event("input"));
        message.setSelectionRange(2, 7);
        snapshot.version = "after";
        snapshot.changes = [{ path: "updated.md", index: " ", worktree: "M" }];
        changed({ kind: "content", files: ["updated.md"] });
        assert(
            !host.querySelector("fieldset").disabled,
            "Background Git reads leave draft controls enabled",
        );
        await wait(() => host.textContent.includes("updated.md"));
        const current = host.querySelector("textarea");
        assert(
            current.value === "Unfinished commit message",
            "External file changes preserve the commit draft",
        );
        assert(
            document.activeElement === current &&
                current.selectionStart === 2 &&
                current.selectionEnd === 7,
            "Git refresh preserves focus and selection",
        );
    } finally {
        dispose?.();
        host.remove();
        globalThis.__doocConnections = previous;
    }
};
