import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { ScriptTarget, transpileModule } from "typescript";
import { expect, it, vi } from "vitest";

const source = readFileSync(new URL("./edit-client.ts", import.meta.url), "utf8");
const extract = (start: string, end: string): string => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);
    return source.slice(from, to);
};
// Exercise the actual controller with delayed responses without booting the entire editor DOM.
const run = (code: string, globals: Record<string, unknown>) => {
    const context = createContext(globals);
    runInContext(
        transpileModule(code, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText,
        context,
    );
    return context;
};
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};

const optionController = (
    panes: { id: number; workspace: string }[],
    readWorkspaceOptions: (id: string) => Promise<unknown[]>,
) =>
    run(
        [
            extract("const workspaceOptions =", "const syncWorkspaceSelectors ="),
            extract("const refreshWorkspaceOptions =", "\nconst syncPane ="),
            "globalThis.refresh = refreshWorkspaceOptions; globalThis.invalidate = invalidateWorkspaceOptions; globalThis.options = workspaceOptions;",
        ].join("\n"),
        {
            panes,
            activePane: panes[0],
            localWorkspaceLabel: undefined,
            readWorkspaceOptions,
            syncWorkspaceSelectors: vi.fn(),
        },
    );

it("coalesces matching workspaces and serializes scans while preserving both panes' branch lists", async () => {
    const first = deferred<unknown[]>();
    const second = deferred<unknown[]>();
    const panes = [
        { id: 0, workspace: "main" },
        { id: 1, workspace: "feature" },
    ];
    const read = vi.fn((id: string) => (id === "main" ? first.promise : second.promise));
    const context = optionController(panes, read);
    const main = context.refresh(panes[0]);
    expect(context.refresh(panes[0])).toBe(main);
    const feature = context.refresh(panes[1]);
    context.activePane = panes[1];
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    expect(read).toHaveBeenLastCalledWith("main", undefined);
    first.resolve([{ id: "main", label: "main/docs" }]);
    await main;
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(read).toHaveBeenLastCalledWith("feature", undefined);
    second.resolve([{ id: "feature", label: "feature/docs" }]);
    await feature;
    expect(context.options.get("main")).toEqual([{ id: "main", label: "main/docs" }]);
    expect(context.options.get("feature")).toEqual([{ id: "feature", label: "feature/docs" }]);
    expect(context.syncWorkspaceSelectors).toHaveBeenCalledTimes(2);
});

it.each([
    "removed",
    "switched",
])("ignores branch results after their last pane is %s", async (change) => {
    const result = deferred<unknown[]>();
    const pane = { id: 0, workspace: "main" };
    const panes = [pane, { id: 1, workspace: "feature" }];
    const read = vi.fn(() => result.promise);
    const context = optionController(panes, read);
    const pending = context.refresh(pane);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    if (change === "removed") panes.splice(0, 1);
    else pane.workspace = "other";
    result.resolve([{ id: "main", label: "main/docs" }]);
    await pending;
    expect(context.options.has("main")).toBe(false);
    expect(context.syncWorkspaceSelectors).not.toHaveBeenCalled();
    if (change === "removed") {
        await context.refresh(pane);
        expect(read).toHaveBeenCalledOnce();
    }
});

it("refreshes Git status again when files change during an existing branch scan", async () => {
    const beforeSave = deferred<unknown[]>();
    const afterSave = deferred<unknown[]>();
    const read = vi
        .fn()
        .mockReturnValueOnce(beforeSave.promise)
        .mockReturnValueOnce(afterSave.promise);
    const context = optionController([{ id: 0, workspace: "main" }], read);
    const pending = context.refresh();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    context.invalidate();
    context.invalidate();
    expect(read).toHaveBeenCalledOnce();
    beforeSave.resolve([{ id: "main", label: "main/docs" }]);
    await pending;
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    afterSave.resolve([{ id: "main", label: "main/docs", change: "added" }]);
    await vi.waitFor(() => expect(context.options.get("main")[0].change).toBe("added"));
    expect(read).toHaveBeenCalledTimes(2);
});

