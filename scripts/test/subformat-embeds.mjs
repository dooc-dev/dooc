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
                !roots[2].querySelector(".subformat-controls"),
            "Card embeds expose their own view settings; tables keep their table layout",
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
