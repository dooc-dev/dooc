import {
    deferredFigureHtml,
    mountFigurePreviews,
} from "../../packages/frontend/src/figure-preview.ts";
import { mountPlugins } from "../../packages/frontend/src/plugins-ui.ts";

// Bundle with esbuild and run testViewLoading() in a browser on a local HTTP origin.
window.testViewLoading = async () => {
    const assert = (value, message) => {
        if (!value) throw new Error(message);
    };
    const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
    const wait = async (test) => {
        for (let i = 0; i < 60; i++) {
            if (test()) return;
            await pause();
        }
        throw new Error(`Timed out: ${test}`);
    };
    document.body.innerHTML =
        '<main style="height:400px;overflow:auto"><div id="first" data-embed-url="https://example.com/1">First</div><div style="height:2000px"></div><div id="last" data-embed-url="https://example.com/2">Last</div></main>';
    const calls = [];
    let release;
    const connect = mountPlugins(true);
    connect(async (input) => {
        calls.push(input);
        if (input.action === "resolve") return { plugin: "example", connected: true };
        if (input.action === "read") {
            await new Promise((resolve) => {
                release = resolve;
            });
            return { view: { blocks: [{ type: "text", text: "Loaded" }] }, user: { name: "Test" } };
        }
        if (input.action === "actions") return { actions: [] };
        throw new Error(`Unexpected ${input.action}`);
    });
    await wait(() => release);
    assert(
        calls.filter((call) => call.action === "resolve").length === 1,
        "Offscreen plugin was resolved eagerly",
    );
    assert(
        document.querySelector('#first [aria-busy="true"]'),
        "Slow plugin lacks a local loading state",
    );
    document.querySelector("#first").remove();
    release();
    await pause();
    assert(
        !document.querySelector("[data-plugin]"),
        "Removed plugin was restored by a late result",
    );
    release = undefined;
    document.querySelector("#last").scrollIntoView();
    await wait(() => release);
    release();
    await wait(() => document.querySelector('[data-ready="true"]'));
    assert(
        calls.filter((call) => call.action === "resolve").length === 2,
        "Scrolled plugin was not loaded",
    );
    connect(null);
    const figure = { name: "large", file: "large.svg", kind: "svg", markup: "x".repeat(100_001) };
    document.querySelector("main").innerHTML =
        `<div style="height:2000px"></div>${deferredFigureHtml(figure)}`;
    document.querySelector("main").dataset.workspace = "preview-workspace";
    document.querySelector("main").scrollTop = 0;
    const originalFetch = window.fetch;
    let requests = 0;
    window.fetch = async (_url, _init, workspace) => {
        assert(workspace === "preview-workspace", "Preview used the wrong workspace");
        requests++;
        if (requests === 1) return new Response("unavailable", { status: 503 });
        await new Promise((resolve) => {
            release = resolve;
        });
        return new Response('<iframe title="Large preview" sandbox="" srcdoc="Preview"></iframe>');
    };
    try {
        mountFigurePreviews();
        const button = document.querySelector("[data-figure-preview] > button");
        assert(button.hidden, "A healthy preview must not require a load button");
        await pause();
        assert(requests === 0, "Offscreen preview fetched eagerly");
        button.parentElement.scrollIntoView();
        await wait(() => !button.hidden);
        await pause();
        assert(requests === 1, "A failed preview must not retry in a loop");
        assert(!button.disabled, "Failed preview cannot be retried");
        assert(document.querySelector('[role="status"]').textContent, "Missing preview error");
        button.focus();
        button.click();
        await pause();
        assert(button.disabled, "Loading button is not disabled");
        assert(document.querySelector('[aria-busy="true"]'), "Missing loading state");
        release();
        await wait(() => document.querySelector("iframe"));
        assert(
            !document.querySelector("[data-figure-preview]"),
            "Placeholder survived successful loading",
        );
        assert(
            document.activeElement?.contains(document.querySelector("iframe")),
            "Keyboard focus left the loaded preview",
        );
        release = undefined;
        document.querySelector("main").innerHTML = deferredFigureHtml(figure);
        await wait(() => release);
        assert(
            document.querySelector("button").hidden,
            "Inserted previews must load automatically",
        );
        assert(
            document.querySelector('[aria-busy="true"]'),
            "Inserted preview lacks loading state",
        );
        document.querySelector("main").innerHTML = "Next page";
        release();
        await pause();
        assert(
            document.querySelector("main").textContent === "Next page",
            "Late preview replaced the next page",
        );
    } finally {
        window.fetch = originalFetch;
    }
    return {
        pluginRequests: calls.length,
        previewRequests: requests,
        checks: "automatic visible loading, workspace ownership, slow response, removal, retry, navigation",
    };
};
