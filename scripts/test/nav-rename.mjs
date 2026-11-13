// Run testNavRename() on a disposable edit project; the original title is restored on success.
window.testNavRename = async () => {
    const assert = (condition, message) => {
        if (!condition) throw new Error(message);
    };
    const wait = async (test) => {
        for (let attempt = 0; attempt < 200; attempt++) {
            if (test()) return;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(`Timed out: ${test.toString()}`);
    };
    const row = document.querySelector("#nav-groups a.cur").closest(".nav-row");
    const item = row.closest("[data-doc-id]");
    const size = row.querySelector(".new").getBoundingClientRect();
    const wasOpen = item.classList.contains("open");
    const begin = async () => {
        await window.__docsDocAction(item.dataset.docId, "rename");
        await wait(() => row.querySelector(".nav-rename-form"));
        return row.querySelector(".nav-rename-form");
    };
    let form = await begin();
    const originalTitle = form.elements.title.value;
    const originalName = form.elements.name.value;
    const buttons = [...row.querySelectorAll(":scope > button")].filter(
        (button) => getComputedStyle(button).display !== "none",
    );
    assert(
        buttons.length === 2 &&
            buttons[0].className === "nav-rename-cancel" &&
            buttons[1].className === "nav-rename-save",
        "Only Cancel and Save are visible while editing",
    );
    for (const button of buttons) {
        const rect = button.getBoundingClientRect();
        assert(
            rect.width === size.width && rect.height === size.height,
            "Editing controls match the original action size",
        );
    }
    form.elements.title.value = "Discard this title";
    buttons[0].focus();
    assert(form.isConnected, "Moving focus to Cancel keeps the form open");
    buttons[0].click();
    assert(
        !form.isConnected && item.classList.contains("open") === wasOpen,
        "Cancel restores the row without changing expansion",
    );
    await wait(() => !row.classList.contains("renaming"));
    form = await begin();
    assert(form.elements.title.value === originalTitle, "Cancel discards the draft title");
    const submit = row.querySelector(".nav-rename-save");
    form.elements.name.value = "invalid.txt";
    submit.focus();
    submit.click();
    assert(
        form.isConnected && form.elements.name.validity.customError,
        "Save validates the filename without losing the form",
    );
    form.elements.name.value = originalName;
    form.elements.name.dispatchEvent(new Event("input"));
    form.elements.title.value = `${originalTitle} saved`;
    const originalFetch = window.fetch;
    let release;
    let fail = true;
    let requests = 0;
    window.fetch = async (url, options) => {
        if (new URL(url, location.href).pathname === "/api/save" && fail) {
            requests++;
            await new Promise((resolve) => {
                release = resolve;
            });
            return Response.json({ error: "Test save failure" }, { status: 500 });
        }
        return originalFetch(url, options);
    };
    try {
        submit.focus();
        submit.click();
        await wait(() => release);
        assert(
            submit.disabled && row.querySelector(".nav-rename-cancel").disabled,
            "Both actions are disabled while saving",
        );
        submit.click();
        assert(requests === 1, "Repeated clicks do not submit twice");
        release();
        await wait(() => !submit.disabled);
        assert(
            form.isConnected && form.elements.title.value === `${originalTitle} saved`,
            "Failure retains the draft for retry",
        );
        fail = false;
        submit.focus();
        submit.click();
        await wait(() => !form.isConnected);
        form = await begin();
        assert(
            form.elements.title.value === `${originalTitle} saved`,
            "The Save button commits the title",
        );
        form.elements.title.value = originalTitle;
        form.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
        await wait(() => !form.isConnected);
        assert(
            getComputedStyle(row.querySelector(".new")).display !== "none",
            "Normal actions return after saving",
        );
        return "Passed: action layout, Cancel, focus, validation, pending state, failure, retry and Enter";
    } finally {
        window.fetch = originalFetch;
    }
};
