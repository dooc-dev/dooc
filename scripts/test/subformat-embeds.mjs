import { blocksHtml } from "../../packages/engine/src/core/html.ts";
import { createPreviewUpdater } from "../../packages/frontend/src/preview-update.ts";
import { mountResourceLibrary } from "../../packages/frontend/src/resource-library-ui.ts";

const run = async (editable) => {
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
    const collection = {
        ext: "issue",
        format: "json",
        schema: "issue.schema.json",
        layouts: { view: "list", card_title: "title", group_by: "status" },
        fields: [
            { name: "title", title: "Subject", type: "string" },
            { name: "status", title: "Status", enum: ["Todo", "Done"] },
            { name: "metadata", title: "Metadata" },
        ],
        records: [
            {
                file: "one.issue",
                content: "{}",
                data: {
                    title: "Review <b>records</b>",
                    status: "Todo",
                    metadata: { owner: "Example" },
                },
            },
        ],
    };
    const block = (view, title) => ({
        type: "code",
        filename: "one.issue",
        lines: [],
        subformat: collection,
        embed: { view, title },
    });
    const blocks = [block("card"), block("card"), block("table", "Issues <table>"), block("list")];
    blocks.push({
        ...block("card", "Sorted issues"),
        subformat: {
            ...collection,
            records: [
                ...collection.records,
                {
                    file: "two.issue",
                    content: "{}",
                    data: { title: "Another record", status: "Done" },
                },
            ],
        },
    });
    blocks.push({
        ...block("table", "Configured issues"),
        embed: { view: "table", fields: ["status", "title"], sort_by: "title", sort_order: "desc" },
        subformat: {
            ...collection,
            fields: [...collection.fields, { name: "points", title: "Points", type: "number" }],
            records: [
                { ...collection.records[0], data: { ...collection.records[0].data, points: 0 } },
                {
                    file: "two.issue",
                    content: "Another record",
                    data: { title: "Another record", status: "Done", points: 3 },
                },
            ],
        },
    });
    const host = document.createElement("main");
    const markup = () => `<article>${blocksHtml(blocks)}</article>`;
    host.innerHTML = markup();
    document.body.classList.toggle("edit", editable);
    document.body.append(host);
    const update = createPreviewUpdater(host);
    let opened;
    mountResourceLibrary(
        editable
            ? (file) => {
                  opened = file;
              }
            : undefined,
    );
    try {
        await wait(() => host.querySelectorAll(".subformat-card").length === 5);
        const roots = host.querySelectorAll("[data-subformat-embed]");
        assert(
            roots[0].querySelector('[data-subformat-setting="sort_by"]') &&
                roots[2].querySelector('[data-subformat-setting="view"]'),
            "All embed views expose their own view settings",
        );
        assert(
            !host.querySelector(
                ".subformat-default, [data-subformat-create], [data-subformat-icon]",
            ),
            "Embed settings cannot save board defaults or create records",
        );
        assert(!host.querySelector(".subformat-column > h2"), "Embeds start without grouping");
        assert(
            roots[0].querySelector(".subformat-card-open").textContent === "Review <b>records</b>",
            "Cards use the configured title field and escape text",
        );
        assert(!host.querySelector("b"), "Record markup is escaped");
        assert(
            roots[3].querySelector(".subformat-list-record"),
            "List mode overrides board defaults",
        );
        assert(
            roots[3].querySelector(".subformat-card-meta").textContent.includes("Todo") &&
                roots[3]
                    .querySelector(".subformat-card-meta")
                    .textContent.includes('"owner": "Example"'),
            "Embedded lists show status and nested values as parameters",
        );
        const chooseSetting = (root, key, value) => {
            const trigger = root.querySelector(`[data-subformat-setting="${key}"]`);
            trigger.click();
            root.querySelector(
                `#${trigger.getAttribute("aria-controls")} [data-setting-value="${value}"]`,
            ).click();
        };
        const configured = roots[5];
        assert(
            [...configured.querySelectorAll("thead th")].map((node) => node.textContent).join() ===
                "File name,Status,Subject" &&
                configured.querySelector("[data-subformat-record]").textContent === "one.issue",
            "Embed parameters select field order and initial sorting",
        );
        chooseSetting(configured, "view", "list");
        assert(
            configured.querySelector(".subformat-card-meta").textContent.trim() === "StatusTodo",
            "List parameters restrict displayed fields while keeping the configured heading",
        );
        configured.querySelector("[data-subformat-parameters]").click();
        const fieldOrder = () =>
            [...configured.querySelectorAll("[data-subformat-field]")]
                .map((node) => node.dataset.subformatField)
                .join();
        const initialFieldOrder = fieldOrder();
        configured.querySelector('[data-subformat-field="status"]').click();
        assert(!configured.querySelector(".subformat-card-meta dt"), "Fields can be hidden");
        configured.querySelector('[data-subformat-field="points"]').click();
        assert(
            configured.querySelector(".subformat-card-meta dt").textContent === "Points" &&
                fieldOrder() === initialFieldOrder,
            "Changing query-configured field visibility keeps the menu order",
        );
        configured.querySelector("[popover]:popover-open").hidePopover();
        chooseSetting(configured, "view", "table");
        assert(
            configured.querySelectorAll("thead th").length === 3,
            "Field selection survives switching back to tables",
        );
        configured.querySelector("[data-subformat-filters]").click();
        configured.querySelector("[data-filter-add]").click();
        const filterField = configured.querySelector("[data-filter-field]");
        filterField.value = "points";
        filterField.dispatchEvent(new Event("change", { bubbles: true }));
        configured.querySelector("[data-filter-operator]").value = "gte";
        configured.querySelector("[data-filter-value]").value = "invalid";
        configured.querySelector(".subformat-filters").requestSubmit();
        assert(
            configured.querySelector('[role="alert"]').textContent,
            "Invalid numeric filters keep the form open with an error",
        );
        configured.querySelector("[data-filter-value]").value = "1";
        configured.querySelector(".subformat-filters").requestSubmit();
        assert(
            configured.querySelector("[data-resource-count]").textContent === "1" &&
                configured.querySelector("[data-subformat-record]").textContent === "two.issue" &&
                roots[2].querySelector("[data-resource-count]").textContent === "1",
            "Typed filters narrow only their own embed",
        );
        const search = configured.querySelector("[data-resource-search]");
        const searchToggle = configured.querySelector("[data-subformat-search]");
        assert(
            search.closest("label").hidden &&
                searchToggle.getAttribute("aria-expanded") === "false",
            "Search starts as an icon",
        );
        searchToggle.click();
        assert(
            !search.closest("label").hidden &&
                document.activeElement === search &&
                roots[2].querySelector(".resource-search").hidden,
            "The search icon opens and focuses only its own input",
        );
        search.value = "no match";
        search.dispatchEvent(new Event("input", { bubbles: true }));
        assert(
            configured.querySelector("[data-resource-count]").textContent === "0",
            "Text search combines with active filters",
        );
        searchToggle.click();
        assert(
            search.closest("label").hidden &&
                search.value === "" &&
                configured.querySelector("[data-resource-count]").textContent === "1",
            "Closing search clears it while retaining field filters",
        );
        searchToggle.click();
        search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        assert(
            search.closest("label").hidden && document.activeElement === searchToggle,
            "Escape closes search and restores icon focus",
        );
        configured.querySelector("[data-subformat-filters]").click();
        configured.querySelector("[data-filter-clear]").click();
        assert(
            configured.querySelector("[data-resource-count]").textContent === "2",
            "Clearing interactive filters restores the embedded records",
        );
        chooseSetting(roots[4], "sort_by", "title");
        assert(
            roots[4].querySelector(".subformat-card-open").textContent === "Another record",
            "Embedded cards can sort by a schema field",
        );
        chooseSetting(roots[4], "sort_order", "desc");
        assert(
            roots[4].querySelector(".subformat-card-open").textContent === "Review <b>records</b>",
            "Embedded cards can reverse the sort order",
        );
        chooseSetting(roots[4], "group_by", "status");
        assert(
            roots[4].querySelectorAll(".subformat-column > h2").length === 2,
            "Embedded cards can group records",
        );
        chooseSetting(roots[4], "view", "list");
        assert(
            roots[4].querySelectorAll(".subformat-list-record").length === 2 &&
                !roots[4].querySelector(".subformat-column > h2") &&
                !roots[4].querySelector('[data-subformat-setting="group_by"]') &&
                getComputedStyle(roots[4].querySelector(".subformat-cards")).display !== "grid",
            "Switching an embedded card collection to a list removes grouping and card grid layout",
        );
        const parameterTrigger = () => roots[4].querySelector("[data-subformat-parameters]");
        const parameterMenu = () =>
            roots[4].querySelector(`#${parameterTrigger().getAttribute("aria-controls")}`);
        parameterTrigger().click();
        parameterMenu().querySelector('[data-parameter="metadata"][data-move="up"]').click();
        assert(
            roots[4].querySelector('[data-record-file="one.issue"] .subformat-card-meta dt')
                .textContent === "Metadata" &&
                roots[3].querySelector(".subformat-card-meta dt").textContent === "Status" &&
                roots[4].querySelector('[data-record-file="two.issue"] .subformat-card-meta dt')
                    .textContent === "Status",
            "Each embed orders its own parameters and skips fields missing from a record",
        );
        parameterMenu().hidePopover();
        chooseSetting(roots[4], "view", "card");
        assert(
            roots[4].querySelectorAll(".subformat-column > h2").length === 2,
            "Switching back to cards restores the embed's grouping choice",
        );
        chooseSetting(roots[4], "group_by", "");
        chooseSetting(roots[4], "view", "list");
        assert(
            roots[4].querySelector('[data-record-file="one.issue"] .subformat-card-meta dt')
                .textContent === "Metadata",
            "Embedded parameter order survives view changes",
        );
        chooseSetting(roots[0], "card_title", "status");
        assert(
            roots[0].querySelector(".subformat-card-open").textContent === "Todo" &&
                roots[1].querySelector(".subformat-card-open").textContent ===
                    "Review <b>records</b>",
            "Repeated embeds keep their view settings independent",
        );
        chooseSetting(roots[0], "card_title", "title");
        roots[1].querySelector(".subformat-card-toggle").click();
        assert(
            roots[0].querySelector(".subformat-card-details").hidden,
            "Repeated embeds expand independently",
        );
        assert(
            !roots[1].querySelector(".subformat-card-details").hidden,
            "The selected embed expands",
        );
        const ids = [...host.querySelectorAll("[id]")].map((node) => node.id);
        assert(new Set(ids).size === ids.length, "Repeated record embeds have unique control IDs");
        assert(
            roots[2].querySelector("h2").textContent === "Issues <table>",
            "The title applies to the whole embed",
        );
        assert(
            roots[2].querySelectorAll("thead th").length === 4,
            "Tables show a file column and schema fields",
        );
        const open = roots[2].querySelector("[data-subformat-record]");
        open.click();
        if (editable) {
            assert(opened === "one.issue", "Table records open the editor");
            opened = undefined;
            roots[0].querySelector(".subformat-card-open").click();
            assert(opened === "one.issue", "Embedded cards open the editor");
        } else {
            await wait(() => document.querySelector("dialog[open]"));
            const dialog = document.querySelector("dialog[open]");
            assert(
                dialog.textContent.includes('"owner": "Example"'),
                "Published tables open complete record details",
            );
            dialog.close();
            await wait(() => !dialog.isConnected);
            assert(document.activeElement === open, "Closing details restores table focus");
        }
        const source = document.createElement("template");
        source.innerHTML = markup().replace("</article>", "<p>Updated prose</p></article>");
        update(host, source.content);
        assert(
            host.querySelectorAll("[data-subformat-embed]")[1] === roots[1],
            "Unchanged cards survive preview updates",
        );
        assert(
            roots[4].querySelector('[data-subformat-setting="sort_order"]').textContent ===
                "Descending",
            "Temporary sort choices survive unrelated preview edits",
        );
        assert(
            roots[4].querySelector('[data-record-file="one.issue"] .subformat-card-meta dt')
                .textContent === "Metadata",
            "Parameter order survives unrelated preview edits",
        );
        collection.records[0].data.title = "Changed record";
        source.innerHTML = markup();
        update(host, source.content);
        await wait(
            () => host.querySelector(".subformat-card-open")?.textContent === "Changed record",
        );
        assert(
            host.querySelector(".subformat-table").textContent.includes("Changed record"),
            "Changed tables remount after a live preview update",
        );
    } finally {
        host.remove();
    }
};