it.each([
    false,
    true,
])("activates the chosen picker owner before switching its workspace (unopened branch: %s)", async (branch) => {
    const dirtyDraft = { dirty: true, text: "Unsaved work" };
    const first = { id: 0, workspace: "main", draft: dirtyDraft };
    const second = { id: 1, workspace: "other", pendingWorkspace: "older-choice" };
    const context = run(
        [
            "let openingWorkspaceBranch = false;",
            extract(
                "const selectPaneWorkspace =",
                '\ndocument.addEventListener("dooc:workspace-changed"',
            ),
            "globalThis.choose = selectPaneWorkspace;",
        ].join("\n"),
        {
            panes: [first, second],
            activePane: first,
            paneBusy: false,
            syncWorkspaceSelectors: vi.fn(),
            changeWorkspace: vi.fn(),
            openWorkspaceBranch: vi.fn(),
            refreshWorkspaceOptions: vi.fn(),
            setStatus: vi.fn(),
            t: (value: string) => value,
        },
    );
    context.activatePane = vi.fn(
        async (pane: { id: number; workspace: string; pendingWorkspace?: string }) => {
            expect(pane.pendingWorkspace).toBeUndefined();
            context.activePane = pane;
        },
    );
    await context.choose(second, {
        disabled: false,
        value: branch ? "branch-option" : "other",
        selectedOptions: [{ dataset: branch ? { branch: "topic", workspace: "provider" } : {} }],
    });
    expect(context.activatePane).toHaveBeenCalledWith(second);
    expect(context.activePane).toBe(second);
    if (branch) {
        expect(context.openWorkspaceBranch).toHaveBeenCalledWith(
            "topic",
            false,
            "other",
            "1",
            "provider",
        );
        expect(context.changeWorkspace).not.toHaveBeenCalled();
    } else {
        expect(context.changeWorkspace).toHaveBeenCalledWith("other", second);
        expect(context.openWorkspaceBranch).not.toHaveBeenCalled();
    }
    expect(first.draft).toBe(dirtyDraft);
    expect(first.workspace).toBe("main");
});

it("does not switch a removed pane after an asynchronous activation", async () => {
    const activated = deferred<void>();
    const pane = { id: 1, workspace: "main" };
    const context = run(
        [
            "let openingWorkspaceBranch = false;",
            extract(
                "const selectPaneWorkspace =",
                '\ndocument.addEventListener("dooc:workspace-changed"',
            ),
            "globalThis.choose = selectPaneWorkspace;",
        ].join("\n"),
        {
            panes: [pane],
            activePane: pane,
            paneBusy: false,
            activatePane: () => activated.promise,
            syncWorkspaceSelectors: vi.fn(),
            changeWorkspace: vi.fn(),
            openWorkspaceBranch: vi.fn(),
            refreshWorkspaceOptions: vi.fn(),
        },
    );
    const pending = context.choose(pane, {
        disabled: false,
        value: "topic",
        selectedOptions: [{ dataset: { branch: "topic", workspace: "provider" } }],
    });
    context.panes.splice(0, 1);
    activated.resolve();
    await pending;
    expect(context.openWorkspaceBranch).not.toHaveBeenCalled();
    expect(context.changeWorkspace).not.toHaveBeenCalled();
    expect(context.refreshWorkspaceOptions).not.toHaveBeenCalled();
});

