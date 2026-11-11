import { mountSelectPickers } from "../../src/viewer/language-picker.ts";
import {
    mountResourceLibrary,
    restoreResourceFilters,
} from "../../src/viewer/resource-library-ui.ts";
import { filterSubformats, hasSubformatDraft } from "../../src/viewer/subformats-ui.ts";

// Bundle with esbuild and run testSubformatCards() on a local HTTP origin with viewer styles.
window.testSubformatCards = async () => {
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
        format: "yaml",
        schema: "issue.schema.json",
        layouts: { card_title: "title" },
        baseLayouts: { card_title: "title" },
        template: "title: New\nstatus: Todo\ndue: 2026-11-12\n",
        defaultFolder: "records",
        fields: [
            { name: "title", title: "Title", type: "string" },
            { name: "status", title: "Status", enum: ["Todo", "Done"] },
            { name: "due", title: "Due date", type: "string", format: "date" },
            { name: "metadata", title: "Metadata" },
        ],
        records: [
            {
                file: "card.issue",
                references: [
                    { file: "guide.md", line: 4 },
                    { file: "notes.md", line: 12 },
                ],
                content: "original",
                data: {
                    title: "Review <b>cards</b>",
                    status: "Todo",
                    due: "2026-11-12",
                    metadata: { owner: "Sample" },
                },
            },
        ],
    };
    const originalFetch = window.fetch;
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const sourceBase = document.body.dataset.sourceBase;
    let copied;
    let failCopy = false;
    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
            async writeText(value) {
                if (failCopy) throw Error("Clipboard denied");
                copied = value;
            },
        },
    });
    document.body.dataset.sourceBase = "https://example.com/source/";
    const wasEditable = document.body.classList.contains("edit");
    const host = document.createElement("section");
    let opened;
    let openedLine;
    let failSave = false;
    let finishSave;
    let delaySave = false;
    let failCreate = false;
    let failRegister = false;
    let failDelete = false;
    const deletions = [];
    let failLayout = false;
    let delayLayout = false;
    let finishLayout;
    const layouts = [];
    let saves = 0;
    const openRegistration = (event) => host.append(event.detail);
    document.addEventListener("docs:subformat-add", openRegistration);
    document.addEventListener("docs:subformat-create", openRegistration);
    mountResourceLibrary((file, line) => {
        opened = file;
        openedLine = line;
    });
    const createRoot = (editable = true, empty = false) => {
        const root = document.createElement("div");
        root.className = "resource-results";
        root.dataset.resourceResults = "";
        root.innerHTML =
            '<template data-subformats></template><div class="resource-toolbar"><div class="resource-query"><div class="subformat-picker"><select data-resource-filter data-subformat-filter hidden aria-label="Subformats"><option value="issue">issue</option><option value="note">note</option></select><button type="button" data-subformat-trigger></button><div data-subformat-options class="subformat-picker-menu" popover="auto"></div></div></div></div><div data-subformat-board></div>';
        root.querySelector("template").content.textContent = JSON.stringify([
            collection,
            {
                ...collection,
                ext: "note",
                schema: "note.schema.json",
                records: [{ ...collection.records[0], file: "note.note" }],
            },
        ]);
        if (empty) {
            root.querySelector("template").content.textContent = "[]";
            root.querySelector("select").innerHTML = '<option value="">Subformats</option>';
        }
        host.append(root);
        filterSubformats(
            root,
            [],
            editable
                ? (file) => {
                      opened = file;
                  }
                : undefined,
        );
        return root;
    };
    document.body.classList.add("edit");
    document.body.append(host);
    window.fetch = async (url, options) => {
        if (url !== "/api/subformat") return originalFetch(url, options);
        const input = JSON.parse(options.body);
        if (input.action === "delete") {
            deletions.push(input);
            if (failDelete) return Response.json({ error: "Save failed" }, { status: 409 });
            return Response.json({});
        }
        if (input.action === "layouts") {
            layouts.push(input);
            if (delayLayout)
                await new Promise((resolve) => {
                    finishLayout = resolve;
                });
            if (failLayout) return Response.json({ error: "Save failed" }, { status: 409 });
            return Response.json({});
        }
        if (input.action === "register") {
            assert(
                input.ext === "ticket" && input.format === "json",
                "Registration sends the chosen definition",
            );
            assert(
                JSON.parse(input.content).$schema.endsWith("2020-12/schema"),
                "New definitions include a 2020-12 schema",
            );
            if (failRegister)
                return Response.json({ error: "Schema file already exists" }, { status: 409 });
            return Response.json({
                collection: {
                    ...collection,
                    ext: "ticket",
                    format: "json",
                    schema: "ticket.schema.json",
                    records: [],
                    change: "added",
                },
            });
        }
        if (input.action === "create") {
            assert(input.file === "created.issue", "Create uses the entered file path");
            if (failCreate) return Response.json({ error: "File already exists" }, { status: 409 });
            return Response.json({
                content: input.content,
                data: { title: "Created", status: "Todo" },
            });
        }
        saves++;
        assert(input.base === "original", "Moves must retain the conflict guard");
        if (delaySave)
            await new Promise((resolve) => {
                finishSave = resolve;
            });
        if (failSave) return Response.json({ error: "Save failed" }, { status: 409 });
        return Response.json({
            content: "saved",
            data: { ...collection.records[0].data, status: input.value },
        });
    };
    try {
        let root = createRoot();
        const card = () => root.querySelector("[data-record-file]");
        const details = () => card().querySelector(".subformat-card-details");
        const title = () => card().querySelector(".subformat-card-open");
        assert(details().hidden, "Cards start collapsed");
        assert(
            getComputedStyle(card()).backgroundColor === "rgba(0, 0, 0, 0)",
            "Card backgrounds are transparent",
        );
        card().querySelector(".subformat-card-copy").click();
        await wait(() => copied !== undefined);
        assert(
            copied === "https://example.com/source/card.issue" && !opened,
            "Copy resolves the source URL without opening the card",
        );
        failCopy = true;
        card().querySelector(".subformat-card-copy").click();
        await wait(() => document.querySelector(".subformat-toast"));
        document.querySelector(".subformat-toast").remove();
        failCopy = false;
        const controls = card().querySelector(".subformat-card-tools").getBoundingClientRect();
        assert(
            Math.abs(controls.top + controls.height / 2 - card().getBoundingClientRect().top) < 1,
            "Card controls sit on the top border",
        );
        assert(
            !root.querySelector("[data-subformat-trigger] svg"),
            "The prominent picker has no icon",
        );
        const setting = (key) => root.querySelector(`[data-subformat-setting="${key}"]`);
        const menu = (key) => root.querySelector(`#${setting(key).getAttribute("aria-controls")}`);
        const chooseSetting = (key, value) => {
            if (!menu(key).matches(":popover-open")) setting(key).click();
            menu(key)
                .querySelector(`[data-setting-value="${CSS.escape(value)}"]`)
                .click();
            assert(!menu(key).matches(":popover-open"), "Choosing a value closes its menu");
        };
        const chooseTitle = (value) => chooseSetting("card_title", value);
        const saveDefault = async (key, value) => {
            if (!menu(key).matches(":popover-open")) setting(key).click();
            menu(key)
                .querySelector(`button[data-default-value="${CSS.escape(value)}"]`)
                .click();
            assert(menu(key).matches(":popover-open"), "Saving keeps the menu open while pending");
            await wait(() => !setting(key).disabled);
            assert(
                menu(key).matches(":popover-open"),
                "Saving keeps the menu open after completion",
            );
        };
        const defaultMarker = (value) =>
            menu("card_title").querySelector(`[data-default-value="${value}"]`);
        assert(
            defaultMarker("title").dataset.layoutChanged === "false",
            "Committed defaults are neutral",
        );
        assert(
            title().textContent === "Review <b>cards</b>",
            "Saved defaults select the initial title",
        );
        assert(!title().querySelector("b"), "Configured titles are escaped");
        chooseTitle("due");
        assert(
            title().textContent === "2026-11-12",
            "The dropdown selects an arbitrary title field",
        );
        assert(layouts.length === 0, "Ordinary selections do not save defaults");
        assert(document.activeElement === setting("card_title"), "Title selection retains focus");
        await saveDefault("card_title", "due");
        assert(
            layouts.at(-1).value === "due" && layouts.at(-1).base === "title",
            "Only the check mark saves a default with a conflict guard",
        );
        assert(
            menu("card_title").querySelector('[data-default-value="due"]').dataset.isDefault ===
                "true",
            "The saved default is marked",
        );
        assert(
            defaultMarker("due").dataset.layoutChanged === "true",
            "Changed defaults stay highlighted",
        );
        const added = document.createElement("span");
        added.dataset.subformatChange = "added";
        root.append(added);
        assert(
            getComputedStyle(defaultMarker("due")).color === getComputedStyle(added).color,
            "Changed defaults use the Git addition color",
        );
        added.remove();
        failLayout = true;
        await saveDefault("card_title", "title");
        assert(
            title().textContent === "2026-11-12",
            "Failed default saves do not change the current view",
        );
        assert(
            menu("card_title").querySelector('[data-default-value="due"]').dataset.isDefault ===
                "true",
            "Failed saves preserve the old default",
        );
        assert(
            document.querySelector('.subformat-toast[role="alert"]'),
            "Failed default saves show an error",
        );
        document.querySelector(".subformat-toast").remove();
        failLayout = false;
        await saveDefault("card_title", "title");
        assert(
            defaultMarker("title").dataset.layoutChanged === "false",
            "Reverting to HEAD clears the highlight",
        );
        await saveDefault("card_title", "due");
        delayLayout = true;
        menu("card_title").querySelector('[data-default-value="title"]').click();
        menu("card_title").hidePopover();
        finishLayout();
        await wait(() => !setting("card_title").disabled);
        assert(
            !menu("card_title").matches(":popover-open"),
            "Finishing a save does not reopen a menu the user dismissed",
        );
        delayLayout = false;
        await saveDefault("card_title", "due");
        for (const [key, value] of [
            ["group_by", ""],
            ["sort_by", "due"],
            ["sort_order", "desc"],
        ]) {
            await saveDefault(key, value);
            assert(
                layouts.at(-1).key === key && layouts.at(-1).value === value,
                "Each control saves its own default",
            );
        }
        assert(
            setting("group_by").textContent === "Status",
            "Saving a different default does not change the current selection",
        );
        chooseTitle("metadata");
        assert(title().textContent === '{"owner":"Sample"}', "Object title values use JSON");
        chooseTitle("");
        assert(title().textContent === "card.issue", "The file name is an explicit title choice");
        chooseTitle("due");
        const toolOrder = [...card().querySelector(".subformat-card-tools").children].map(
            (element) => element.className,
        );
        assert(
            toolOrder.join(",") ===
                "subformat-card-file,subformat-card-toggle,subformat-card-references,subformat-card-copy",
            "Card tools follow filename, collapse, usage, copy order",
        );
        assert(
            card().querySelector(".subformat-card-references").textContent === "2",
            "Cards show their body reference count",
        );
        const referenceButton = card().querySelector(".subformat-card-references");
        const referenceList = card().querySelector(".subformat-reference-list");
        referenceButton.click();
        await wait(() => referenceList.matches(":popover-open"));
        assert(
            !opened && !document.querySelector("dialog"),
            "Opening references does not open the card",
        );
        assert(
            referenceList.querySelectorAll("a").length === 2,
            "The dropdown lists every reference",
        );
        const sourceLink = referenceList.querySelector("a");
        assert(sourceLink.textContent === "guide.mdL4", "References identify the file and line");
        assert(!sourceLink.draggable, "Reference links do not start native URL drags");
        sourceLink.click();
        assert(
            opened === "guide.md" && openedLine === 4,
            "Selecting a reference opens its source line",
        );
        assert(
            !referenceList.matches(":popover-open"),
            "Selecting a reference closes the dropdown",
        );
        opened = undefined;
        card().querySelector(".subformat-card-toggle").click();
        assert(!details().hidden, "The arrow expands details");
        assert(!opened, "Expanding a card does not open the editor");
        filterSubformats(root, []);
        assert(!details().hidden, "Rendering preserves expanded cards");
        const changeFormat = (value) => {
            const select = root.querySelector("[data-resource-filter]");
            select.value = value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
        };
        changeFormat("note");
        assert(card().dataset.recordFile === "note.note", "The dropdown switches subformats");
        const previous = document.createElement("section");
        host.append(previous);
        previous.append(root);
        setting("card_title").click();
        previous.remove();
        const next = document.createElement("section");
        host.append(next);
        root = createRoot();
        next.append(root);
        restoreResourceFilters(previous, next);
        assert(
            menu("card_title").matches(":popover-open"),
            "Resource replacement preserves the open layout menu",
        );
        menu("card_title").hidePopover();
        assert(
            root.querySelector("[data-resource-filter]").value === "note",
            "Resource replacement preserves the selected subformat",
        );
        changeFormat("issue");
        filterSubformats(root, []);
        assert(!details().hidden, "Resource replacement preserves expanded cards");
        assert(
            title().textContent === "2026-11-12",
            "Resource replacement preserves temporary title selection",
        );
        chooseTitle("title");
        const beforeSelection = layouts.length;
        chooseSetting("sort_order", "desc");
        assert(
            setting("sort_order").textContent === "Descending",
            "Sort order changes immediately",
        );
        assert(document.activeElement === setting("sort_order"), "Sort order retains focus");
        chooseSetting("sort_order", "asc");
        chooseSetting("sort_by", "due");
        assert(document.activeElement === setting("sort_by"), "Sorting retains keyboard focus");
        assert(
            setting("sort_order").textContent === "Oldest first",
            "Date sorting describes its order",
        );
        assert(layouts.length === beforeSelection, "Sort selections do not save defaults");
        title().click();
        assert(
            opened === "card.issue" && !document.querySelector("dialog"),
            "Keyboard activation opens the editor directly",
        );
        assert(!title().hasAttribute("aria-haspopup"), "Editor cards do not announce a dialog");
        opened = undefined;
        const file = card().querySelector(".subformat-card-file");
        assert(
            !card().querySelector('a:not([draggable="false"]), [title]'),
            "Cards have no native link drags or tooltips",
        );
        file.click();
        assert(
            opened === "card.issue" && !document.querySelector("dialog"),
            "Clicking the filename opens the editor directly",
        );
        opened = undefined;
        card()
            .querySelector("dd")
            .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
        assert(
            opened === "card.issue" && !document.querySelector("dialog"),
            "A single click on the card body opens the editor directly",
        );
        opened = undefined;
        assert(!card().querySelector("b"), "Record markup is escaped");
        for (const target of [
            title(),
            file,
            card().querySelector("dd"),
            card().querySelector("path"),
        ]) {
            const transfer = new DataTransfer();
            transfer.setDragImage = () => {};
            target.dispatchEvent(
                new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }),
            );
            assert(
                transfer.getData("application/x-dooc-record") === "card.issue",
                "Every part of the card starts a card move",
            );
            card().dispatchEvent(new DragEvent("dragend", { bubbles: true }));
        }
        const transfer = new DataTransfer();
        let dragImage;
        transfer.setDragImage = (element) => {
            dragImage = element;
        };
        const rect = card().getBoundingClientRect();
        const startDrag = () =>
            card().dispatchEvent(
                new DragEvent("dragstart", {
                    bubbles: true,
                    dataTransfer: transfer,
                    clientX: rect.left + 60,
                    clientY: rect.top + 30,
                }),
            );
        startDrag();
        const preview = root.querySelector(".subformat-drag-preview");
        assert(
            preview?.innerHTML.replace(/ id="[^"]*"/g, "") ===
                card().innerHTML.replace(/ id="[^"]*"/g, ""),
            "Dragging preserves the entire card, including tools and expanded details",
        );
        assert(
            dragImage instanceof HTMLCanvasElement && dragImage.width === 1,
            "The browser's faded drag image is replaced with a blank image",
        );
        assert(
            preview.inert && !preview.querySelector("[id]") && !preview.dataset.recordFile,
            "The preview adds no focus targets or duplicate record and element IDs",
        );
        await wait(() => card().classList.contains("is-dragging"));
        const previewRect = preview.getBoundingClientRect();
        assert(
            previewRect.width === rect.width &&
                previewRect.height === rect.height &&
                previewRect.left === rect.left &&
                previewRect.top === rect.top,
            "Dragging keeps the exact card size and initial position",
        );
        assert(
            getComputedStyle(preview).opacity === "1" &&
                getComputedStyle(preview).backgroundColor ===
                    getComputedStyle(preview.querySelector(".subformat-card-tools"))
                        .backgroundColor &&
                getComputedStyle(preview).backgroundColor !== "rgba(0, 0, 0, 0)" &&
                getComputedStyle(card()).visibility === "hidden" &&
                card().getBoundingClientRect().height === rect.height,
            "Only the opaque dragged card is visible, with its original space preserved",
        );
        const source = card().parentElement;
        const sourceDrag = new DragEvent("dragover", {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
            clientX: rect.left + 110,
            clientY: rect.top + 70,
        });
        source.dispatchEvent(sourceDrag);
        await new Promise(requestAnimationFrame);
        assert(
            preview.getBoundingClientRect().left === rect.left + 50 &&
                preview.getBoundingClientRect().top === rect.top + 40,
            "The card follows the pointer without changing the grab offset",
        );
        assert(
            sourceDrag.defaultPrevented && !source.classList.contains("is-drop-target"),
            "The current column accepts dragging without a false move highlight",
        );
        source.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
        assert(saves === 0, "Dropping in the current column does not save");
        assert(!preview.isConnected, "Dropping removes the preview immediately");
        const destination = root.querySelector(
            '.subformat-column[aria-label="Done"] .subformat-cards',
        );
        const heading = destination.previousElementSibling;
        destination.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
        assert(saves === 0, "A drop without an active card drag does not save");
        startDrag();
        const headerDrag = new DragEvent("dragover", {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
        });
        heading.dispatchEvent(headerDrag);
        heading.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
        assert(!headerDrag.defaultPrevented && saves === 0, "Column headings do not accept drops");
        startDrag();
        destination.dispatchEvent(
            new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
        assert(destination.classList.contains("is-drop-target"), "The destination is highlighted");
        assert(
            !destination.parentElement.classList.contains("is-drop-target"),
            "Highlighting is confined to the card area",
        );
        destination.dispatchEvent(new DragEvent("dragleave", { bubbles: true }));
        assert(
            destination.classList.contains("is-drop-target"),
            "Crossing children does not flash the destination highlight",
        );
        document.body.dispatchEvent(new DragEvent("dragover", { bubbles: true }));
        assert(
            !destination.classList.contains("is-drop-target"),
            "Leaving the board clears the target",
        );
        card().dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: transfer }));
        assert(
            !root.querySelector(".is-dragging, .is-drop-target, .subformat-drag-preview"),
            "Cancelled drags clear feedback",
        );
        title().click();
        card().querySelector(".subformat-card-toggle").click();
        assert(
            !opened && !document.querySelector("dialog") && !details().hidden,
            "Releasing a drag does not open details, edit, or toggle the card",
        );
        startDrag();
        filterSubformats(root, []);
        assert(
            !root.querySelector(".is-dragging, .subformat-drag-preview"),
            "Rerendering during a drag clears the preview and restores the card",
        );
        const selectMove = () => {
            const select = card().querySelector("select");
            select.value = "1";
            select.dispatchEvent(new Event("change", { bubbles: true }));
        };
        failSave = true;
        const top = card().getBoundingClientRect().top;
        host.tabIndex = -1;
        host.focus();
        const focus = document.activeElement;
        selectMove();
        await wait(() => root.querySelector('[data-subformat-board][aria-busy="false"]'));
        await wait(() => card().getAnimations().length === 0);
        assert(
            card().closest(".subformat-column").getAttribute("aria-label") === "Todo",
            "Failed moves keep their original group",
        );
        const toast = document.querySelector('.subformat-toast[role="alert"]');
        assert(toast?.textContent, "Save errors are announced in a toast");
        assert(getComputedStyle(toast).position === "fixed", "Error toasts stay out of the layout");
        assert(card().getBoundingClientRect().top === top, "Errors do not shift the cards");
        assert(document.activeElement === focus, "Error toasts do not steal focus");
        await new Promise((resolve) => setTimeout(resolve, 6100));
        assert(!toast.isConnected, "Error toasts disappear automatically");
        failSave = false;
        delaySave = true;
        const movingCard = card();
        const movingColumns = movingCard.closest(".subformat-columns");
        movingColumns.style.maxWidth = "300px";
        movingColumns.scrollLeft = 120;
        startDrag();
        transfer.clearData();
        root.querySelector('.subformat-column[aria-label="Done"] .subformat-cards').dispatchEvent(
            new DragEvent("drop", { bubbles: true, dataTransfer: transfer }),
        );
        assert(!root.querySelector(".subformat-drag-preview"), "Saving a drop removes the preview");
        assert(
            card() === movingCard &&
                card().closest(".subformat-column").getAttribute("aria-label") === "Done" &&
                movingColumns.scrollLeft === 120,
            "Dropping moves the existing card immediately without rebuilding or resetting scroll",
        );
        assert(
            root.querySelector('[data-subformat-board][aria-busy="true"]') &&
                !root.querySelector(".subformat-status") &&
                !document.querySelector(".subformat-toast"),
            "Dropping saves the tracked card even without a readable transfer payload",
        );
        movingColumns.style.maxWidth = "";
        delaySave = false;
        finishSave();
        await wait(() => root.querySelector('[data-subformat-board][aria-busy="false"]'));
        assert(
            saves === 2 &&
                card().closest(".subformat-column").getAttribute("aria-label") === "Done",
            "The accessible selector saves and retries moves",
        );
        assert(!details().hidden, "Moves preserve expanded cards");
        assert(
            card().dataset.recordChange === "modified",
            "Moving a tracked record marks it modified",
        );
        assert(
            root.querySelector('.subformat-count [data-record-change="modified"]').textContent ===
                "1",
            "Modified counts follow the card status",
        );
        assert(
            !root.querySelector(".subformat-status") && !document.querySelector(".subformat-toast"),
            "Successful moves do not show a status message",
        );
        const create = root.querySelector("[data-subformat-create]");
        create.click();
        let form = host.querySelector("[data-subformat-record]");
        assert(
            form && !root.contains(form),
            "Create opens the right editor without a toolbar popup",
        );
        create.click();
        assert(
            host.querySelectorAll("[data-subformat-record]").length === 1,
            "Repeated Create keeps the existing draft",
        );
        assert(
            form.elements.file.value === "records/new.issue",
            "Create uses the configured folder",
        );
        assert(
            form.elements.content.value === collection.template,
            "Create starts with the schema template",
        );
        form.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        assert(
            !form.isConnected && document.activeElement === create,
            "Escape cancels creation and restores focus",
        );
        create.click();
        form = host.querySelector("[data-subformat-record]");
        form.elements.file.value = "created.issue";
        form.elements.file.dispatchEvent(new Event("input", { bubbles: true }));
        assert(hasSubformatDraft(), "New record edits participate in the unsaved warning");
        failCreate = true;
        const beforeCreate = card().getBoundingClientRect().top;
        form.requestSubmit();
        await wait(() => !form.querySelector("fieldset").disabled);
        assert(
            form.isConnected && form.elements.content.value === collection.template,
            "Failed creation preserves the draft",
        );
        assert(
            card().getBoundingClientRect().top === beforeCreate,
            "Creation errors do not move cards",
        );
        assert(
            document.querySelector('.subformat-toast[role="alert"]'),
            "Creation errors use the toast",
        );
        failCreate = false;
        form.requestSubmit();
        await wait(() => !form.isConnected);
        assert(opened === "created.issue", "Creating opens the right editor");
        assert(!hasSubformatDraft(), "Successful creation clears the unsaved draft");
        const created = root.querySelector('[data-record-file="created.issue"]');
        assert(created?.dataset.recordChange === "added", "New records use the added border");
        assert(
            root.querySelectorAll(".subformat-count [data-record-change]").length === 2,
            "Column counts show new and modified records",
        );
        const newColor = getComputedStyle(created).borderTopColor;
        assert(
            newColor !==
                getComputedStyle(root.querySelector('[data-record-file="card.issue"]'))
                    .borderTopColor,
            "Added and modified borders differ",
        );
        assert(
            getComputedStyle(root.querySelector('.subformat-count [data-record-change="added"]'))
                .color === newColor,
            "Count and border colors match",
        );
        assert(
            root.querySelector("[data-subformat-trigger]").dataset.subformatChange === "modified",
            "Modified records color their subformat orange",
        );
        const openAdd = () => {
            root.querySelector("[data-subformat-trigger]").click();
            root.querySelector("[data-subformat-add]").click();
            return host.querySelector("[data-subformat-register]");
        };
        let registration = openAdd();
        assert(
            registration.elements.ext.placeholder === "ext." &&
                registration.elements.schema.placeholder === "path" &&
                !registration.elements.ext.value &&
                !registration.elements.schema.value,
            "Subformat settings use placeholder labels without preset values",
        );
        assert(
            registration && !root.contains(registration),
            "Add opens the editor rather than a toolbar popup",
        );
        const disposePicker = mountSelectPickers((key) => key, [registration.elements.format]);
        const formatInput = registration.querySelector('[role="combobox"]');
        formatInput.focus();
        formatInput.value = "tom";
        formatInput.dispatchEvent(new Event("input", { bubbles: true }));
        formatInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        assert(registration.elements.format.value === "toml", "Format uses the searchable picker");
        formatInput.click();
        formatInput.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        assert(registration.isConnected, "Escape closes the picker before the form");
        disposePicker();
        assert(
            !registration.querySelector(".language-picker") && !registration.elements.format.hidden,
            "Disposing the picker restores its native select",
        );
        registration.querySelector("[data-cancel]").click();
        assert(
            document.activeElement === root.querySelector("[data-subformat-trigger]"),
            "Cancel restores the visible picker focus",
        );
        registration = openAdd();
        registration.elements.ext.value = "ticket";
        registration.elements.ext.dispatchEvent(new Event("input", { bubbles: true }));
        assert(
            registration.elements.schema.placeholder === "ticket.schema.json" &&
                registration.elements.schema.value === "",
            "An empty path shows the filename derived from the extension",
        );
        registration.elements.schema.value = "custom.schema.json";
        registration.elements.ext.value = "changed";
        registration.elements.ext.dispatchEvent(new Event("input", { bubbles: true }));
        assert(
            registration.elements.schema.value === "custom.schema.json",
            "Changing the extension preserves an explicit path",
        );
        registration.elements.schema.value = "";
        registration.elements.ext.value = "ticket";
        registration.elements.ext.dispatchEvent(new Event("input", { bubbles: true }));
        failRegister = true;
        registration.requestSubmit();
        await wait(() => !registration.querySelector("fieldset").disabled);
        assert(
            registration.isConnected && registration.elements.ext.value === "ticket",
            "Registration errors preserve edits",
        );
        failRegister = false;
        registration.requestSubmit();
        await wait(() => !registration.isConnected);
        assert(opened === "ticket.schema.json", "Registration opens the schema for editing");
        assert(
            root.querySelector("[data-subformat-trigger]").dataset.subformatChange === "added",
            "New definitions use green",
        );
        root = createRoot(true, true);
        registration = openAdd();
        assert(registration, "The first subformat can be added from an empty workspace");
        registration.querySelector("[data-cancel]").click();
        root = createRoot();
        const openAction = (ext, action) => {
            root.querySelector("[data-subformat-trigger]").click();
            root.querySelector(
                `[data-subformat-action="${action}"][aria-label$=": ${ext}"]`,
            ).click();
        };
        opened = undefined;
        const picker = root.querySelector("[data-subformat-trigger]");
        picker.click();
        assert(
            [...root.querySelectorAll("[data-subformat-action]")].every(
                (control) =>
                    control.querySelector('svg[aria-hidden="true"]') &&
                    !control.textContent.trim() &&
                    control.title === control.getAttribute("aria-label"),
            ),
            "Subformat actions use icons with accessible names and tooltips",
        );
        document.activeElement.dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
        );
        assert(
            document.activeElement.dataset.subformatAction === "edit",
            "Keyboard navigation reaches the edit action",
        );
        root.querySelector("[data-subformat-options]").hidePopover();
        openAction("note", "edit");
        assert(opened === "note.schema.json", "Edit opens the chosen subformat's schema");
        assert(
            root.querySelector("[data-resource-filter]").value === "issue",
            "Editing another subformat preserves the selection",
        );
        openAction("issue", "delete");
        const confirmation = document.querySelector("dialog[open]");
        assert(
            confirmation.textContent.includes("Records and schema files will be kept"),
            "Deletion explains which files are kept",
        );
        confirmation.close("");
        await wait(() => !confirmation.isConnected);
        assert(
            deletions.length === 0 && card(),
            "Cancelling deletion preserves the collection without a request",
        );
        assert(document.activeElement === picker, "Cancelling deletion restores picker focus");
        failDelete = true;
        openAction("issue", "delete");
        document.querySelector("dialog[open]").close("confirm");
        await wait(() => document.querySelector(".subformat-toast"));
        assert(
            root.querySelector('[data-resource-filter] option[value="issue"]') && card(),
            "Failed deletion preserves the collection",
        );
        document.querySelector(".subformat-toast").remove();
        failDelete = false;
        openAction("issue", "delete");
        document.querySelector("dialog[open]").close("confirm");
        await wait(() => !root.querySelector('[data-resource-filter] option[value="issue"]'));
        assert(
            card().dataset.recordFile === "note.note",
            "Deleting the selected subformat selects the remaining collection",
        );
        assert(
            deletions.at(-1).base.schema === collection.schema,
            "Deletion includes the loaded definition for conflict checks",
        );
        openAction("note", "delete");
        document.querySelector("dialog[open]").close("confirm");
        await wait(() => root.querySelector("[data-subformat-board]").hidden);
        assert(
            !host.querySelector("[data-subformat-register]"),
            "Deleting the last subformat does not open registration automatically",
        );
        registration = openAdd();
        assert(registration, "A subformat can be added after deleting the last one");
        registration.querySelector("[data-cancel]").click();
        document.body.classList.remove("edit");
        root = createRoot(false);
        assert(
            !root.querySelector("[data-subformat-create]"),
            "Read-only boards do not offer Create",
        );
        assert(
            !root.querySelector("[data-subformat-add]"),
            "Read-only boards do not offer Add subformat",
        );
        assert(
            !root.querySelector("[data-subformat-action]"),
            "Read-only boards do not offer Edit or Delete",
        );
        assert(
            !card().draggable && !card().querySelector("select:not(:disabled)"),
            "Read-only cards cannot move",
        );
        title().click();
        assert(
            title().getAttribute("aria-haspopup") === "dialog",
            "Read-only cards announce a dialog",
        );
        const dialog = document.querySelector("dialog[open]");
        assert(
            dialog?.textContent.includes('"owner": "Sample"'),
            "Read-only details include nested fields",
        );
        assert(!dialog.querySelector("b"), "Dialog markup is escaped");
        assert(dialog.querySelectorAll("button").length === 1, "Details only offer a close action");
        dialog.close();
        await wait(() => !dialog.isConnected);
        assert(document.activeElement === title(), "Closing restores card focus");
        assert(
            !root.querySelector("button.subformat-default"),
            "Published boards cannot change defaults",
        );
        const savesBefore = layouts.length;
        await chooseTitle("due");
        assert(
            title().textContent === "2026-11-12",
            "Published boards allow temporary title changes",
        );
        assert(layouts.length === savesBefore, "Published boards do not write settings");
        const configuredLayouts = collection.layouts;
        delete collection.layouts;
        collection.records[0].data.name = "Legacy name";
        root = createRoot(false);
        assert(
            title().textContent === "card.issue",
            "Title and name fields have no implicit priority",
        );
        collection.layouts = configuredLayouts;
        delete collection.records[0].data.name;
        return "Passed: transparent cards, subformat edit/delete/confirmation/conflicts/last deletion/read-only actions, collapse, state restoration, click/keyboard editing, escaping, focus, whole-card dragging, same-column drop, drag preview/cancel, temporary error toast without layout shift, save failure/retry, read-only details";
    } finally {
        document.removeEventListener("docs:subformat-add", openRegistration);
        document.removeEventListener("docs:subformat-create", openRegistration);
        host.remove();
        document.querySelector(".subformat-toast")?.remove();
        document.body.classList.toggle("edit", wasEditable);
        window.fetch = originalFetch;
        if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
        else delete navigator.clipboard;
        if (sourceBase === undefined) delete document.body.dataset.sourceBase;
        else document.body.dataset.sourceBase = sourceBase;
    }
};
