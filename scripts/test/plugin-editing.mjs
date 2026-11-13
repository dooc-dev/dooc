import { mountPlugins } from "../../packages/frontend/src/plugins-ui.ts";

// Bundle with esbuild and run testPluginEditing() in a browser on a local HTTP origin.
window.testPluginEditing = async () => {
    const assert = (condition, message) => {
        if (!condition) throw new Error(message);
    };
    const wait = async (test) => {
        for (let i = 0; i < 200; i++) {
            if (test()) return;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(`Timed out: ${test.toString()}`);
    };
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    document.body.innerHTML =
        '<main><div data-embed-url="https://service.example/issue/1">Issue</div></main>';
    let title = "Initial title",
        description = "Initial description",
        status = "open",
        version = 1;
    let reads = 0,
        writes = [],
        fail = false,
        release,
        hold = false,
        reading,
        holdRead = false;
    const fields = () => [
        { name: "title", label: "Title", type: "text", value: title, required: true },
        { name: "description", label: "Description", type: "textarea", value: description },
        {
            name: "status",
            label: "Status",
            type: "select",
            value: status,
            options: [
                { value: "open", label: "Open" },
                { value: "done", label: "Done" },
            ],
        },
    ];
    const view = () => ({
        header: { title: "Example", reference: "ISSUE-1" },
        blocks: [
            { type: "heading", text: title, edit: { action: "update", field: "title" } },
            { type: "text", text: description, edit: { action: "update", field: "description" } },
            {
                type: "fields",
                items: [
                    {
                        label: "Status",
                        items: [status],
                        edit: { action: "update", field: "status" },
                    },
                ],
            },
            { type: "section", title: "Details", blocks: [{ type: "text", text: "Details" }] },
            { type: "actions", ids: ["comment"], composer: true },
        ],
    });
    const originalFetch = window.fetch,
        OriginalEvents = window.EventSource,
        originalInterval = window.setInterval;
    window.setInterval = (fn, ms, ...args) => originalInterval(fn, ms === 5000 ? 150 : ms, ...args);
    window.EventSource = class {
        constructor() {
            setTimeout(() => this.onmessage?.({ data: "test" }), 0);
        }
    };
    window.fetch = async (_url, init) => {
        const request = JSON.parse(init.body);
        if (request.action === "resolve") return Response.json({ plugin: "example" });
        if (request.action === "read") {
            reads++;
            if (holdRead) {
                holdRead = false;
                await new Promise((resolve) => {
                    reading = resolve;
                });
            }
            return Response.json({ view: view(), user: { name: "Test" } });
        }
        if (request.action === "actions")
            return Response.json({
                actions: [
                    {
                        id: "update",
                        label: "Update",
                        target: "Issue",
                        fields: fields(),
                        partial: true,
                        version: String(version),
                    },
                    {
                        id: "comment",
                        label: "Post comment",
                        target: "Issue",
                        fields: [
                            { name: "body", label: "Comment", type: "textarea", required: true },
                        ],
                    },
                    { id: "archive", label: "Archive", target: "Issue", fields: [] },
                ],
            });
        if (request.action === "act") {
            writes.push(request);
            if (hold) {
                hold = false;
                await new Promise((resolve) => {
                    release = resolve;
                });
            }
            if (fail) return Response.json({ error: "Connection unavailable" }, { status: 503 });
            if (request.operation.id === "update") {
                if (request.operation.version !== String(version))
                    return Response.json({ error: "Content changed" }, { status: 409 });
                title = request.operation.values.title ?? title;
                description = request.operation.values.description ?? description;
                status = request.operation.values.status ?? status;
                version++;
            }
            return Response.json({ result: { message: "Saved" } });
        }
        throw new Error(`Unexpected request ${request.action}`);
    };
    try {
        mountPlugins();
        await wait(() => document.querySelector('[data-plugin-action="read"]'));
        document.querySelector('[data-plugin-action="read"]').click();
        await wait(() => document.querySelector('[data-actions-ready="true"]'));
        const card = document.querySelector("[data-plugin]");
        const edit = card.querySelector('[data-plugin-action="edit"]');
        assert(
            [...card.querySelectorAll(".plugin-toolbar [data-plugin-action]")]
                .map((e) => e.dataset.pluginAction)
                .join() === "open,copy,edit,fold",
            "Toolbar order",
        );
        assert(
            !card.querySelector(".plugin-reload,.plugin-action-menu,.plugin-editor"),
            "Read mode must not expose editors or old toolbar controls",
        );
        assert(
            [...card.querySelectorAll("[data-block-action] button")].every((e) => e.disabled),
            "Read mode must gate actions",
        );
        await wait(() => !edit.disabled);
        const height = card.getBoundingClientRect().height;
        edit.click();
        await wait(() => card.dataset.editing === "true");
        const titleInput = () => card.querySelector('input[name="title"]');
        const bodyInput = () => card.querySelector('textarea[name="description"]');
        const set = (input, value) => {
            input.focus();
            input.value = value;
            input.dispatchEvent(new Event("input", { bubbles: true }));
        };
        const open = (name) => {
            const target = [...card.querySelectorAll("[data-block-edit]")].find(
                (element) => JSON.parse(element.dataset.blockEdit).field === name,
            );
            target
                .querySelector("[data-plugin-edit-trigger]")
                .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        };
        assert(!titleInput() && !bodyInput(), "Edit mode must keep the rendered layout");
        assert(
            card.getBoundingClientRect().height === height,
            "Edit mode must not change card height",
        );
        open("title");
        assert(
            titleInput() && !bodyInput(),
            "Only the double-clicked value should become editable",
        );
        assert(
            ![...card.querySelectorAll("button")].some((e) =>
                ["Save", "Cancel"].includes(e.textContent),
            ),
            "No Save/Cancel controls",
        );
        set(titleInput(), "First title");
        titleInput().setSelectionRange(3, 3);
        await wait(() => title === "First title");
        assert(
            document.activeElement === titleInput() && titleInput().selectionStart === 3,
            "Autosave must preserve focus and selection",
        );
        const initialWrites = writes.length;
        set(titleInput(), "First title");
        await pause(700);
        assert(writes.length === initialWrites, "Unchanged values must not save");
        set(titleInput(), "");
        await pause(700);
        assert(writes.length === initialWrites, "Invalid values must not save");
        titleInput().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        set(titleInput(), "変換中");
        await pause(700);
        assert(writes.length === initialWrites, "IME composition must not save");
        titleInput().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
        await wait(() => title === "変換中");
        hold = true;
        set(titleInput(), "Slow save");
        await wait(() => release);
        assert(!card.textContent.includes("Saving"), "Saving must not flash a status message");
        set(titleInput(), "Typed during save");
        open("description");
        set(bodyInput(), "Another field during save");
        await pause(700);
        release();
        release = undefined;
        await wait(
            () => title === "Typed during save" && description === "Another field during save",
        );
        assert(
            writes
                .slice(-3)
                .every(
                    (r, i, a) =>
                        i === 0 || Number(r.operation.version) > Number(a[i - 1].operation.version),
                ),
            "Queued writes need current versions",
        );
        open("status");
        const select = card.querySelector('select[name="status"]');
        select.value = "done";
        select.dispatchEvent(new Event("input", { bubbles: true }));
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await wait(() => status === "done");
        fail = true;
        open("title");
        set(titleInput(), "Keep failed input");
        await wait(() => card.dataset.operationError === "true");
        assert(titleInput().value === "Keep failed input", "Failed saves must retain input");
        const failedId = writes.at(-1).requestId;
        await wait(() => !edit.disabled);
        edit.click();
        assert(
            edit.getAttribute("aria-pressed") === "true",
            "Failed draft must prevent leaving edit mode",
        );
        fail = false;
        set(titleInput(), "Keep failed input");
        await wait(() => title === "Keep failed input");
        assert(writes.at(-1).requestId === failedId, "Retries must reuse the request ID");
        title = "External conflict";
        version++;
        set(titleInput(), "Local conflict");
        await wait(() => card.dataset.operationError === "true");
        assert(
            title === "External conflict" && titleInput().value === "Local conflict",
            "Conflicts must not overwrite either value",
        );
        set(titleInput(), "Deliberately revised");
        await wait(() => title === "Deliberately revised");
        await wait(() => !edit.disabled);
        edit.click();
        await wait(() => !card.querySelector(".plugin-editor"));
        assert(edit.getAttribute("aria-pressed") === "false", "Edit mode should turn off");
        card.querySelector(".plugin-block-section").open = false;
        title = "External update";
        version++;
        await wait(() => card.querySelector(".plugin-block-heading").textContent === title);
        assert(
            !card.querySelector(".plugin-block-section").open,
            "Monitoring must preserve collapsed sections",
        );
        await wait(() => !edit.disabled);
        edit.click();
        await wait(() => card.dataset.editing === "true");
        holdRead = true;
        await wait(() => reading);
        open("title");
        set(titleInput(), "Draft during refresh");
        reading();
        reading = undefined;
        assert(
            titleInput().value === "Draft during refresh",
            "An in-flight refresh must not discard input",
        );
        await wait(() => title === "Draft during refresh");
        await wait(() => !edit.disabled);
        card.querySelector('[data-block-action="comment"] button').click();
        await wait(() => card.querySelector('[data-block-action="comment"] textarea'));
        const composer = card.querySelector('[data-block-action="comment"] textarea');
        set(composer, "Comment draft");
        const count = writes.length;
        await pause(700);
        assert(writes.length === count, "Comments must wait for an explicit post");
        composer.form.requestSubmit();
        await wait(() => writes.some((request) => request.operation.id === "comment"));
        document.dispatchEvent(new CustomEvent("docs:plugin-connection", { detail: "example" }));
        assert(
            !card.dataset.ready && !card.querySelector(".plugin-block-heading"),
            "Account changes must clear private card content",
        );
        card.remove();
        await pause(300);
        const stopped = reads;
        await pause(350);
        assert(reads === stopped, "Detached cards must stop watching");
        return {
            assertions:
                "toolbar, edit gating, autosave, validation, IME, queued writes, focus, conflicts, retry IDs, polling, drafts, explicit posts, account changes, disposal",
            writes: writes.length,
            reads,
        };
    } finally {
        window.dispatchEvent(new Event("pagehide"));
        window.fetch = originalFetch;
        window.EventSource = OriginalEvents;
        window.setInterval = originalInterval;
    }
};