it.each([
    "create",
    "",
])("creates a branch from its picker owner only after confirmation: %s", async (answer) => {
    class Field extends EventTarget {
        value = "";
        disabled = false;
        append = vi.fn();
        focus = vi.fn();
        closest = () => ({ querySelector: () => submit });
    }
    const submit = new Field();
    const name = new Field();
    const owner = { id: 1, workspace: "source" };
    const other = { id: 0, workspace: "other" };
    const context = run(
        [
            "let openingWorkspaceBranch = false;",
            extract(
                "const selectPaneWorkspace =",
                '\ndocument.addEventListener("dooc:workspace-changed"',
            ),
            "globalThis.choose = selectPaneWorkspace;",
        ].join("\n"),
        {
            panes: [other, owner],
            activePane: other,
            paneBusy: false,
            document: { createElement: (tag: string) => (tag === "input" ? name : new Field()) },
            showDialog: vi.fn(async () => {
                name.value = "topic/new";
                return answer;
            }),
            syncWorkspaceSelectors: vi.fn(),
            changeWorkspace: vi.fn(),
            openWorkspaceBranch: vi.fn(),
            refreshWorkspaceOptions: vi.fn(),
            setStatus: vi.fn(),
            t: (value: string) => value,
        },
    );
    context.activatePane = vi.fn(async () => {
        context.activePane = owner;
    });
    await context.choose(owner, {
        disabled: false,
        value: "create-option",
        selectedOptions: [{ dataset: { create: "true", workspace: "source" } }],
    });
    expect(context.showDialog).toHaveBeenCalledOnce();
    expect(context.changeWorkspace).not.toHaveBeenCalled();
    if (answer) {
        expect(context.openWorkspaceBranch).toHaveBeenCalledWith(
            "topic/new",
            true,
            "source",
            "1",
            "source",
        );
        expect(context.activatePane).toHaveBeenCalledOnce();
    } else {
        expect(context.openWorkspaceBranch).not.toHaveBeenCalled();
        expect(context.activatePane).not.toHaveBeenCalled();
    }
});

it("retains picker identity across updates and disposes only the collapsed pane's control", () => {
    class SelectNode extends EventTarget {
        id = "";
        dataset: Record<string, string> = {};
        children: SelectNode[] = [];
        value = "";
        title = "";
        textContent = "";
        disabled = false;
        setAttribute = vi.fn();
        remove = vi.fn();
        get selectedOptions() {
            return this.children.filter((option) => option.value === this.value);
        }
        replaceChildren(...children: SelectNode[]) {
            this.children = children;
        }
    }
    const first = { id: 0, workspace: "main" };
    const second = { id: 3, workspace: "feature" };
    const panes = [first, second];
    const host = { dataset: { split: "" }, append: vi.fn() };
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    const mount = vi.fn().mockReturnValueOnce(firstDispose).mockReturnValueOnce(secondDispose);
    const context = run(
        [
            extract("const workspaceOptions =", "const refreshWorkspaceOptions ="),
            "globalThis.sync = syncWorkspaceSelectors; globalThis.pickers = workspacePickers;",
        ].join("\n"),
        {
            panes,
            activePane: second,
            paneBusy: false,
            localWorkspaceLabel: undefined,
            $: () => host,
            document: { createElement: () => new SelectNode() },
            workspaceConnections: () => [
                { id: "main", label: "main/docs" },
                { id: "feature", label: "feature/docs" },
            ],
            mountSelectPickers: mount,
            selectPaneWorkspace: vi.fn(),
            refreshWorkspaceOptions: vi.fn(),
            t: (value: string) => value,
        },
    );
    context.sync();
    const firstSelect = context.pickers.get(0).selector as SelectNode;
    const secondSelect = context.pickers.get(3).selector as SelectNode;
    expect(firstSelect.id).toBe("workspace-select-0");
    expect(secondSelect.id).toBe("workspace-select-3");
    expect(firstSelect.dataset).toMatchObject({ workspacePane: "0", active: "false" });
    expect(secondSelect.dataset).toMatchObject({ workspacePane: "3", active: "true" });
    expect(host.dataset.split).toBe("true");
    firstSelect.dispatchEvent(new Event("docs:picker-open"));
    expect(context.refreshWorkspaceOptions).toHaveBeenCalledWith(first);
    context.paneBusy = true;
    context.sync();
    expect(firstSelect.disabled).toBe(true);
    context.paneBusy = false;
    panes.splice(0, 1);
    context.sync();
    expect(mount).toHaveBeenCalledTimes(2);
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(firstSelect.remove).toHaveBeenCalledOnce();
    expect(secondDispose).not.toHaveBeenCalled();
    expect(context.pickers.get(3).selector).toBe(secondSelect);
    expect(secondSelect.disabled).toBe(false);
    expect(host.dataset.split).toBe("false");
});