window.testSubformatEmbeds = () => run(false);
window.testSubformatEmbedEditor = () => run(true);

window.testSubformatEmbedLayout = async () => {
    const assert = (condition, message) => {
        if (!condition) throw new Error(message);
    };
    document.body.classList.remove("edit");
    const host = document.createElement("main");
    host.style.cssText = "box-sizing:border-box;width:100%;max-width:100%;padding:24px";
    host.innerHTML = `<article>${blocksHtml([
        {
            type: "code",
            filename: "issue.schema.json",
            lines: [],
            embed: { view: "table" },
            subformat: {
                ext: "issue",
                format: "json",
                schema: "issue.schema.json",
                fields: [
                    { name: "title", title: "Title", type: "string" },
                    { name: "status", title: "Status", enum: ["Todo", "Done"] },
                    { name: "notes", title: "Notes", type: "string" },
                ],
                records: Array.from({ length: 40 }, (_, index) => ({
                    file: `issue-${index}.issue`,
                    content: "{}",
                    data: {
                        title: `Issue ${index}`,
                        status: "Todo",
                        notes: "Long notes ".repeat(10),
                    },
                })),
            },
        },
    ])}</article>`;
    document.body.append(host);
    mountResourceLibrary();
    const root = host.querySelector("[data-subformat-embed]");
    const board = root.querySelector("[data-subformat-board]");
    const searchToggle = root.querySelector("[data-subformat-search]");
    const viewTrigger = () => root.querySelector('[data-subformat-setting="view"]');
    assert(
        Math.abs(
            searchToggle.getBoundingClientRect().bottom -
                viewTrigger().getBoundingClientRect().bottom,
        ) <= 1,
        "The search icon shares a row with the view controls",
    );
    searchToggle.click();
    if (innerWidth > 600)
        assert(
            Math.abs(
                searchToggle.getBoundingClientRect().bottom -
                    viewTrigger().getBoundingClientRect().bottom,
            ) <= 1,
            "Opening search does not force a separate toolbar row",
        );
    searchToggle.click();
    for (const view of ["table", "card", "list"]) {
        const trigger = root.querySelector('[data-subformat-setting="view"]');
        trigger.click();
        root.querySelector(`[data-setting-value="${view}"]`).click();
        const bounds = board.getBoundingClientRect();
        const maximum = Math.min(
            innerWidth <= 600 ? 480 : 640,
            innerHeight * (innerWidth <= 600 ? 0.55 : 0.65),
        );
        assert(
            bounds.height <= maximum + 1 && board.scrollHeight > board.clientHeight,
            `${view}: long embeds use a responsive scroll area`,
        );
        assert(
            root.querySelector(".subformat-embed-toolbar").getBoundingClientRect().bottom <=
                bounds.top,
            `${view}: controls remain above the scroll area`,
        );
        assert(
            document.documentElement.scrollWidth <= innerWidth,
            `${view}: the embed does not widen the page`,
        );
        board.scrollTop = board.scrollHeight;
        if (view === "table") {
            const header = root.querySelector("thead th").getBoundingClientRect();
            assert(
                header.top >= bounds.top - 1 && header.bottom < bounds.bottom,
                "Table headers remain visible while scrolling",
            );
        }
        board.scrollTop = 0;
    }
    root.querySelector("[data-subformat-filters]").click();
    root.querySelector("[data-filter-add]").click();
    assert(
        document.documentElement.scrollWidth <= innerWidth,
        "Filter controls fit narrow screens",
    );
};
