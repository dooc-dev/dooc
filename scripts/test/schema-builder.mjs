import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { SUBFORMAT_SCHEMA_TEMPLATE } from "../../packages/engine/src/core/subformats.ts";
import { jsonEditor } from "../../packages/frontend/src/edit-json.ts";
import {
    hasSchemaBuilderDraft,
    prepareSchemaBuilder,
} from "../../packages/frontend/src/edit-schema-builder.ts";
import { editorSetup } from "../../packages/frontend/src/edit-setup.ts";
import { createTextfileEditors } from "../../packages/frontend/src/edit-textfile.ts";

window.testSchemaBuilder = async () => {
    const assert = (value, message) => {
        if (!value) throw new Error(message);
    };
    const host = document.createElement("div");
    host.style.cssText = "height:650px;width:620px;max-width:100%;";
    document.body.append(host);
    const originalFetch = window.fetch;
    window.fetch = async (url, options) =>
        url === "/api/subformat" ? Response.json({}) : originalFetch(url, options);
    const view = new EditorView({
        parent: host,
        doc: SUBFORMAT_SCHEMA_TEMPLATE,
        extensions: [editorSetup, jsonEditor(undefined, true)],
    });
    const update = (input, value) => {
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const schema = () => JSON.parse(view.state.doc.toString());
    const row = (name) =>
        [...host.querySelectorAll("[data-schema-field]")].find(
            (e) => e.dataset.schemaField === JSON.stringify(["properties", name]),
        );
    const mode = (name) => {
        const toggle = host.querySelector("[data-schema-mode]");
        if (toggle.dataset.schemaMode !== name) toggle.click();
    };
    const add = (name, type = "string", parent = host.querySelector(".schema-builder")) => {
        const form = parent.querySelector(
            ":scope > .schema-add-field, :scope > .schema-children > .schema-add-field",
        );
        update(form.querySelector("input"), name);
        form.querySelector("select").value = type;
        form.querySelector("[data-schema-add]").click();
    };
    const parameter = (node, name) => {
        node.querySelector('[data-schema-menu="Parameters"]').click();
        [...node.querySelectorAll('[role="menuitem"]')]
            .find((item) => item.textContent === name)
            .click();
    };
    try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert(view.dom.hidden, "New schemas open in Build kit");
        assert(Object.keys(schema().properties).length === 0, "New schemas have no fields");
        assert(
            host.querySelectorAll("[data-schema-mode]").length === 1,
            "A single icon toggles modes",
        );
        assert(
            host.querySelector('[data-schema-mode="build"]').getAttribute("aria-pressed") ===
                "true",
            "The selected mode is announced",
        );
        const draftForm = () => host.querySelector(".schema-builder > .schema-add-field");
        for (const node of [draftForm(), host.querySelector(".schema-root-settings")]) {
            assert(
                node.querySelectorAll("[data-schema-menu]").length === 1,
                "One parameter menu per schema",
            );
            const names = [...node.querySelectorAll('[role="menuitem"]')].map(
                (item) => item.textContent,
            );
            assert(
                names.includes("enum") && names.includes("description"),
                "Rules and annotations share one menu",
            );
        }
        const beforeDraft = view.state.doc.toString();
        update(draftForm().querySelector("select"), "array");
        let draftItems = host.querySelector(".schema-draft-details [data-schema-field]");
        assert(
            draftItems && hasSchemaBuilderDraft(view.state),
            "Choosing array opens its items before a field is named",
        );
        assert(
            view.state.doc.toString() === beforeDraft,
            "Unnamed draft structure stays out of JSON",
        );
        update(draftItems.querySelector("select"), "object");
        draftItems = host.querySelector(".schema-draft-details [data-schema-field]");
        add("child", "string", draftItems.querySelector(".schema-field-details"));
        assert(!prepareSchemaBuilder(view.state), "Saving stops for a missing draft name");
        assert(
            draftForm().querySelector("input").getAttribute("aria-invalid") === "true",
            "Saving highlights the missing name",
        );
        update(draftForm().querySelector("input"), "drafted");
        assert(prepareSchemaBuilder(view.state), "Naming the draft lets saving commit it");
        assert(
            schema().properties.drafted.items.properties.child.type === "string" &&
                !hasSchemaBuilderDraft(view.state),
            "Saving preserves the prepared nested structure",
        );
        row("drafted").querySelector('[aria-label="Remove field: drafted"]').click();
        update(draftForm().querySelector("select"), "object");
        const nestedDraft = host.querySelector(".schema-draft-details .schema-add-field");
        update(nestedDraft.querySelector("select"), "array");
        assert(
            !prepareSchemaBuilder(view.state) &&
                host.querySelectorAll('input[aria-invalid="true"]').length === 2,
            "All missing nested names are highlighted together",
        );
        draftForm().querySelector('[aria-label="Cancel"]').click();
        assert(
            !hasSchemaBuilderDraft(view.state) && !host.querySelector(".schema-draft-details"),
            "Cancel discards a draft and its incomplete descendants",
        );
        add("title");
        add("status");
        row("status").querySelector('input[type="checkbox"]').click();
        assert(
            !row("status").querySelector("[data-schema-keyword]"),
            "Parameters start hidden until added",
        );
        parameter(row("status"), "enum");
        update(row("status").querySelector('textarea[data-schema-focus$=":enum"]'), "Todo\nDone");
        update(row("status").querySelector('[aria-label="Field name"]'), "stage");
        assert(
            schema().required.includes("stage") && !schema().required.includes("status"),
            "Renaming updates required",
        );
        assert(schema().properties.stage.enum.join(",") === "Todo,Done", "Choice edits reach JSON");
        add("owner", "object");
        row("owner").querySelector(".schema-expand").click();
        add("email", "string", row("owner").querySelector(".schema-field-details"));
        assert(
            schema().properties.owner.properties.email.type === "string",
            "Nested properties can be added",
        );
        add("tags", "array");
        parameter(row("tags"), "minItems");
        assert(
            !row("tags").querySelector('[data-schema-keyword="maxItems"]'),
            "Adding min does not automatically add max",
        );
        update(row("tags").querySelector('[data-schema-keyword="minItems"]'), "1");
        assert(
            schema().properties.tags.items.type === "string" &&
                schema().properties.tags.minItems === 1,
            "Arrays retain items and bounds",
        );
        const itemPath = JSON.stringify(["properties", "tags", "items"]);
        const item = () =>
            [...host.querySelectorAll("[data-schema-field]")].find(
                (node) => node.dataset.schemaField === itemPath,
            );
        update(item().querySelector("select"), "array");
        assert(
            item().querySelector("[data-schema-field]"),
            "Nested array items keep their own tree row",
        );
        parameter(item(), "description");
        update(item().querySelector('[data-schema-keyword="description"]'), "Nested items");
        assert(
            schema().properties.tags.items.description === "Nested items",
            "Parameters reach the correct nested schema",
        );
        item().querySelector('[aria-label="Remove parameter: description"]').click();
        assert(
            !schema().properties.tags.items.description,
            "Parameters can be removed without removing the field",
        );
        row("tags").querySelector(".schema-expand").click();
        assert(
            row("tags").querySelector(".schema-field-details").hidden,
            "Collapsing a branch hides its descendants",
        );
        mode("json");
        assert(
            !view.dom.hidden && host.querySelector(".schema-builder").hidden,
            "One click shows JSON text",
        );
        const advanced = {
            ...schema(),
            $defs: { code: { type: "string", pattern: "^[A-Z]+$" } },
            allOf: [{ properties: { stage: { minLength: 1, type: "string" } } }],
        };
        view.dispatch({
            changes: {
                from: 0,
                to: view.state.doc.length,
                insert: JSON.stringify(advanced, null, 2),
            },
        });
        mode("build");
        assert(
            row("stage").querySelector('[aria-label="Field name"]').readOnly,
            "Linked names stay protected",
        );
        const before = view.state.doc.toString();
        mode("json");
        mode("build");
        assert(view.state.doc.toString() === before, "Mode switches never rewrite JSON");
        parameter(row("title"), "description");
        update(
            row("title").querySelector('[data-schema-keyword="description"]'),
            "Updated in Build kit",
        );
        assert(
            JSON.stringify(schema().allOf) === JSON.stringify(advanced.allOf) &&
                JSON.stringify(schema().$defs) === JSON.stringify(advanced.$defs),
            "Editing preserves advanced rules",
        );
        mode("json");
        undo(view);
        assert(!schema().properties.title.description, "Build kit edits share JSON undo history");
        view.dispatch({
            changes: {
                from: 0,
                to: view.state.doc.length,
                insert: JSON.stringify({
                    type: "object",
                    properties: {
                        title: {
                            type: "string",
                            minLength: 1,
                            maxLength: 30,
                            pattern: "^a",
                            format: "email",
                            enum: ["a"],
                            description: "Title",
                        },
                        count: {
                            type: "number",
                            minimum: 0,
                            maximum: 100,
                            exclusiveMinimum: 1,
                            exclusiveMaximum: 99,
                            multipleOf: 2,
                        },
                        tags: {
                            type: "array",
                            minItems: 1,
                            maxItems: 5,
                            uniqueItems: true,
                            items: { type: "string", minLength: 1, maxLength: 20 },
                        },
                        owner: { type: "object", minProperties: 1, maxProperties: 3 },
                        partial: { type: "number", minimum: 0, exclusiveMaximum: 10 },
                        negative: { type: "number", maximum: -2.5 },
                    },
                }),
            },
        });
        mode("build");
        for (const toggle of host.querySelectorAll('.schema-expand[aria-expanded="false"]'))
            toggle.click();
        const parameterBox = (name, key) =>
            row(name).querySelector(`[data-schema-keyword="${key}"]`).closest(".schema-parameter");
        for (const width of [820, 340]) {
            host.style.width = `${width}px`;
            await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
            );
            for (const [name, min, max] of [
                ["title", "minLength", "maxLength"],
                ["count", "minimum", "maximum"],
                ["count", "exclusiveMinimum", "exclusiveMaximum"],
                ["tags", "minItems", "maxItems"],
                ["owner", "minProperties", "maxProperties"],
            ]) {
                const left = parameterBox(name, min).getBoundingClientRect();
                const right = parameterBox(name, max).getBoundingClientRect();
                assert(
                    left.top === right.top && right.left > left.right,
                    `${min}/${max} share a row at ${width}px`,
                );
            }
            const independent = ["maxLength", "pattern", "format", "enum"].map((key) =>
                parameterBox("title", key).getBoundingClientRect(),
            );
            assert(
                independent.every(
                    (box, index) => !index || box.top > independent[index - 1].bottom,
                ),
                "Unrelated constraints use separate rows",
            );
            assert(
                parameterBox("partial", "minimum").getBoundingClientRect().bottom <
                    parameterBox("partial", "exclusiveMaximum").getBoundingClientRect().top,
                "Incomplete bound pairs stay separate",
            );
            for (const field of host.querySelectorAll(".schema-field-row")) {
                const collapse = field.querySelector(".schema-expand").getBoundingClientRect();
                assert(
                    Math.abs(collapse.right - field.getBoundingClientRect().right) < 1,
                    "Collapse stays at the right edge, including Items",
                );
                assert(
                    field.querySelectorAll("[data-schema-menu]").length === 1,
                    "Fields and array items use a single parameter menu",
                );
            }
            for (const group of host.querySelectorAll(
                ".schema-field > .schema-field-details > .schema-parameter-group",
            )) {
                const field = group.parentElement.parentElement
                    .querySelector(".schema-field-row")
                    .getBoundingClientRect();
                const box = group.getBoundingClientRect();
                assert(
                    box.left >= field.left + 24 && box.top >= field.bottom + 8,
                    "Fixed parameters are indented and spaced below their field name",
                );
            }
            assert(
                row("title")
                    .querySelector('[data-schema-keyword="enum"]')
                    .closest(".schema-parameter-group") ===
                    row("title")
                        .querySelector('[data-schema-keyword="description"]')
                        .closest(".schema-parameter-group"),
                "Validation and descriptive parameters use the same settings block",
            );
            const panel = host.querySelector(".schema-builder");
            assert(panel.scrollWidth === panel.clientWidth, `No horizontal overflow at ${width}px`);
        }
        host.style.width = "820px";
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const typeLeft = (element) =>
            element
                .querySelector(":scope > .schema-field-row > label:last-of-type")
                .getBoundingClientRect().left;
        assert(
            typeLeft(row("title")) === typeLeft(row("tags")) &&
                typeLeft(item()) > typeLeft(row("tags")),
            "Types align within a level and follow the indentation of nested Items",
        );
        assert(
            typeLeft(row("title")) ===
                host
                    .querySelector(".schema-builder > .schema-add-field > label:last-of-type")
                    .getBoundingClientRect().left,
            "New fields use the same type column",
        );
        const itemRow = item().querySelector(":scope > .schema-field-row");
        const itemName = itemRow.querySelector(".schema-item-name").getBoundingClientRect();
        const itemType = itemRow.querySelector("label").getBoundingClientRect();
        assert(
            Math.abs(itemName.top - itemType.top) < 1,
            "Items and its type share one compact row",
        );
        assert(
            getComputedStyle(item()).borderBottomWidth === "0px",
            "Tree nodes have no extra separator lines",
        );
        assert(
            parseFloat(getComputedStyle(item(), "::before").height) <
                item().querySelector(".schema-field-row").getBoundingClientRect().height,
            "The last tree branch ends at its own row instead of extending through its descendants",
        );
        const number = (name, key) => row(name).querySelector(`[data-schema-keyword="${key}"]`);
        const slider = (name, key) =>
            row(name).querySelector(`input[type="range"][aria-label="${key}"]`);
        assert(
            row("title").querySelectorAll(".schema-range-track").length === 1,
            "A bound pair shares one track",
        );
        assert(
            !Object.hasOwn(schema().properties.partial, "maximum"),
            "Showing an unbounded endpoint does not write a bound",
        );
        assert(
            !number("negative", "minimum") && !slider("negative", "maximum"),
            "A single maximum stays an independent input",
        );
        parameter(row("negative"), "minimum");
        update(number("negative", "minimum"), "-10");
        assert(
            !slider("negative", "maximum").disabled,
            "Adding both negative bounds enables their shared track",
        );
        slider("title", "minLength").value = "4";
        slider("title", "minLength").dispatchEvent(new Event("input", { bubbles: true }));
        assert(
            number("title", "minLength").value === "4" && schema().properties.title.minLength === 1,
            "Dragging previews the number before committing",
        );
        slider("title", "minLength").dispatchEvent(new Event("change", { bubbles: true }));
        assert(schema().properties.title.minLength === 4, "A slider commit updates JSON");
        update(number("count", "minimum"), "-12.5");
        update(number("count", "maximum"), "1000.5");
        assert(
            slider("count", "minimum").value === "-12.5" &&
                Number(slider("count", "maximum").max) > 1000.5,
            "Direct entry retains decimals and expands the slider scale",
        );
        slider("count", "minimum").value = slider("count", "minimum").max;
        slider("count", "minimum").dispatchEvent(new Event("input", { bubbles: true }));
        slider("count", "minimum").dispatchEvent(new Event("change", { bubbles: true }));
        assert(
            schema().properties.count.minimum === schema().properties.count.maximum,
            "Handles cannot cross",
        );
        row("count").querySelector('[aria-label="Remove parameter: maximum"]').click();
        assert(
            !Object.hasOwn(schema().properties.count, "maximum") &&
                !number("count", "maximum") &&
                !slider("count", "minimum"),
            "Removing a bound hides it and leaves the other independently editable",
        );
        assert(
            !host.querySelector(".schema-group-label"),
            "Parameter groups do not repeat text headings",
        );
        assert(
            row("title").querySelector('.schema-field-name [data-schema-menu="Parameters"]'),
            "Parameter icons sit beside their field name",
        );
        assert(
            row("title").querySelector('.schema-field-actions [aria-label="Remove field: title"]'),
            "Delete is grouped at the right edge of its field row",
        );
        assert(
            row("title").querySelector(".schema-required").textContent === "Required",
            "The required checkbox has a visible label",
        );
        const extra = () => host.querySelector(".schema-extra-fields input");
        const border = getComputedStyle(extra()).borderColor;
        extra().click();
        assert(
            schema().additionalProperties === false &&
                getComputedStyle(extra()).borderColor === border,
            "Allow extra fields toggles without recoloring its border",
        );
        mode("json");
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '{"type":' } });
        mode("build");
        assert(
            !view.dom.hidden && view.state.doc.toString() === '{"type":',
            "Invalid JSON remains editable without losing text",
        );
        assert(
            document.querySelector(".subformat-toast"),
            "Invalid switches show an overlay error",
        );
        return "Passed: default Build kit, fields/types/required/enum, nested objects, arrays, one-click JSON roundtrip, advanced rules, undo, grouped constraints, responsive alignment, right-side collapse, neutral checkboxes, invalid JSON preservation";
    } finally {
        view.destroy();
        host.remove();
        document.querySelector(".subformat-toast")?.remove();
        window.fetch = originalFetch;
    }
};