it.each([
    true,
    false,
])("preserves edits made during navigation (successful response: %s)", async (ok) => {
    const response = deferred<unknown>();
    const requested = deferred<void>();
    const confirmDialog = vi.fn(async () => false);
    const swapDoc = vi.fn();
    const context = run(
        [
            extract("const confirmLeave =", "\nlet languageButton"),
            extract("const openDoc =", "\nconst scrollToAnchor"),
            extract("let navigationTask:", "\n(window as unknown as { __docsNavigate"),
            "globalThis.run = navigateTo;",
        ].join("\n"),
        {
            boot: { path: "/a", defaultLang: "eng" },
            view: { state: { doc: { version: 1 } } },
            dirty: false,
            autosaveEl: { checked: false },
            conflictPending: false,
            saveTask: undefined,
            paneBusy: false,
            activePane: { workspace: "default" },
            leavingPage: false,
            window: { location: { href: "/a" } },
            textfileWorkspaces: new Map([["default", { flush: async () => {} }]]),
            otherUnsaved: () => false,
            save: vi.fn(),
            confirmDialog,
            swapDoc,
            t: (value: string) => value,
            readFm: () => ({}),
            isResourcePath: () => false,
            workspaceFetch: () => {
                requested.resolve();
                return response.promise;
            },
            localeUrl: (value: string) => value,
            closeResource: vi.fn(),
            confirmFileEditorLeave: async () => true,
            history: { pushState: vi.fn() },
            scrollToAnchor: vi.fn(),
        },
    );
    const pending = context.run("/b");
    await Promise.race([
        requested.promise,
        pending.then(() => {
            throw new Error("Navigation finished without requesting the page");
        }),
    ]);
    context.view.state.doc = { version: 2 };
    context.dirty = true;
    response.resolve({ ok, json: async () => ({ html: "B" }) });
    await pending;
    expect(context.window.location.href).toBe("/a");
    expect(context.leavingPage).toBe(false);
    expect(context.dirty).toBe(true);
    expect(swapDoc).not.toHaveBeenCalled();
    expect(confirmDialog).toHaveBeenCalledTimes(ok ? 0 : 1);
});

it.each([
    "document",
    "frontmatter",
    "pane",
])("keeps a newer %s edit dirty during a save's preview refresh", async (change) => {
    const saved = deferred<unknown>();
    const rendered = deferred<unknown>();
    const requested = deferred<void>();
    let files = {};
    let fm = {};
    const autosave = vi.fn();
    const context = run(
        [
            extract("const render = async", "\n// ── HMR:"),
            extract("const saveCurrent = async", "\nconst refresh = debounce"),
            "globalThis.run = saveCurrent;",
        ].join("\n"),
        {
            boot: { defaultLang: "eng" },
            view: { state: { doc: { version: 1 } } },
            dirty: true,
            baseRaw: "old",
            conflictPending: false,
            renderRevision: 0,
            textfiles: { previewFiles: () => files },
            readFm: () => fm,
            autosaveEl: { checked: true },
            autosave,
            post: (url: string) => {
                if (url === "/api/save") return saved.promise;
                requested.resolve();
                return rendered.promise;
            },
            setSaveState: vi.fn(),
            $: () => ({ setAttribute() {}, removeAttribute() {} }),
            pageWorkspace: () => ({ request: async () => {} }),
            workspaceId: () => "default",
            updateLanguageControls: vi.fn(),
            setStatus: vi.fn(),
            apply: vi.fn(),
            t: (value: string) => value,
        },
    );
    context.setDirty = (value: boolean) => {
        context.dirty = value;
    };
    const pending = context.run();
    files = { "embedded.json": "new value" };
    saved.resolve({ raw: "saved version 1", errors: [], conflict: false });
    await Promise.race([
        requested.promise,
        pending.then(() => {
            throw new Error("Save finished without refreshing changed embedded files");
        }),
    ]);
    if (change === "document") context.view.state.doc = { version: 2 };
    if (change === "frontmatter") fm = { title: "New title" };
    if (change === "pane") context.boot = { defaultLang: "jpn" };
    rendered.resolve({ html: "outdated", errors: [] });
    await pending;
    expect(context.dirty).toBe(true);
    expect(context.baseRaw).toBe("saved version 1");
    expect(autosave).toHaveBeenCalledTimes(change === "pane" ? 0 : 1);
});

