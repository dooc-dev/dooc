import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { parseSubformatRecord } from "../../src/core/subformat-record.ts";
import { subformatForm } from "../../src/viewer/edit-subformat-form.ts";
import { createTextfileEditors } from "../../src/viewer/edit-textfile.ts";

// Bundle with esbuild and run testSubformatForm() in a browser on a local HTTP origin.
window.testSubformatForm = async () => {
    const assert = (value, message) => {
        if (!value) throw new Error(message);
    };
    const wait = async (check) => {
        for (let i = 0; i < 200; i++) {
            if (check()) return;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`Timed out: ${check}`);
    };
    const schema = {
        type: "object",
        required: ["title", "status"],
        $defs: { status: { type: "string", enum: ["Todo", "Done"] } },
        properties: {
            title: { type: "string", title: "Title", minLength: 1 },
            status: { $ref: "#/$defs/status" },
            count: { type: "integer" },
            active: { type: "boolean" },
            locked: { type: "string", readOnly: true },
            due: { type: "string", format: "date" },
            owner: { type: "object", properties: { name: { type: "string" } } },
            tags: { type: "array", items: { type: "string" } },
        },
    };
    const sources = {
        json: '{"title":"Original","status":"Todo","count":2,"active":false,"locked":"Keep","owner":{"name":"A"},"tags":["one"],"extra":{"keep":true}}\n',
        yaml: "# Keep\ntitle: Original\nstatus: Todo\ncount: 2\nactive: false\nlocked: Keep\ntags: [one]\nowner:\n  name: A\nextra: {keep: true}\n",
        toml: '# Keep\ntitle = "Original"\nstatus = "Todo"\ncount = 2\nactive = false\nlocked = "Keep"\ntags = ["one"]\n[owner]\nname = "A"\n[extra]\nkeep = true\n',
    };
    const originalFetch = window.fetch;
    try {
        for (const [format, initial] of Object.entries(sources)) {
            let content = initial;
            let saves = 0;
            window.fetch = async (_url, options) => {
                const input = JSON.parse(options.body);
                if (input.action === "save") {
                    assert(input.base === content, "Saves compare against the loaded base");
                    try {
                        parseSubformatRecord(input.content, format);
                    } catch {
                        return Response.json({ error: "Invalid record" }, { status: 400 });
                    }
                    content = input.content;
                    saves++;
                }
                return Response.json({ content, schema, language: format });
            };
            const host = document.createElement("div");
            host.style.cssText = "height:600px;width:360px";
            document.body.append(host);
            const outer = new EditorView();
            const editors = createTextfileEditors(
                [],
                () => {},
                () => {},
            );
            const file = `record.${format}`;
            let dispose = editors.mount(file, host, outer);
            const mode = () => host.querySelector("[data-record-mode]");
            const field = (...path) =>
                [...host.querySelectorAll("[data-record-path]")].find(
                    (node) => node.dataset.recordPath === JSON.stringify(path),
                );
            const edit = (input, value) => {
                input.focus();
                input.value = value;
                input.dispatchEvent(
                    new Event(input instanceof HTMLSelectElement ? "change" : "input", {
                        bubbles: true,
                    }),
                );
            };
            try {
                await wait(() => mode()?.dataset.recordMode === "form");
                const inner = EditorView.findFromDOM(
                    host.querySelector(".cm-textfile-editor .cm-content"),
                );
                assert(
                    inner.dom.hidden && mode().getAttribute("aria-pressed") === "true",
                    `${format}: form opens by default`,
                );
                assert(
                    field("title").value === "Original" && field("locked").disabled,
                    "Values, labels and read-only fields follow the schema",
                );
                mode().click();
                assert(
                    !inner.dom.hidden && editors.content(file) === initial && saves === 0,
                    "Switching modes leaves the source unchanged",
                );
                mode().click();
                edit(field("title"), "Edited");
                assert(
                    document.activeElement !== inner.contentDOM,
                    "Form edits do not focus the hidden code editor",
                );
                edit(field("status"), "1");
                edit(field("count"), "0");
                edit(field("active"), "0");
                edit(field("owner", "name"), "B");
                field("due").closest(".date-control").querySelector(".date-trigger").click();
                const day = host.querySelector(
                    '.date-picker [data-date]:not([data-outside="true"])',
                );
                const due = day.dataset.date;
                day.click();
                edit(field("tags"), '["one", "two"]');
                await editors.flush();
                const data = parseSubformatRecord(content, format);
                assert(
                    data.title === "Edited" &&
                        data.status === "Done" &&
                        data.count === 0 &&
                        data.active === true &&
                        data.due === due &&
                        data.owner.name === "B",
                    "Typed form edits use the shared autosave draft",
                );
                assert(
                    data.extra.keep && data.tags.length === 2 && data.locked === "Keep",
                    "Other fields remain intact",
                );
                if (format !== "json")
                    assert(content.includes("# Keep"), "Comments survive form edits");
                undo(inner);
                await editors.flush();
                assert(
                    parseSubformatRecord(content, format).tags.length === 1,
                    "Form edits share code undo history",
                );
                mode().click();
                const changed = inner.state.doc.toString().replace("Edited", "From text");
                inner.dispatch({
                    changes: { from: 0, to: inner.state.doc.length, insert: changed },
                });
                mode().click();
                assert(field("title").value === "From text", "Text edits reach the form");
                edit(field("tags"), "[");
                mode().click();
                assert(
                    inner.dom.hidden && field("tags").value === "[",
                    "Invalid field JSON stays visible until corrected",
                );
                await editors.flush();
                assert(
                    editors.hasUnsavedChanges(),
                    "Incomplete form fields count as unsaved drafts",
                );
                dispose();
                host.replaceChildren();
                dispose = editors.mount(file, host, outer);
                await wait(() => mode()?.dataset.recordMode === "form");
                assert(
                    field("tags").value === "[" && !field("tags").checkValidity(),
                    "Remounting preserves incomplete field text and its error",
                );
                edit(field("tags"), '["recovered"]');
                await editors.flush();
                assert(
                    !editors.hasUnsavedChanges(),
                    "Correcting the field clears the unsaved form draft",
                );
                assert(
                    field("title").value === "From text",
                    "Remounting retains the draft and selected mode",
                );
                const reopened = EditorView.findFromDOM(
                    host.querySelector(".cm-textfile-editor .cm-content"),
                );
                mode().click();
                reopened.dispatch({
                    changes: { from: 0, to: reopened.state.doc.length, insert: "[" },
                });
                mode().click();
                assert(
                    !reopened.dom.hidden && editors.content(file) === "[",
                    "Invalid source cannot be discarded by switching to the form",
                );
                await editors.flush();
                assert(editors.hasUnsavedChanges(), "Failed validation retains the unsaved draft");
                const external = content.replace("From text", "External");
                reopened.dispatch({
                    changes: { from: 0, to: reopened.state.doc.length, insert: content },
                });
                await editors.flush();
                content = external;
                await editors.reloadChanged([file]);
                await wait(() => mode());
                mode().click();
                assert(field("title").value === "External", "External file changes reach the form");
            } finally {
                dispose();
                outer.destroy();
                host.remove();
                document.querySelector(".subformat-toast")?.remove();
            }
        }
        return "Passed: JSON/YAML/TOML form/text switching, typed and nested fields, local refs, read-only fields, autosave, comments, undo, remount, invalid drafts and external changes";
    } finally {
        window.fetch = originalFetch;
    }
};

