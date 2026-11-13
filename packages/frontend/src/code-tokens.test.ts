import { afterEach, expect, it, vi } from "vitest";
import { loadCodeGrammars } from "../../engine/src/compiler/code-languages.js";
import { selectCodeGrammars } from "../../engine/src/core/code-grammars.js";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

it("loads only required scopes, preserving custom includes, embedded languages and cycles", async () => {
    const all = await loadCodeGrammars(["termth", "python"]);
    const grammar = all.find((entry) => entry.name === "termth");
    if (!grammar) throw new Error("Missing grammar");
    expect(selectCodeGrammars(all, [grammar.name]).map((entry) => entry.name)).toEqual([
        "termth",
        "yaml",
    ]);
    const a = {
        name: "a",
        scopeName: "source.a",
        embeddedLangs: ["b"],
        patterns: [],
        repository: {},
    };
    const b = {
        name: "b",
        scopeName: "source.b",
        patterns: [{ include: "source.a#rule" }],
        repository: {},
    };
    expect(selectCodeGrammars([a, b, ...all], ["a", "b", "unknown"])).toEqual([a, b]);
});

it("fetches grammars on demand, retries failures, and shares successful loading", async () => {
    const all = await loadCodeGrammars(["json", "termth"]);
    vi.stubGlobal("document", {
        getElementById: () => ({
            dataset: { src: "/assets/code-grammars.json" },
            textContent: "[]",
        }),
    });
    vi.stubGlobal("location", { href: "http://localhost/guide" });
    const fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response("error", { status: 503 }))
        .mockImplementation(async (url: URL) =>
            Response.json(selectCodeGrammars(all, [url.searchParams.get("language") ?? ""])),
        );
    vi.stubGlobal("fetch", fetch);
    const { codeTokens } = await import("./code-tokens.js");
    expect(fetch).not.toHaveBeenCalled();
    await expect(codeTokens("{}", "json", "github-light")).rejects.toThrow(
        "Could not load code languages",
    );
    const [json, yaml] = await Promise.all([
        codeTokens('{"name": "example"}', "json", "github-light"),
        codeTokens("name: example", "termth", "github-dark"),
        codeTokens("[]", "json", "github-dark"),
    ]);
    expect(json.flat().some((token) => token.color)).toBe(true);
    expect(yaml.flat().some((token) => token.color)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.map(([url]) => url.searchParams.get("language"))).toEqual([
        "json",
        "json",
        "termth",
    ]);
    await codeTokens("{}", "json", "github-light");
    await codeTokens("name: example", "yaml", "github-light");
    expect(fetch).toHaveBeenCalledTimes(3);
    await codeTokens("plain", "unknown", "github-light");
    await codeTokens("plain", "unknown", "github-light");
    expect(fetch).toHaveBeenCalledTimes(4);
});

it("correlates worker results and leaves all callers able to recover from worker failures", async () => {
    const all = await loadCodeGrammars(["json"]);
    vi.stubGlobal("document", {
        getElementById: () => ({
            dataset: { src: "/assets/code-grammars.json" },
            textContent: "[]",
        }),
    });
    vi.stubGlobal("location", { href: "http://localhost/guide" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(all)));
    const postMessage = vi.fn();
    const terminate = vi.fn();
    let worker: { onmessage?: (event: { data: unknown }) => void; onerror?: () => void } = {};
    vi.stubGlobal(
        "Worker",
        class {
            constructor() {
                worker = this;
            }
            onmessage = undefined;
            onerror = undefined;
            postMessage = postMessage;
            terminate = terminate;
        },
    );
    const { codeTokens } = await import("./code-tokens.js");
    const first = codeTokens("{}", "json", "github-light");
    const second = codeTokens("[]", "json", "github-dark");
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
    const a = postMessage.mock.calls[0]?.[0];
    const b = postMessage.mock.calls[1]?.[0];
    worker.onmessage?.({ data: { id: b.id, tokens: [[{ content: "[]" }]] } });
    worker.onmessage?.({ data: { id: a.id, tokens: [[{ content: "{}" }]] } });
    expect(await first).toEqual([[{ content: "{}" }]]);
    expect(await second).toEqual([[{ content: "[]" }]]);
    const failed = expect(codeTokens("{}", "json", "github-light")).rejects.toThrow(
        "Could not highlight code",
    );
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(3));
    worker.onerror?.();
    await failed;
    expect(terminate).toHaveBeenCalledOnce();
    await expect(codeTokens("{}", "json", "github-light")).rejects.toThrow(
        "Could not highlight code",
    );
});

it("keeps grammar loading and aliases separate when the active workspace changes mid-request", async () => {
    const all = await loadCodeGrammars(["json"]);
    vi.stubGlobal("document", {
        getElementById: () => ({
            dataset: { src: "/assets/code-grammars.json" },
            textContent: "[]",
        }),
    });
    vi.stubGlobal("location", { href: "http://localhost/guide" });
    let complete!: (response: Response) => void;
    const first = vi.fn(
        () =>
            new Promise<Response>((resolve) => {
                complete = resolve;
            }),
    );
    const second = vi.fn(async () =>
        Response.json(all.map((grammar) => ({ ...grammar, aliases: ["from-b"] }))),
    );
    vi.stubGlobal("__doocConnections", {
        active: "a",
        items: new Map([
            ["a", { fetch: first }],
            ["b", { fetch: second }],
        ]),
    });
    const { codeTokens, codeGrammar } = await import("./code-tokens.js");
    const pending = codeTokens("{}", "json", "github-light");
    if (globalThis.__doocConnections) globalThis.__doocConnections.active = "b";
    await codeTokens("[]", "json", "github-light");
    complete(Response.json(all.map((grammar) => ({ ...grammar, aliases: ["from-a"] }))));
    await pending;
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(codeGrammar("from-a", "a")?.name).toBe("json");
    expect(codeGrammar("from-a", "b")).toBeUndefined();
    expect(codeGrammar("from-b", "b")?.name).toBe("json");
});