window.testSchemaDraftSaving = async () => {
    const assert = (value, message) => {
        if (!value) throw new Error(message);
    };
    const wait = async (test) => {
        for (let i = 0; i < 100; i++) {
            if (test()) return;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("Timed out waiting for the schema editor");
    };
    let content = SUBFORMAT_SCHEMA_TEMPLATE;
    let saves = 0;
    const originalFetch = window.fetch;
    window.fetch = async (url, options) => {
        if (url === "/api/subformat") return Response.json({});
        if (url !== "/api/textfile") return originalFetch(url, options);
        const request = JSON.parse(options.body);
        if (request.action === "save") {
            content = request.content;
            saves++;
        }
        return Response.json({ content, schemaDocument: true, language: "json" });
    };
    const host = document.createElement("div");
    document.body.append(host);
    const outer = new EditorView({ parent: host });
    const editors = createTextfileEditors(
        [],
        () => {},
        () => {},
    );
    let dispose = editors.mount("draft.schema.json", host, outer);
    const form = () => host.querySelector(".schema-builder > .schema-add-field");
    try {
        await wait(form);
        const type = form().querySelector("select");
        type.value = "array";
        type.dispatchEvent(new Event("change", { bubbles: true }));
        assert(editors.hasUnsavedChanges(), "Unnamed schema drafts count as unsaved work");
        await new Promise((resolve) => setTimeout(resolve, 750));
        assert(saves === 0, "Auto-save cannot silently omit unnamed draft fields");
        dispose();
        dispose = editors.mount("draft.schema.json", host, outer);
        await wait(() => form()?.querySelector("select")?.value === "array");
        assert(
            host.querySelector(".schema-draft-details [data-schema-field]"),
            "Draft structure survives editor remounts",
        );
        await editors.flush();
        assert(
            saves === 0 && form().querySelector("input").getAttribute("aria-invalid") === "true",
            "Explicit save highlights missing names without writing",
        );
        const name = form().querySelector("input");
        name.value = "entries";
        name.dispatchEvent(new Event("input", { bubbles: true }));
        await editors.flush();
        assert(
            saves === 1 && JSON.parse(content).properties.entries.items.type === "string",
            "A completed draft is included in the saved file",
        );
        assert(!editors.hasUnsavedChanges(), "Saved drafts no longer appear as unsaved work");
        return "Passed: schema draft dirty state, blocked auto-save, remount persistence, save highlights, complete save";
    } finally {
        dispose();
        outer.destroy();
        host.remove();
        window.fetch = originalFetch;
        document.querySelector(".subformat-toast")?.remove();
    }
};

window.testSchemaParameters = async () => {
    const assert = (value, message) => {
        if (!value) throw new Error(message);
    };
    const host = document.createElement("div");
    host.style.cssText = "height:700px;width:620px;max-width:100%";
    document.body.append(host);
    const originalFetch = window.fetch;
    window.fetch = async () => Response.json({});
    const view = new EditorView({
        parent: host,
        doc: SUBFORMAT_SCHEMA_TEMPLATE,
        extensions: [editorSetup, jsonEditor(undefined, true)],
    });
    const schema = () => JSON.parse(view.state.doc.toString());
    const update = (input, value) => {
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const parameter = (node, key) => {
        node.querySelector('[data-schema-menu="Parameters"]').click();
        [...node.querySelectorAll('[role="menuitem"]')]
            .find((item) => item.textContent === key)
            .click();
    };
    const row = (name) =>
        [...host.querySelectorAll("[data-schema-field]")].find(
            (node) => node.dataset.schemaField === JSON.stringify(["properties", name]),
        );
    try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        parameter(host.querySelector(".schema-add-field"), "enum");
        update(
            host.querySelector('.schema-draft-details [data-schema-keyword="enum"]'),
            'Todo\n""\n"first\\nsecond"',
        );
        assert(hasSchemaBuilderDraft(view.state), "Draft constraints participate in unsaved state");
        update(host.querySelector('.schema-add-field [aria-label="New field name"]'), "status");
        assert(prepareSchemaBuilder(view.state), "Saving commits a constrained field draft");
        assert(
            JSON.stringify(schema().properties.status.enum) ===
                JSON.stringify(["Todo", "", "first\nsecond"]),
            "Enum preserves empty and multiline strings",
        );
        let input = row("status").querySelector('[data-schema-keyword="enum"]');
        update(input, `${input.value}\nDone`);
        assert(
            schema().properties.status.enum[2] === "first\nsecond",
            "Enum editing preserves the original multiline value",
        );
        parameter(row("status"), "const");
        update(row("status").querySelector('[data-schema-keyword="const"]'), '""');
        assert(schema().properties.status.const === "", "Empty constants remain set");
        row("status").querySelector('[aria-label="Remove parameter: const"]').click();
        update(row("status").querySelector('select[aria-label="Type"]'), "");
        update(
            row("status").querySelector('[data-schema-keyword="enum"]'),
            '"text"\n1\nfalse\nnull\n[]\n{"x":1}',
        );
        assert(
            schema().properties.status.enum.length === 6 && !schema().properties.status.type,
            "Any type permits mixed JSON choices",
        );
        const before = view.state.doc.toString();
        input = row("status").querySelector('[data-schema-keyword="enum"]');
        update(input, '{"a":1,"b":2}\n{"b":2,"a":1}');
        assert(
            !prepareSchemaBuilder(view.state) && view.state.doc.toString() === before,
            "Duplicate object choices block save without changing the schema",
        );
        update(input, '{"x":1}\n{"x":2}');
        update(row("status").querySelector('select[aria-label="Type"]'), "object");
        assert(
            schema().properties.status.enum[1].x === 2,
            "Object enum choices are editable in the builder",
        );
        row("status").querySelector('[aria-label="Remove parameter: enum"]').click();
        update(row("status").querySelector('select[aria-label="Type"]'), "");
        parameter(row("status"), "oneOf");
        update(
            row("status").querySelector('[data-schema-keyword="oneOf"]'),
            '[{"type":"string"},{"type":"number"}]',
        );
        assert(schema().properties.status.oneOf.length === 2, "Composed rules reach the schema");
        input = row("status").querySelector('[data-schema-keyword="oneOf"]');
        update(input, "[]");
        assert(!prepareSchemaBuilder(view.state), "Invalid composed rules block saving");
        row("status").querySelector('[aria-label="Remove parameter: oneOf"]').click();
        parameter(row("status"), "$ref");
        update(
            row("status").querySelector('[data-schema-keyword="$ref"]'),
            "./common.schema.json#/$defs/status",
        );
        assert(
            schema().properties.status.$ref === "./common.schema.json#/$defs/status",
            "File refs are preserved verbatim",
        );
        const rootSettings = host.querySelector(".schema-root-settings");
        rootSettings.open = true;
        parameter(rootSettings, "$defs");
        update(
            host.querySelector('.schema-root-settings [data-schema-keyword="$defs"]'),
            '{"status":{"type":"string"}}',
        );
        assert(schema().$defs.status.type === "string", "Root schema definitions can be edited");
        view.dispatch({
            changes: {
                from: 0,
                to: view.state.doc.length,
                insert: '{"type":"string","enum":["a",""]}',
            },
        });
        assert(
            host.querySelector('.schema-root-settings [data-schema-keyword="enum"]'),
            "Standalone scalar schema files stay in the builder",
        );
        input = host.querySelector('.schema-root-settings [data-schema-keyword="enum"]');
        update(input, `${input.value}\nb`);
        assert(schema().enum.join(",") === "a,,b", "Standalone enums roundtrip");
        return "Passed: draft constraints, all enum values, duplicate rejection, const, composed rules, file refs, root definitions, standalone schemas";
    } finally {
        view.destroy();
        host.remove();
        window.fetch = originalFetch;
        document.querySelector(".subformat-toast")?.remove();
    }
};