window.testReferencedEnumForm = async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const schema = {
        type: "object",
        properties: { choice: { $ref: "common.schema.json#/$defs/choice" } },
    };
    const view = new EditorView({
        parent: host,
        doc: '{"choice":{"id":1}}',
        extensions: [
            subformatForm(schema, "json", {
                uri: "file:///schemas/record.schema.json",
                schemas: {
                    "file:///schemas/common.schema.json": {
                        $defs: { choice: { $ref: "https://schemas.example.com/choice.json" } },
                    },
                    "https://schemas.example.com/choice.json": {
                        type: "object",
                        properties: {},
                        enum: [{ id: 1 }, { id: 2 }],
                    },
                },
            }),
        ],
    });
    try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const select = host.querySelector("select[data-record-path]");
        if (!select || select.value !== "0")
            throw new Error("Referenced object enums must use a selected choice control");
        select.value = "1";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        if (JSON.parse(view.state.doc.toString()).choice.id !== 2)
            throw new Error("Choosing a referenced object enum must preserve its JSON type");
        return "Passed: file and HTTPS refs, object enum choices and typed changes";
    } finally {
        view.destroy();
        host.remove();
    }
};

window.testSubformatDatePicker = async () => {
    const assert = (value, message) => {
        if (!value) throw new Error(message);
    };
    const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
    const host = document.createElement("div");
    host.style.cssText = "width:340px;max-width:100%;height:540px";
    document.body.append(host);
    const schema = {
        type: "object",
        properties: {
            due: { type: "string", format: "date" },
            locked: { type: "string", format: "date", readOnly: true },
            choice: { type: "string", format: "date", enum: ["2024-01-01", "2024-01-02"] },
        },
    };
    const view = new EditorView({
        parent: host,
        doc: '{"due":"2024-01-31","locked":"2024-01-01"}',
        extensions: [subformatForm(schema, "json")],
    });
    const input = () => host.querySelector("[data-record-date]");
    const popup = () => host.querySelector(".date-picker");
    const open = async () => {
        host.querySelector(".date-trigger").click();
        await tick();
    };
    const key = (key, extra = {}) =>
        document.activeElement.dispatchEvent(
            new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }),
        );
    try {
        await tick();
        const choice = host.querySelector("select[data-record-path]");
        choice.value = "1";
        choice.dispatchEvent(new Event("change", { bubbles: true }));
        assert(
            JSON.parse(view.state.doc.toString()).choice === "2024-01-02",
            "Date enums keep their choice control and save a date string",
        );
        assert(
            host.querySelectorAll(".date-trigger")[1].disabled,
            "Read-only date fields cannot open the calendar",
        );
        await open();
        assert(
            document.activeElement.dataset.date === "2024-01-31",
            "Opening focuses the selected day",
        );
        key("PageDown");
        assert(
            document.activeElement.dataset.date === "2024-02-29",
            "Month navigation clamps to leap day",
        );
        key("PageDown", { shiftKey: true });
        assert(
            document.activeElement.dataset.date === "2025-02-28",
            "Year navigation clamps to the last valid day",
        );
        key("ArrowRight");
        assert(
            document.activeElement.dataset.date === "2025-03-01",
            "Arrow navigation crosses month boundaries",
        );
        document.activeElement.click();
        assert(
            JSON.parse(view.state.doc.toString()).due === "2025-03-01" &&
                document.activeElement === input() &&
                !popup().matches(":popover-open"),
            "Selection saves an ISO date and restores input focus",
        );
        await open();
        key("Escape");
        assert(
            !popup().matches(":popover-open") && document.activeElement === input(),
            "Escape dismisses without changing the date",
        );
        input().value = "2026-02-30";
        input().dispatchEvent(new Event("input", { bubbles: true }));
        assert(
            !input().checkValidity() && JSON.parse(view.state.doc.toString()).due === "2025-03-01",
            "Invalid dates remain drafts and do not overwrite the source",
        );
        await open();
        popup().querySelector(".date-picker-footer button").click();
        const today = new Date();
        const expected = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        assert(
            input().value === expected && input().checkValidity(),
            "Today uses the local date and clears an invalid draft",
        );
        await open();
        popup().querySelector(".date-picker-footer button:last-child").click();
        assert(
            JSON.parse(view.state.doc.toString()).due === "",
            "Clear updates the same form field",
        );
        await open();
        document.body.click();
        host.querySelector("[data-record-mode]").click();
        assert(
            !host.querySelector(".date-picker:popover-open"),
            "Switching to source mode removes the calendar",
        );
        host.querySelector("[data-record-mode]").click();
        await tick();
        assert(
            host.querySelectorAll(".date-control").length === 2,
            "Remounting does not duplicate date controls",
        );
        return "Passed: date selection, leap years, keyboard navigation, focus, invalid drafts, today/clear, read-only fields and mode switching";
    } finally {
        view.destroy();
        host.remove();
    }
};