it.each([
    ["resource", false],
    ["resource", true],
    ["document", false],
    ["document", true],
])("requires consent to discard a form before %s navigation (discard: %s)", async (kind, discard) => {
    const close = vi.fn();
    const openResource = vi.fn(async () => true);
    const openDoc = vi.fn(async () => true);
    const confirmDialog = vi.fn(async () => discard);
    const context = run(
        [
            extract("const confirmFileEditorLeave =", "\nconst openFileEditor ="),
            extract("let navigationTask:", "\n(window as unknown as { __docsNavigate"),
            "globalThis.run = navigateTo;",
        ].join("\n"),
        {
            paneBusy: false,
            saveTask: undefined,
            confirmDialog,
            t: (value: string) => value,
            isResourcePath: () => kind === "resource",
            openResource,
            openDoc,
            closeResource: vi.fn(),
            confirmLeave: async () => true,
            resourceUrl: (value: string) => value,
            localeUrl: (value: string) => value,
            currentPath: "/b",
            history: { pushState: vi.fn() },
            scrollToAnchor: vi.fn(),
        },
    );
    context.fileEditor = {
        element: {
            matches: () => true,
            dataset: { dirty: "true" },
            querySelector: () => ({
                click: () => {
                    close();
                    context.fileEditor = undefined;
                },
            }),
        },
    };
    await context.run("/b");
    expect(confirmDialog).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledTimes(discard ? 1 : 0);
    expect(openResource).toHaveBeenCalledTimes(discard && kind === "resource" ? 1 : 0);
    expect(openDoc).toHaveBeenCalledTimes(discard && kind === "document" ? 1 : 0);
    expect(context.history.pushState).toHaveBeenCalledTimes(discard ? 1 : 0);
    expect(Boolean(context.fileEditor)).toBe(!discard);
});

it.each([
    false,
    true,
])("protects a form when history returns to the current document (discard: %s)", async (discard) => {
    let popstate!: () => void;
    const closeResource = vi.fn();
    const pushState = vi.fn();
    const context = run(
        [
            extract("const confirmFileEditorLeave =", "\nconst openFileEditor ="),
            extract('window.addEventListener("popstate"', "\nsyncPane();"),
        ].join("\n"),
        {
            window: {
                addEventListener: (_name: string, handler: () => void) => (popstate = handler),
            },
            location: { pathname: "/a", href: "http://localhost/a?lang=eng", hash: "" },
            URL,
            currentPath: "/a",
            boot: { contentLanguage: "eng", defaultLang: "eng" },
            currentUrl: () => "/_subformats?lang=eng&editor=a",
            confirmDialog: async () => discard,
            t: (value: string) => value,
            closeResource,
            scrollToAnchor: vi.fn(),
            history: { pushState },
        },
    );
    context.fileEditor = {
        element: {
            matches: () => true,
            dataset: { dirty: "true" },
            querySelector: () => ({ click: () => (context.fileEditor = undefined) }),
        },
    };
    popstate();
    await vi.waitFor(() => expect(discard ? closeResource : pushState).toHaveBeenCalledOnce());
    expect(closeResource).toHaveBeenCalledTimes(discard ? 1 : 0);
    expect(Boolean(context.fileEditor)).toBe(!discard);
    if (!discard)
        expect(pushState).toHaveBeenCalledWith(null, "", "/_subformats?lang=eng&editor=a");
});
